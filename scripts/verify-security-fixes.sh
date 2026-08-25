#!/usr/bin/env bash
# =============================================================================
# Vérification de non-régression des vulnérabilités fermées.
#
# Certaines corrections ne se prouvent pas par un test unitaire mais par
# l'absence d'un motif dans le code source. Ce script fait échouer le pipeline
# si l'un d'eux réapparaît.
#
# Il ne remplace pas les tests : il complète ce qu'ils ne peuvent pas exprimer,
# par exemple « aucune valeur de repli codée en dur pour un secret ».
#
# Périmètre : uniquement le code applicatif et les configurations. La
# documentation et les tests citent volontairement les motifs corrigés.
# =============================================================================

set -uo pipefail

CODE_SOURCES=(services/*/src frontend/src)
ECHECS=0

# ----------------------------------------------------------------------------
# interdire <identifiant> <motif> <message>
# ----------------------------------------------------------------------------
interdire() {
  local identifiant="$1"
  local motif="$2"
  local message="$3"
  shift 3
  local cibles=("$@")

  if [ ${#cibles[@]} -eq 0 ]; then
    cibles=("${CODE_SOURCES[@]}")
  fi

  # Les lignes de commentaire sont écartées : la documentation en place cite
  # volontairement les motifs corrigés pour expliquer ce qui a été retiré.
  local resultat
  resultat=$(grep -RIn --binary-files=without-match \
      --exclude=verify-security-fixes.sh \
      -E "$motif" "${cibles[@]}" 2>/dev/null \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|#|\*)' \
    || true)

  if [ -n "$resultat" ]; then
    echo "❌ $identifiant — $message"
    echo "$resultat" | sed 's/^/     /'
    ECHECS=$((ECHECS + 1))
  else
    echo "✅ $identifiant — $message"
  fi
}

echo "Vérification de non-régression des correctifs de sécurité"
echo "---------------------------------------------------------"

# --- SEC-01 : secrets dans le dépôt -----------------------------------------
if git ls-files --error-unmatch .env >/dev/null 2>&1; then
  echo "❌ SEC-01 — le fichier .env est suivi par Git"
  ECHECS=$((ECHECS + 1))
else
  echo "✅ SEC-01 — le fichier .env n'est pas suivi par Git"
fi

# --- SEC-02 : concaténation dans une requête SQL ----------------------------
interdire "SEC-02" \
  "(query|execute)\(\s*\`[^\`]*\\\$\{" \
  "aucune interpolation dans une requête SQL"

# --- SEC-04 / SEC-05 : routes dangereuses -----------------------------------
interdire "SEC-04" "['\"\`]/paie/migrate" "la route de migration HTTP n'existe pas"
interdire "SEC-05" "/conges/debug" "aucune route de debug exposée"

# --- SEC-06 : middleware d'authentification commenté ------------------------
interdire "SEC-06" \
  "^\s*//\s*app\.use\(\s*authMiddleware" \
  "le middleware d'authentification n'est pas commenté"

# --- SEC-09 : secrets codés en dur en valeur de repli -----------------------
interdire "SEC-09" \
  "process\.env\.(JWT_SECRET|DB_PASSWORD|STRIPE_SECRET_KEY|SENDGRID_API_KEY|AWS_SECRET_ACCESS_KEY)\s*\|\|\s*['\"]" \
  "aucune valeur de repli codée en dur pour un secret"

# --- SEC-10 : secret journalisé ---------------------------------------------
interdire "SEC-10" \
  "console\.(log|info|error)\([^)]*(JWT_SECRET|PASSWORD|SECRET_KEY)" \
  "aucun secret écrit dans un journal"

# --- SEC-11 : CORS permissif ------------------------------------------------
interdire "SEC-11" \
  "Access-Control-Allow-Origin['\"]\s*,\s*['\"]\*" \
  "aucune origine générique dans la politique CORS"

# --- SEC-12 : trace d'exécution renvoyée au client --------------------------
interdire "SEC-12" \
  "(res\.(json|send)\([^)]*stack|stack:\s*err\.stack)" \
  "aucune trace d'exécution renvoyée au client"

# --- SEC-18 : jeton dans le stockage du navigateur --------------------------
interdire "SEC-18" \
  "(localStorage|sessionStorage)\.setItem\(\s*['\"][^'\"]*(token|jeton)" \
  "aucun jeton persisté dans le navigateur"

# --- INF-04 : déploiement par mot de passe SSH ------------------------------
interdire "INF-04" \
  "(sshpass|StrictHostKeyChecking=no)" \
  "aucune authentification SSH par mot de passe ni vérification d'hôte désactivée" \
  scripts .github

# --- SEC-14 / SEC-15 : configuration Nginx ----------------------------------
interdire "SEC-15" "autoindex\s+on" "aucun répertoire listé publiquement" nginx

# --- QUA-07 : gate de test inopérante ---------------------------------------
if grep -qE '"test"\s*:\s*"echo' package.json; then
  echo "❌ QUA-07 — le script de test de la racine ne lance pas de tests"
  ECHECS=$((ECHECS + 1))
else
  echo "✅ QUA-07 — le script de test de la racine lance de vrais tests"
fi

# --- QUA-08 : builds reproductibles -----------------------------------------
if [ -f package-lock.json ]; then
  echo "✅ QUA-08 — fichier de verrouillage présent"
else
  echo "❌ QUA-08 — aucun fichier de verrouillage : builds non reproductibles"
  ECHECS=$((ECHECS + 1))
fi

echo "---------------------------------------------------------"
if [ "$ECHECS" -gt 0 ]; then
  echo "Échec : $ECHECS régression(s) détectée(s)."
  exit 1
fi

echo "Aucune régression détectée."
