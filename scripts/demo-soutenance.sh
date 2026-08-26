#!/usr/bin/env bash
# =============================================================================
# Démonstration de soutenance — parcours métier et contrôles de sécurité
#
# Exécuté sur la pile réellement déployée, pas sur des doublures. Chaque étape
# affiche la commande, puis la réponse du système.
#
# PRÉREQUIS
#   docker compose -f docker/docker-compose.yml --env-file .env up -d
#   docker compose ... exec -T postgres psql -U hrflow -d hrflow -f - < db/seed.sql
#
# USAGE : bash scripts/demo-soutenance.sh
# =============================================================================

set -uo pipefail

API="${API:-http://127.0.0.1:3000/api}"
MDP='DemoHRFlow2024!'

vert()  { printf '\033[32m%s\033[0m\n' "$1"; }
rouge() { printf '\033[31m%s\033[0m\n' "$1"; }
titre() { printf '\n\033[1m── %s ──────────────────────────────────────\033[0m\n' "$1"; }
note()  { printf '   \033[90m%s\033[0m\n' "$1"; }

attendu() {  # attendu <libellé> <code attendu> <code obtenu>
  if [ "$2" = "$3" ]; then vert "   ✔ $1 (HTTP $3)"; else rouge "   ✘ $1 — attendu $2, obtenu $3"; fi
}

code() { echo "$1" | tail -1; }
corps() { echo "$1" | sed '$d'; }

appel() {  # appel <méthode> <chemin> [jeton] [corps]
  local m="$1" chemin="$2" jeton="${3:-}" donnees="${4:-}"
  local args=(-s -w '\n%{http_code}' -X "$m" "$API$chemin")
  [ -n "$jeton" ] && args+=(-H "Authorization: Bearer $jeton")
  [ -n "$donnees" ] && args+=(-H 'Content-Type: application/json' -d "$donnees")
  curl "${args[@]}"
}
# =============================================================================
# Remise a zero des donnees produites par une execution precedente.
#
# Une demonstration doit pouvoir etre rejouee devant le jury sans que le
# resultat depende du nombre de fois qu'on l'a lancee.
# =============================================================================
COMPOSE="docker compose -f docker/docker-compose.yml --env-file .env"
if $COMPOSE ps postgres >/dev/null 2>&1; then
  $COMPOSE exec -T postgres psql -U hrflow -d hrflow -q >/dev/null 2>&1 <<'SQL'
DELETE FROM conges WHERE motif IN ('conges', 'doublon', 'dates inversees');
DELETE FROM bulletins_paie WHERE mois = 6 AND annee = 2026;
SQL
  note "donnees de demonstration reinitialisees"
fi


# =============================================================================
titre "1 · Connexion — le parcours nominal"
# =============================================================================
note "POST /api/auth/login — salarié Mohamed Al-Rashid, Atelier Mercure"

R=$(appel POST /auth/login "" "{\"email\":\"mohamed.alrashid@mercure.example\",\"password\":\"$MDP\"}")
attendu "connexion acceptée" 200 "$(code "$R")"

JETON_SALARIE=$(corps "$R" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).accessToken' 2>/dev/null)
EMPLOYE=$(corps "$R" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).user.employeeId' 2>/dev/null)
note "jeton d'accès obtenu, valable 15 minutes — salarié n° $EMPLOYE"

# =============================================================================
titre "2 · SEC-13 — aucune énumération de comptes possible"
# =============================================================================
note "Un compte inconnu et un mot de passe erroné doivent donner la MÊME réponse"

R1=$(appel POST /auth/login "" '{"email":"inconnu@mercure.example","password":"MotDePasseQuelconque1"}')
R2=$(appel POST /auth/login "" "{\"email\":\"mohamed.alrashid@mercure.example\",\"password\":\"MauvaisMotDePasse1\"}")

M1=$(corps "$R1" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).error.message' 2>/dev/null)
M2=$(corps "$R2" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).error.message' 2>/dev/null)

note "compte inconnu      → « $M1 »"
note "mot de passe erroné → « $M2 »"
if [ "$M1" = "$M2" ]; then vert "   ✔ messages strictement identiques"; else rouge "   ✘ les messages diffèrent — énumération possible"; fi

# =============================================================================
titre "3 · Consultation de son propre solde"
# =============================================================================
note "GET /api/conges/solde/$EMPLOYE"

R=$(appel GET "/conges/solde/$EMPLOYE" "$JETON_SALARIE")
attendu "solde consultable par son titulaire" 200 "$(code "$R")"
corps "$R" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);
console.log("     acquis :",j.joursAcquis," pris :",j.joursPris," en attente :",j.joursEnAttente);
console.log("     solde théorique :",j.soldeTheorique,"  solde DISPONIBLE :",j.soldeDisponible);})' 2>/dev/null
note "QUA-05 : le solde disponible déduit les demandes en attente — l'interface"
note "auditée n'affichait que le théorique, ce qui permettait de poser deux fois"
note "les mêmes jours."

# =============================================================================
titre "4 · SEC-08 — cloisonnement horizontal"
# =============================================================================
note "Le même salarié tente de consulter le solde d'un collègue (n° 11)"

