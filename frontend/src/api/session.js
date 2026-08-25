/**
 * Conservation du jeton d'accès.
 *
 * Corrige SEC-18. La version d'origine faisait :
 *   localStorage.setItem('hrflow_token', data.token)
 *
 * Tout script exécuté dans la page — y compris une dépendance compromise —
 * peut lire `localStorage`. Le jeton est donc conservé **en mémoire
 * uniquement** : il disparaît à la fermeture de l'onglet et n'est accessible
 * à aucun script tiers via l'API de stockage.
 *
 * Contrepartie assumée : un rechargement de page redemande une connexion.
 * La cible (voir docs/ADR-003) est un jeton de renouvellement placé dans un
 * cookie httpOnly, SameSite=Strict, posé par le service d'authentification :
 * elle supprime cette contrepartie sans réintroduire l'exposition au XSS.
 */

let accessToken = null
let profil = null

export function setSession({ token, user }) {
  accessToken = token || null
  profil = user || null
}

export function getToken() {
  return accessToken
}

export function getProfil() {
  return profil
}

export function clearSession() {
  accessToken = null
  profil = null
}

export function estConnecte() {
  return accessToken !== null
}
