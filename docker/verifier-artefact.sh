#!/bin/sh
# Verifie que l'artefact du frontend est bien present dans l'image.
# Sans ce controle, une image construite sans `npm run build` prealable sert
# une page blanche -- symptome muet, cause lointaine.
set -e

if [ ! -f /usr/share/nginx/html/index.html ]; then
  echo "ERREUR : frontend/dist/index.html est absent." >&2
  echo "Construisez le frontend avant l'image :" >&2
  echo "    npm run build" >&2
  exit 1
fi

if [ -z "$(ls -A /usr/share/nginx/html/assets 2>/dev/null)" ]; then
  echo "ERREUR : aucun fichier dans dist/assets -- artefact incomplet." >&2
  exit 1
fi

echo "Artefact du frontend verifie."