R=$(appel GET "/conges/solde/11" "$JETON_SALARIE")
attendu "accès refusé aux données d'autrui" 403 "$(code "$R")"

# =============================================================================
titre "5 · SEC-08 — cloisonnement multi-locataire"
# =============================================================================
note "Connexion RH chez Groupe Lumen, puis tentative sur un salarié d'Atelier Mercure"

R=$(appel POST /auth/login "" "{\"email\":\"yuki.nakamura@lumen.example\",\"password\":\"$MDP\"}")
JETON_AUTRE=$(corps "$R" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).accessToken' 2>/dev/null)

R=$(appel GET "/conges/solde/$EMPLOYE" "$JETON_AUTRE")
attendu "salarié d'un autre client introuvable" 404 "$(code "$R")"
note "404 et non 403 : pour ce client, le salarié n'existe pas. Répondre 403"
note "confirmerait son existence."

# =============================================================================
titre "6 · QUA-05 — la fraude aux congés est fermée"
# =============================================================================
note "Demande avec des dates inversées : produisait un nombre de jours NÉGATIF,"
note "qui venait AUGMENTER le solde du salarié."

R=$(appel POST /conges/demande "$JETON_SALARIE" '{"dateDebut":"2026-06-14","dateFin":"2026-06-10","motif":"dates inversees"}')
attendu "dates inversées refusées" 400 "$(code "$R")"
corps "$R" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).error.message' 2>/dev/null | sed 's/^/     /'

note ""
note "Demande légitime, du lundi 8 au vendredi 12 juin 2026 :"
R=$(appel POST /conges/demande "$JETON_SALARIE" '{"dateDebut":"2026-06-08","dateFin":"2026-06-12","motif":"conges"}')
attendu "demande enregistrée" 201 "$(code "$R")"
corps "$R" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); "     "+j.nombre_jours+" jours ouvrés, statut : "+j.statut' 2>/dev/null

note ""
note "Même période, à nouveau : le chevauchement doit être détecté"
R=$(appel POST /conges/demande "$JETON_SALARIE" '{"dateDebut":"2026-06-08","dateFin":"2026-06-12","motif":"doublon"}')
attendu "chevauchement refusé" 409 "$(code "$R")"

# =============================================================================
titre "7 · SEC-04 et SEC-05 — les routes de l'incident ont disparu"
# =============================================================================
R=$(appel POST /paie/migrate "$JETON_SALARIE")
attendu "POST /paie/migrate — vecteur du 14 août" 404 "$(code "$R")"

R=$(appel GET /conges/debug/all "$JETON_SALARIE")
attendu "GET /conges/debug/all — fuite RGPD" 404 "$(code "$R")"

# =============================================================================
titre "8 · Autorisation par rôle"
# =============================================================================
note "Un salarié tente de déclencher un calcul de paie (réservé RH et admin)"

R=$(appel POST /paie/calculer "$JETON_SALARIE" "{\"employeeId\":\"$EMPLOYE\",\"mois\":6,\"annee\":2026}")
attendu "rôle insuffisant" 403 "$(code "$R")"

note ""
note "La RH d'Atelier Mercure émet le bulletin :"
R=$(appel POST /auth/login "" "{\"email\":\"camille.lefevre@mercure.example\",\"password\":\"$MDP\"}")
JETON_RH=$(corps "$R" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).accessToken' 2>/dev/null)

R=$(appel POST /paie/calculer "$JETON_RH" "{\"employeeId\":\"$EMPLOYE\",\"mois\":6,\"annee\":2026}")
CODE=$(code "$R")
if [ "$CODE" = "201" ] || [ "$CODE" = "502" ]; then
  vert "   ✔ bulletin émis (HTTP $CODE)"
  corps "$R" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);
  console.log("     brut :",j.brut,"€  cotisations :",j.cotisationsSalariales,"€  net :",j.net,"€");
  console.log("     statut du virement :",j.statut);
  console.log("     barème validé par un expert-comptable :",j.bareme.valide);})' 2>/dev/null
  note "502 attendu ici : la clé Stripe est factice. L'échec du virement est"
  note "PERSISTÉ et remonté, au lieu d'être avalé comme dans la version auditée."
else
  rouge "   ✘ code inattendu : $CODE"
fi

# =============================================================================
titre "9 · QUA-03 — idempotence : pas de double virement"
# =============================================================================
note "Même appel, même période — le bulletin ne doit pas être recalculé"

R=$(appel POST /paie/calculer "$JETON_RH" "{\"employeeId\":\"$EMPLOYE\",\"mois\":6,\"annee\":2026}")
attendu "réponse idempotente" 200 "$(code "$R")"
corps "$R" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); "     idempotent : "+j.idempotent+"  statut : "+j.statut' 2>/dev/null

# =============================================================================
titre "10 · Les quatre signaux d'or sont alimentés"
# =============================================================================
TOTAL=$(curl -s http://127.0.0.1:3000/metrics | grep -c '^hrflow_' || echo 0)
note "$TOTAL séries hrflow_* exposées par la passerelle"
curl -s http://127.0.0.1:3000/metrics | grep '^hrflow_requetes_total' | head -3 | sed 's/^/     /'

printf '\n\033[1mDémonstration terminée.\033[0m\n'
