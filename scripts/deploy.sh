#!/bin/bash
# Script de déploiement NovaTech HRFlow
# Théo Marchand — octobre 2021
# "Si ça marche pas, appelle-moi"
#
# USAGE: bash deploy.sh [prod|staging]
# ATTENTION: deploy sur prod sans confirmation !!!

set -e

ENV=${1:-prod}

echo "🚀 Déploiement vers $ENV..."

# Pas de vérification de l'environnement — peut deploy en prod par erreur
SSH_HOST="185.xxx.xxx.xxx" # IP prod hardcodée
SSH_USER="deploy"
SSH_PASS="[SECRET-REVOQUE]" # mot de passe SSH en clair dans le script !!!

# sshpass utilisé car pas de clé SSH configurée
sshpass -p "$SSH_PASS" ssh -o StrictHostKeyChecking=no $SSH_USER@$SSH_HOST << 'REMOTE'
  cd /var/www/hrflow
  git pull origin main  # toujours depuis main, même pour staging

  # Pas de backup avant migration
  npm install --production

  # Redémarrage de tous les services d'un coup — downtime garanti
  pm2 restart all

  echo "Done at $(date)"
REMOTE

echo "✅ Déployé ! (espérons que ça marche)"
