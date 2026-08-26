#!/usr/bin/env bash
# =============================================================================
# Demonstration : confinement du rayon d'action et retour arriere chronometre
#
# Le systeme audite redemarrait tous les services d'un coup (`pm2 restart all`)
# et n'avait aucune procedure de retour arriere : l'incident du 14 aout a dure
# 3 h 07 non pas a cause de la migration, mais parce que personne ne savait
# l'annuler.
#
# Ce script MESURE, il n'affirme pas. Un client synthetique interroge une route
# metier toutes les 200 ms pendant chaque operation, et les pertes sont
# comptees.
#
#   A. CONFINEMENT — pendant le remplacement du service PAIE, un client
#      interroge le service CONGES. Aucune requete ne doit etre perdue :
#      c'est ce que `pm2 restart all` rendait impossible.
#
#   B. RETOUR ARRIERE — chronometre. Objectif Partech : moins de dix minutes.
#
# CE QUE CE SCRIPT NE DEMONTRE PAS, et il faut le dire : le zero-downtime
# complet d'un service donne. Avec une seule instance, son remplacement le rend
# indisponible quelques secondes, quel que soit l'orchestrateur. Il en faut au
# moins deux derriere un repartiteur — c'est ce que decrit infra/terraform, et
# ce qu'impose la validation `replicas >= 2` de variables.tf.
#
# La sonde interroge une ROUTE METIER et non /health/ready : cette derniere
# renvoie 503 a juste titre pendant un remplacement, ce qui n'est pas une
# requete perdue mais une sonde qui fonctionne. Mesurer dessus donnerait un
# chiffre faux.
#
# USAGE : bash scripts/demo-zero-downtime.sh
# =============================================================================

set -uo pipefail

COMPOSE_FILE="docker/docker-compose.yml"
API="http://127.0.0.1:3000/api"
SANTE="http://127.0.0.1:3000/health/ready"
TOUS="auth paie conges recrutement api-gateway"

vert()  { printf '\033[32m%s\033[0m\n' "$1"; }
rouge() { printf '\033[31m%s\033[0m\n' "$1"; }
orange(){ printf '\033[33m%s\033[0m\n' "$1"; }
titre() { printf '\n\033[1m── %s ──────────────────────────────────────\033[0m\n' "$1"; }
note()  { printf '   \033[90m%s\033[0m\n' "$1"; }

compose() { VERSION="$1" docker compose -f "$COMPOSE_FILE" --env-file .env "${@:2}"; }

TRACE=$(mktemp)
CLIENT_PID=""
JETON=""

obtenir_jeton() {
  curl -s -m 5 -X POST "$API/auth/login" -H 'Content-Type: application/json' \
    -d '{"email":"mohamed.alrashid@mercure.example","password":"DemoHRFlow2024!"}' \
    | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).accessToken' 2>/dev/null
}

demarrer_client() {  # demarrer_client <url>
  : > "$TRACE"
  local url="$1"
  (
    while true; do
      curl -s -o /dev/null -m 3 -H "Authorization: Bearer $JETON" -w '%{http_code}\n' \
        "$url" 2>/dev/null >> "$TRACE" || echo 000 >> "$TRACE"
      sleep 0.2
    done
  ) &
  CLIENT_PID=$!
}

arreter_client() {
  if [ -n "$CLIENT_PID" ]; then kill "$CLIENT_PID" 2>/dev/null; wait "$CLIENT_PID" 2>/dev/null; CLIENT_PID=""; fi
}

bilan() {  # bilan <libelle> <strict|tolere>
  local total ok taux
  total=$(wc -l < "$TRACE" | tr -d ' ')
  ok=$(grep -c '^200$' "$TRACE" || true)
  PERTES=$((total - ok))
  taux=$(awk -v o="$ok" -v t="$total" 'BEGIN{if(t==0){print "0.00"}else{printf "%.2f", o*100/t}}')

  printf '   %s : %s requetes, %s reussies, %s perdues — disponibilite %s %%\n' \
    "$1" "$total" "$ok" "$PERTES" "$taux"

  if [ "$PERTES" -eq 0 ]; then
    vert "   ✔ aucune requete perdue"
  elif [ "$2" = "tolere" ]; then
    orange "   ~ $PERTES requete(s) perdue(s) — attendu, voir explication"
    note "codes rencontres : $(sort "$TRACE" | uniq -c | tr '\n' ' ')"
  else
    rouge "   ✘ $PERTES requete(s) perdue(s)"
    note "codes rencontres : $(sort "$TRACE" | uniq -c | tr '\n' ' ')"
  fi
}

