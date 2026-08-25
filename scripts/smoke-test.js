#!/usr/bin/env node
'use strict'

/**
 * Tests de fumée post-déploiement.
 *
 * Exécutés par le pipeline juste après chaque déploiement, sur l'environnement
 * réellement déployé. Ils répondent à une question que les tests unitaires ne
 * posent pas : « ce qui vient d'être déployé fonctionne-t-il vraiment, ici ? »
 *
 * Ils vérifient aussi que les vulnérabilités fermées le sont bien en
 * conditions réelles : un endpoint de debug supprimé du code mais toujours
 * servi par un conteneur qui n'a pas basculé resterait exploitable.
 *
 * USAGE : BASE_URL=https://staging.hrflow.novatech.io node scripts/smoke-test.js
 */

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '')
const DELAI_MS = Number(process.env.SMOKE_TIMEOUT_MS || 10000)

let echecs = 0
let reussites = 0

async function appeler(chemin, options = {}) {
  const controleur = new AbortController()
  const minuteur = setTimeout(() => controleur.abort(), DELAI_MS)
  try {
    return await fetch(`${BASE_URL}${chemin}`, { ...options, signal: controleur.signal })
  } finally {
    clearTimeout(minuteur)
  }
}

async function verifier(intitule, execution) {
  try {
    await execution()
    console.log(`  ✔ ${intitule}`)
    reussites += 1
  } catch (err) {
    console.error(`  ✘ ${intitule}`)
    console.error(`      ${err.message}`)
    echecs += 1
  }
}

function attendre(condition, message) {
  if (!condition) throw new Error(message)
}

async function main() {
  console.log(`Tests de fumée — ${BASE_URL}`)
  console.log('─'.repeat(60))

  // --- Disponibilité -------------------------------------------------------
  await verifier('la passerelle est vivante', async () => {
    const reponse = await appeler('/health/live')
    attendre(reponse.status === 200, `statut ${reponse.status}`)
  })

  await verifier('tous les services en aval répondent', async () => {
    const reponse = await appeler('/health/ready')
    const corps = await reponse.json()
    attendre(
      reponse.status === 200,
      `statut ${reponse.status} — dépendances : ${JSON.stringify(corps.dependencies || [])}`
    )
    attendre(Array.isArray(corps.dependencies) && corps.dependencies.length === 4, 'sonde incomplète')
  })

  await verifier('la version déployée est bien celle attendue', async () => {
    const reponse = await appeler('/health/live')
    const corps = await reponse.json()
    attendre(Boolean(corps.version), 'version absente de la réponse')
    if (process.env.VERSION) {
      attendre(corps.version === process.env.VERSION, `version ${corps.version} au lieu de ${process.env.VERSION}`)
    }
  })

  // --- Vulnérabilités fermées, vérifiées en conditions réelles -------------
  await verifier("SEC-05 — /conges/debug/all n'est plus servi", async () => {
    const reponse = await appeler('/api/conges/debug/all')
    attendre(reponse.status === 401 || reponse.status === 404, `statut ${reponse.status}`)
    const texte = await reponse.text()
    attendre(!texte.includes('employee_id'), 'des données RH sont encore exposées')
  })

  await verifier("SEC-04 — /paie/migrate n'est plus servi", async () => {
    const reponse = await appeler('/api/paie/migrate', { method: 'POST' })
    attendre(reponse.status === 401 || reponse.status === 404, `statut ${reponse.status}`)
  })

  await verifier('SEC-06 — les routes métier exigent un jeton', async () => {
    const reponse = await appeler('/api/conges/solde/1')
    attendre(reponse.status === 401, `statut ${reponse.status} au lieu de 401`)
  })

  await verifier('SEC-12 — aucune trace d’exécution renvoyée', async () => {
    const reponse = await appeler('/api/paie/calculer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"corps":"invalide"'
    })
    const texte = await reponse.text()
    attendre(!texte.includes('at Object.'), "une trace d'exécution est exposée")
    attendre(!/node_modules/.test(texte), 'des chemins internes sont exposés')
  })

  await verifier('SEC-11 — aucune origine générique acceptée', async () => {
    const reponse = await appeler('/health/live', { headers: { Origin: 'https://exfiltration.example' } })
    const origine = reponse.headers.get('access-control-allow-origin')
    attendre(origine !== '*', 'Access-Control-Allow-Origin vaut *')
  })

  await verifier('SEC-17 — les en-têtes de sécurité sont posés', async () => {
    const reponse = await appeler('/health/live')
    attendre(reponse.headers.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options absent')
    attendre(reponse.headers.get('x-powered-by') === null, 'X-Powered-By exposé')
  })

  await verifier('QUA-14 — un identifiant de corrélation est renvoyé', async () => {
    const reponse = await appeler('/health/live')
    attendre(Boolean(reponse.headers.get('x-request-id')), 'X-Request-Id absent')
  })

  console.log('─'.repeat(60))
  console.log(`${reussites} vérification(s) réussie(s), ${echecs} échec(s)`)

  if (echecs > 0) {
    console.error('\nDéploiement considéré comme défaillant — retour arrière requis.')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(`Erreur inattendue pendant les tests de fumée : ${err.message}`)
  process.exit(1)
})
