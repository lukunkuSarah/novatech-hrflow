'use strict'

const { loadConfig, redact } = require('./config')
const { createLogger } = require('./logger')
const { installProcessGuards } = require('./errors')
const { createPool } = require('./db')
const { createMetrics } = require('./metriques')
const { createFeatureFlags } = require('./drapeaux')

/**
 * Démarrage normalisé d'un service.
 *
 * Chaque service audité gérait son démarrage à sa façon : l'un journalisait le
 * `JWT_SECRET`, un autre acceptait des identifiants de repli, aucun ne savait
 * s'arrêter proprement. Un point de démarrage unique impose les mêmes
 * garanties partout :
 *
 *   1. configuration validée, sinon refus de démarrer (SEC-09) ;
 *   2. configuration journalisée expurgée (SEC-10) ;
 *   3. filets de sécurité au niveau du processus (QUA-01) ;
 *   4. arrêt progressif, condition du déploiement sans interruption (INF-06).
 */
function startService({ name, required = [], optional = {}, build, withDatabase = true, gracePeriodMs = 10000 }) {
  const logger = createLogger({ service: name })

  const config = loadConfig({
    required: withDatabase ? [...new Set([...required, 'DATABASE_URL'])] : required,
    optional: { APP_VERSION: 'dev', ALLOWED_ORIGINS: 'http://localhost:5173', ...optional }
  })

  installProcessGuards(logger)

  const pool = withDatabase ? createPool({ connectionString: config.DATABASE_URL, ssl: config.isProduction }) : null

  const metrics = createMetrics({ name: name, service: name, version: config.APP_VERSION })

  const drapeaux = createFeatureFlags({ logger })

  const app = build({ config, logger, pool, metrics, drapeaux })

  const port = Number(config.PORT)
  const server = app.listen(port, () => {
    logger.info('service démarré', { port, version: config.APP_VERSION, config: redact(config) })
  })

  /**
   * Arrêt progressif.
   * L'orchestrateur envoie SIGTERM, retire l'instance du répartiteur de charge,
   * puis attend : les requêtes en cours se terminent au lieu d'être coupées.
   */
  function shutdown(signal) {
    logger.info('arrêt demandé', { signal })
    server.close(async () => {
      if (pool) await pool.end().catch(() => {})
      logger.info('arrêt terminé')
      process.exit(0)
    })
    setTimeout(() => {
      logger.error('arrêt forcé après expiration du délai de grâce', { gracePeriodMs })
      process.exit(1)
    }, gracePeriodMs).unref()
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  return { app, server, pool, config, logger, shutdown }
}

module.exports = { startService }
