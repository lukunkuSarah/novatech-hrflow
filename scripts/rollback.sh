#!/usr/bin/env bash
# =============================================================================
# Retour arrière HRFlow
#
# Ce fichier n'existait pas. L'incident P1 du 14 août 2024 a duré 3 h 07 non pas
# à cause de la migration, mais parce que personne ne savait comment revenir en
# arrière : « Théo tente un rollback manuel. Pas de procédure documentée. »
#
# Objectif Partech : retour arrière en moins de 10 minutes, testé et non
# seulement documenté. Mesure attendue de cette procédure : moins de 2 minutes.
#
# USAGE : rollback.sh <staging|production> [version]
#   Sans version, revient à la version précédente enregistrée sur le serveur.
# =============================================================================

set -euo pipefail

ENVIRONNEMENT="${1:-}"
VERSION_CIBLE="${2:-}"

if [[ "$ENVIRONNEMENT" != "staging" && "$ENVIRONNEMENT" != "production" ]]; then
  echo "USAGE : rollback.sh <staging|production> [version]" >&2
  exit 1
fi

if [[ -z "${HOTE:-}" ]]; then
  echo "Erreur : variable HOTE non définie." >&2
  exit 1
fi

REPERTOIRE_DISTANT="/opt/hrflow"
UTILISATEUR="deploy"
SERVICES=(api-gateway auth paie conges recrutement frontend)
DEBUT=$(date +%s)

ssh_distant() {
  ssh -o BatchMode=yes -o ConnectTimeout=10 "${UTILISATEUR}@${HOTE}" "$@"
}

# ----------------------------------------------------------------------------
# 1. Détermination de la version cible
# ----------------------------------------------------------------------------
if [[ -z "$VERSION_CIBLE" ]]; then
  VERSION_CIBLE=$(ssh_distant "cat ${REPERTOIRE_DISTANT}/.env.version.precedente 2>/dev/null || true")
fi

if [[ -z "$VERSION_CIBLE" ]]; then
  echo "Erreur : aucune version précédente connue. Précisez-la explicitement." >&2
  echo "Versions disponibles sur le serveur :" >&2
  ssh_distant "docker image ls --format '{{.Repository}}:{{.Tag}}' | grep hrflow | head -20" >&2
  exit 1
fi

echo "▶ Retour arrière de ${ENVIRONNEMENT} vers la version ${VERSION_CIBLE}"

# ----------------------------------------------------------------------------
# 2. Bascule immédiate vers les images précédentes
#
# Les images sont déjà présentes sur le serveur : aucun téléchargement, aucune
# reconstruction. C'est ce qui rend le retour arrière rapide — et c'est aussi
# pourquoi l'étape 1 du pipeline produit des images immuables (CIC-06).
# ----------------------------------------------------------------------------
for SERVICE in "${SERVICES[@]}"; do
  echo "▶ Restauration de ${SERVICE}"
  ssh_distant "cd ${REPERTOIRE_DISTANT} && VERSION=${VERSION_CIBLE} docker compose up -d --no-deps --wait --wait-timeout 60 ${SERVICE}"
done

# ----------------------------------------------------------------------------
# 3. Vérification
# ----------------------------------------------------------------------------
echo "▶ Vérification de l'état des services"
ssh_distant "cd ${REPERTOIRE_DISTANT} && curl -fsS http://localhost:3000/health/ready | head -c 400"
echo

ssh_distant "cd ${REPERTOIRE_DISTANT} && echo ${VERSION_CIBLE} > .env.version"

DUREE=$(( $(date +%s) - DEBUT ))
echo "✔ Retour arrière terminé en ${DUREE} s — version ${VERSION_CIBLE}"

# ----------------------------------------------------------------------------
# Note sur les migrations de schéma
#
# Ce script ramène le code, pas les données. Une migration destructive ne se
# rattrape pas par un retour arrière applicatif : c'est pourquoi les migrations
# sont conçues pour être compatibles avec la version précédente (ajout de
# colonne avant usage, suppression seulement au déploiement suivant), et
# pourquoi une sauvegarde est prise avant chaque déploiement de production.
# Procédure complète de restauration de données : docs/RUNBOOK.md
# ----------------------------------------------------------------------------
if [[ "$ENVIRONNEMENT" == "production" ]]; then
  echo "⚠ Si l'incident concerne les données et non le code, voir docs/RUNBOOK.md § restauration."
fi