version_en_service() {
  curl -s -m 3 "$SANTE" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).version' 2>/dev/null || echo "?"
}

trap 'arreter_client; rm -f "$TRACE"' EXIT

# =============================================================================
titre "0 · Preparation"
# =============================================================================
JETON=$(obtenir_jeton)
if [ -z "$JETON" ]; then
  rouge "   ✘ impossible d'obtenir un jeton — la pile est-elle demarree et le jeu de demonstration charge ?"
  exit 1
fi
vert "   ✔ jeton obtenu, valable quinze minutes"
note "version actuellement en service : $(version_en_service)"

if docker image inspect hrflow/api-gateway:demo-2 >/dev/null 2>&1; then
  vert "   images demo-2 deja presentes"
else
  note "construction d'une seconde version, pour que le retour arriere ait un sens"
  compose demo-2 build --build-arg APP_VERSION=demo-2 $TOUS >/dev/null 2>&1 \
    && vert "   images demo-2 construites" \
    || { rouge "   echec de construction"; exit 1; }
fi

# =============================================================================
titre "A · Confinement — remplacer la paie ne coupe pas les conges"
# =============================================================================
note "Le client interroge GET /api/conges/solde/12 en continu."
note "Pendant ce temps, le service PAIE est integralement remplace."

demarrer_client "$API/conges/solde/12"
sleep 2
SECONDS=0

printf '   remplacement de paie… '
if compose demo-2 up -d --no-deps --wait --wait-timeout 90 paie >/dev/null 2>&1; then
  printf '\033[32mtermine\033[0m\n'
else
  printf '\033[31mechec\033[0m\n'
fi

DUREE_PAIE=$SECONDS
sleep 1
arreter_client
note "duree du remplacement : ${DUREE_PAIE} s"
bilan "Service conges pendant le remplacement de paie" strict
PERTES_CONFINEMENT=$PERTES

note ""
note "C'est la difference concrete avec « pm2 restart all » : le rayon d'action"
note "d'un deploiement se limite au service deploye."

# =============================================================================
titre "B · Bascule complete des cinq services"
# =============================================================================
note "Un par un, avec attente de disponibilite entre chaque. Une bascule qui"
note "echoue laisse en place les services deja passes et ne touche pas la suite."

SECONDS=0
for s in $TOUS; do
  printf '   bascule de %-12s ' "$s"
  if compose demo-2 up -d --no-deps --wait --wait-timeout 90 "$s" >/dev/null 2>&1; then
    printf '\033[32mpret\033[0m\n'
  else
    printf '\033[31mechec — bascule interrompue\033[0m\n'
    break
  fi
done
DUREE_BASCULE=$SECONDS
note "duree totale : ${DUREE_BASCULE} s"
note "version desormais en service : $(version_en_service)"

# =============================================================================
titre "C · Retour arriere — objectif Partech : moins de dix minutes"
# =============================================================================
note "Les images 'dev' sont deja sur la machine : rien n'est telecharge, rien"
note "n'est reconstruit. C'est la raison d'etre des images immuables produites"
note "a l'etape 1 du pipeline (constat CIC-06)."

JETON=$(obtenir_jeton)
SECONDS=0
for s in $TOUS; do
  printf '   restauration de %-12s ' "$s"
  if compose dev up -d --no-deps --wait --wait-timeout 90 "$s" >/dev/null 2>&1; then
    printf '\033[32mpret\033[0m\n'
  else
    printf '\033[31mechec\033[0m\n'
  fi
done
DUREE_RETOUR=$SECONDS

APRES=$(version_en_service)
if [ "$APRES" = "dev" ]; then
  vert "   ✔ version restauree : $APRES"
else
  rouge "   ✘ version inattendue : $APRES"
fi

# =============================================================================
titre "D · Bilan"
# =============================================================================
printf '   %-48s %s\n' "Requetes perdues pendant le remplacement de paie" "$PERTES_CONFINEMENT"
printf '   %-48s %s\n' "Duree de bascule des cinq services"               "${DUREE_BASCULE} s"
printf '   %-48s %s\n' "Duree du retour arriere complet"                  "${DUREE_RETOUR} s"
printf '   %-48s %s\n' "Objectif Partech (retour arriere)"                "600 s"

if [ "$DUREE_RETOUR" -lt 600 ]; then
  vert "   ✔ objectif tenu — $(awk -v d="$DUREE_RETOUR" 'BEGIN{printf "%.0f", 600/d}') fois sous la cible"
else
  rouge "   ✘ objectif non tenu"
fi

printf '\n   \033[90m14 aout 2024 : 3 h 07 de coupure, retour arriere improvise, 1 h 17 de donnees perdues.\033[0m\n'
