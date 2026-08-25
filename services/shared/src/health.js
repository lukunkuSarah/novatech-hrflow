'use strict'

const { asyncHandler } = require('./errors')

/**
 * Sondes de disponibilité et de vivacité.
 *
 * Corrige INF-01. L'ancienne sonde renvoyait systématiquement 200 sans rien
 * vérifier : toute supervision branchée dessus aurait été aveugle pendant les
 * 3 h 07 de l'incident P1. Une sonde qui ment est pire qu'une sonde absente,
 * parce qu'elle produit un faux sentiment de sécurité.
 *
 * Deux sondes distinctes, comme l'exige un déploiement sans interruption :
 *   - /health/live  : le processus répond-il ? (ne dépend de rien d'externe)
 *   - /health/ready : le service peut-il traiter du trafic ? (dépendances incluses)
 *
 * Confondre les deux fait redémarrer en boucle un service dont seule la base
 * est momentanément indisponible.
 */

const DEFAULT_TIMEOUT_MS = 2000

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Délai dépassé (${ms} ms) : ${label}`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * @param {object} options
 * @param {string} options.service                Nom du service.
 * @param {string} [options.version]              Version déployée (empreinte de commit).
 * @param {Array<{name: string, check: Function, critical?: boolean}>} [options.dependencies]
 */
function healthRouter({
  service,
  version = process.env.APP_VERSION || 'dev',
  dependencies = [],
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const express = require('express')
  const router = express.Router()
  const startedAt = Date.now()

  router.get('/health/live', (req, res) => {
    res.json({ status: 'alive', service, version, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) })
  })

  const readiness = asyncHandler(async (req, res) => {
    const results = await Promise.all(
      dependencies.map(async (dependency) => {
        const startedCheck = Date.now()
        try {
          await withTimeout(Promise.resolve(dependency.check()), timeoutMs, dependency.name)
          return { name: dependency.name, status: 'up', latencyMs: Date.now() - startedCheck }
        } catch (err) {
          return {
            name: dependency.name,
            status: 'down',
            latencyMs: Date.now() - startedCheck,
            error: err.message,
            critical: dependency.critical !== false
          }
        }
      })
    )

    const blocking = results.filter((r) => r.status === 'down' && r.critical !== false)
    const status = blocking.length === 0 ? 'ready' : 'unready'

    res.status(blocking.length === 0 ? 200 : 503).json({
      status,
      service,
      version,
      checkedAt: new Date().toISOString(),
      dependencies: results
    })
  })

  router.get('/health/ready', readiness)
  // Conservée pour compatibilité avec l'existant, mais elle vérifie désormais réellement.
  router.get('/health', readiness)

  return router
}

module.exports = { healthRouter, withTimeout }
