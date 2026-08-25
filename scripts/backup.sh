#!/usr/bin/env bash
# =============================================================================
# Sauvegarde de la base HRFlow
#
# Lors de l'incident P1, la sauvegarde la plus récente datait de 1 h 17 avant la
# panne, et aucune restauration n'avait jamais été testée depuis la création du
# système (INF-02). 1 h 17 de données de paie et de congés ont été perdues.
#
# Deux usages :
#   - appelé par le pipeline avant tout déploiement de production ;
#   - appelé toutes les heures par une tâche planifiée (voir docs/RUNBOOK.md).
#
# USAGE : backup.sh <staging|production> [etiquette]
# =============================================================================

set -euo pipefail

ENVIRONNEMENT="${1:-}"
ETIQUETTE="${2:-auto}"

if [[ "$ENVIRONNEMENT" != "staging" && "$ENVIRONNEMENT" != "production" ]]; then
  echo "USAGE : backup.sh <staging|production> [etiquette]" >&2
  exit 1
fi

if [[ -z "${HOTE:-}" ]]; then
  echo "Erreur : variable HOTE non définie." >&2
  exit 1
fi

UTILISATEUR="deploy"
REPERTOIRE_DISTANT="/opt/hrflow"
HORODATAGE=$(date -u +%Y%m%dT%H%M%SZ)
NOM="hrflow-${ENVIRONNEMENT}-${ETIQUETTE}-${HORODATAGE}.dump"

ssh_distant() {
  ssh -o BatchMode=yes -o ConnectTimeout=10 "${UTILISATEUR}@${HOTE}" "$@"
}

echo "▶ Sauvegarde de ${ENVIRONNEMENT} → ${NOM}"

# Format personnalisé et compressé : restauration sélective possible table par
# table, ce qu'un export SQL brut ne permet pas simplement.
ssh_distant "cd ${REPERTOIRE_DISTANT} && docker compose exec -T postgres \
  pg_dump --format=custom --compress=9 --no-owner --dbname=\"\$POSTGRES_DB\" --username=\"\$POSTGRES_USER\" \
  > /var/backups/hrflow/${NOM}"

# Vérification d'intégrité immédiate : une sauvegarde jamais vérifiée est une
# sauvegarde dont on ignore la valeur.
echo "▶ Vérification de l'archive"
ssh_distant "pg_restore --list /var/backups/hrflow/${NOM} > /dev/null && echo '  archive lisible'"

TAILLE=$(ssh_distant "stat -c %s /var/backups/hrflow/${NOM}")
if [[ "$TAILLE" -lt 1024 ]]; then
  echo "Erreur : archive suspecte (${TAILLE} octets)." >&2
  exit 1
fi

# Copie hors machine : une sauvegarde stockée sur le serveur sauvegardé ne
# protège d'aucune panne matérielle.
echo "▶ Copie vers le stockage objet"
ssh_distant "aws s3 cp /var/backups/hrflow/${NOM} s3://\${BACKUP_BUCKET}/${ENVIRONNEMENT}/ --only-show-errors"

# Rétention locale : 48 heures de sauvegardes horaires.
ssh_distant "find /var/backups/hrflow -name 'hrflow-${ENVIRONNEMENT}-*' -mtime +2 -delete"

echo "✔ Sauvegarde terminée : ${NOM} (${TAILLE} octets)"
