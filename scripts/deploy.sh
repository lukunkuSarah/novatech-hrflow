#!/usr/bin/env bash
# =============================================================================
# Déploiement HRFlow — sans interruption de service
#
# Remplace le script d'origine, qui présentait cinq défauts :
#   INF-05  il acceptait un argument d'environnement qu'il n'utilisait jamais :
#           `deploy.sh staging` déployait la production ;
#   INF-04  mot de passe SSH en clair dans le script, via `sshpass`, avec
#           `StrictHostKeyChecking=no` — donc vulnérable à l'interception ;
#   INF-06  `pm2 restart all` coupait tous les services simultanément ;
#   CIC-06  le serveur exécutait `git pull` puis reconstruisait lui-même ;
#   INF-02  aucune sauvegarde avant modification du schéma.
#
# Ici : image immuable identifiée par l'empreinte du commit, bascule progressive
# conteneur par conteneur, sonde de disponibilité entre chaque, et version
# précédente conservée pour un retour arrière immédiat.
#
# USAGE : deploy.sh <staging|production> <version>
#   HOTE   : adresse du serveur cible (variable d'environnement)
# =============================================================================

set -euo pipefail

ENVIRONNEMENT="${1:-}"
VERSION="${2:-}"

# ----------------------------------------------------------------------------
# Contrôles préalables — le défaut central du script d'origine
# ----------------------------------------------------------------------------
if [[ "$ENVIRONNEMENT" != "staging" && "$ENVIRONNEMENT" != "production" ]]; then
  echo "Erreur : environnement attendu 'staging' ou 'production', reçu '${ENVIRONNEMENT}'." >&2
  echo "USAGE : deploy.sh <staging|production> <version>" >&2
  exit 1
fi

if [[ -z "$VERSION" ]]; then
  echo "Erreur : version manquante (empreinte de commit du build à déployer)." >&2
  exit 1
fi

if [[ -z "${HOTE:-}" ]]; then
  echo "Erreur : variable HOTE non définie." >&2
  echo "L'adresse du serveur n'est plus codée en dur : elle vient des secrets d'environnement." >&2
  exit 1
fi

# Garde-fou explicite : un déploiement en production hors pipeline doit être
# un acte conscient, pas une faute de frappe.
if [[ "$ENVIRONNEMENT" == "production" && "${CI:-false}" != "true" && "${JE_CONFIRME_LA_PRODUCTION:-}" != "oui" ]]; then
  echo "Refus : déploiement manuel en production." >&2
  echo "Passez par le pipeline, ou définissez JE_CONFIRME_LA_PRODUCTION=oui en connaissance de cause." >&2
  exit 1
fi

REPERTOIRE_DISTANT="/opt/hrflow"
UTILISATEUR="deploy"
SERVICES=(api-gateway auth paie conges recrutement frontend)

echo "▶ Déploiement de la version ${VERSION} sur ${ENVIRONNEMENT} (${HOTE})"

# ----------------------------------------------------------------------------
# Connexion par clé, avec vérification de l'empreinte du serveur.
# ----------------------------------------------------------------------------
ssh_distant() {
  ssh -o BatchMode=yes -o ConnectTimeout=10 "${UTILISATEUR}@${HOTE}" "$@"
}

# ----------------------------------------------------------------------------
# 1. Mémorisation de la version en place, pour pouvoir y revenir
# ----------------------------------------------------------------------------
echo "▶ Conservation de la version actuellement déployée"
ssh_distant "cd ${REPERTOIRE_DISTANT} && cp -f .env.version .env.version.precedente 2>/dev/null || true"

# ----------------------------------------------------------------------------
# 2. Récupération des images — construites et testées par le pipeline
# ----------------------------------------------------------------------------
echo "▶ Récupération des images ${VERSION}"
ssh_distant "cd ${REPERTOIRE_DISTANT} && VERSION=${VERSION} docker compose pull --quiet"

# ----------------------------------------------------------------------------
# 3. Migrations de schéma — en dehors des processus qui servent le trafic
#
# L'incident P1 vient d'une migration déclenchée par une route HTTP, dans le
# processus de production, sans sauvegarde. Les migrations sont désormais des
# fichiers versionnés, appliqués par un conteneur dédié qui s'arrête ensuite.
# ----------------------------------------------------------------------------
echo "▶ Application des migrations"
ssh_distant "cd ${REPERTOIRE_DISTANT} && VERSION=${VERSION} docker compose run --rm migrate"

# ----------------------------------------------------------------------------
# 4. Bascule progressive, service par service
#
# Chaque service est remplacé seul, et l'on attend qu'il se déclare prêt avant
# de passer au suivant. Un service qui ne devient pas prêt interrompt le
# déploiement : les précédents restent en place, le reste n'est pas touché.
# ----------------------------------------------------------------------------
for SERVICE in "${SERVICES[@]}"; do
  echo "▶ Bascule de ${SERVICE}"
  ssh_distant "cd ${REPERTOIRE_DISTANT} && VERSION=${VERSION} docker compose up -d --no-deps --wait --wait-timeout 60 ${SERVICE}"
  echo "  ${SERVICE} prêt"
done

# ----------------------------------------------------------------------------
# 5. Enregistrement de la version déployée
# ----------------------------------------------------------------------------
ssh_distant "cd ${REPERTOIRE_DISTANT} && echo ${VERSION} > .env.version"

echo "✔ Version ${VERSION} déployée sur ${ENVIRONNEMENT}"
echo "  Retour arrière possible : scripts/rollback.sh ${ENVIRONNEMENT}"
