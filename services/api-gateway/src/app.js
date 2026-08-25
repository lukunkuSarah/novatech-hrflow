'use strict'

const { createProxyMiddleware } = require('http-proxy-middleware')
const rateLimit = require('express-rate-limit')
const { createApp, healthRouter, AppError, requireAuth, notFoundHandler, errorHandler } = require('@hrflow/shared')

/**
 * Passerelle d'API — version corrigée.
 *
 * Constats traités : SEC-06 (middleware d'authentification commenté),
 * SEC-10 (secret journalisé au démarrage), SEC-11 (CORS permissif),
 * SEC-12 (traces d'exécution exposées), INF-01 (sonde de santé mensongère).
 *
 * Point d'attention : la passerelle authentifie, mais chaque service revérifie
 * pour son propre compte. C'est volontairement redondant — l'incident d'origine
 * vient de ce que les services faisaient confiance à une vérification qui
 * n'avait plus lieu.
 */

/** Routes accessibles sans jeton : ce sont celles qui servent à en obtenir un. */
const ROUTES_PUBLIQUES = [
  { method: 'POST', path: '/api/auth/login' },
  { method: 'POST', path: '/api/auth/refresh' },
  { method: 'POST', path: '/api/auth/password-reset/request' },
  { method: 'POST', path: '/api/auth/password-reset/confirm' }
]

function estPublique(req) {
  return ROUTES_PUBLIQUES.some((route) => route.method === req.method && req.path === route.path)
}

function createGatewayApp({ config, logger, fetchImpl = globalThis.fetch, metrics }) {
  const app = createApp({ logger, allowedOrigins: config.ALLOWED_ORIGINS, metrics })

  const cibles = {
    auth: config.AUTH_URL,
    paie: config.PAIE_URL,
    conges: config.CONGES_URL,
    recrutement: config.RECRUTEMENT_URL
  }

  /**
   * Sonde de santé réelle (INF-01).
   * L'ancienne version renvoyait 200 en toutes circonstances. Celle-ci
   * interroge chaque service : si l'un d'eux est indisponible, la passerelle se
   * déclare non prête et la supervision le voit dans la minute.
   */
  app.use(
    healthRouter({
      service: 'api-gateway',
      version: config.APP_VERSION,
      dependencies: Object.entries(cibles).map(([nom, url]) => ({
        name: nom,
        async check() {
          const reponse = await fetchImpl(`${url}/health/live`)
          if (!reponse.ok) throw new Error(`statut ${reponse.status}`)
          return true
        }
      }))
    })
  )

  // Limitation de débit globale, en complément de celle du service d'authentification.
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      max: Number(config.RATE_LIMIT_PAR_MINUTE),
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res, next) => next(AppError.tooManyRequests('Trop de requêtes'))
    })
  )

  /**
   * Authentification — le middleware que l'équipe précédente avait commenté
   * « temporairement » en mars 2024, et qui n'a jamais été remis.
   */
  const authenticate = requireAuth({ secret: config.JWT_SECRET })
  // Middleware non monté sur un préfixe : monter sur '/api' retirerait ce
  // préfixe de `req.path`, et la liste des routes publiques ne correspondrait
  // plus. Le filtrage est donc explicite.
  app.use((req, res, next) => {
    if (!/^\/api(\/|$)/.test(req.path)) return next()
    if (estPublique(req)) return next()
    return authenticate(req, res, next)
  })

  /**
   * Fabrique un proxy vers un service interne.
   *
   * On filtre le chemin plutôt que de monter le middleware sur un préfixe :
   * `app.use('/api/conges', ...)` retire le préfixe avant que le proxy ne voie
   * la requête, si bien que le service en aval reçoit `/solde/10` au lieu de
   * `/conges/solde/10`. Avec `pathFilter`, le chemin complet est conservé et la
   * réécriture est explicite.
   */
  function proxy(prefixe, cible) {
    return createProxyMiddleware({
      target: cible,
      changeOrigin: true,
      xfwd: true,
      proxyTimeout: Number(config.PROXY_TIMEOUT_MS),
      timeout: Number(config.PROXY_TIMEOUT_MS),
      pathFilter: (chemin) => chemin === prefixe || chemin.startsWith(`${prefixe}/`),
      // /api/conges/solde/10 -> /conges/solde/10
      pathRewrite: { '^/api': '' },
      on: {
        proxyReq(proxyReq, req) {
          // Propagation de l'identifiant de corrélation et de l'identité vérifiée.
          if (req.id) proxyReq.setHeader('X-Request-Id', req.id)
          if (req.user) {
            proxyReq.setHeader('X-User-Id', String(req.user.userId))
            proxyReq.setHeader('X-Company-Id', String(req.user.companyId))
          }
        },
        error(err, req, res) {
          logger.error('service en aval injoignable', {
            requestId: req.id,
            cible,
            reason: err.message
          })
          if (!res.headersSent) {
            res.status(502).json({
              error: { code: 'BAD_GATEWAY', message: 'Service temporairement indisponible', requestId: req.id }
            })
          }
        }
      }
    })
  }

  app.use(proxy('/api/auth', cibles.auth))
  app.use(proxy('/api/paie', cibles.paie))
  app.use(proxy('/api/conges', cibles.conges))
  app.use(proxy('/api/recrutement', cibles.recrutement))

  app.use(notFoundHandler)
  // Ne renvoie plus jamais de trace d'exécution au client (SEC-12).
  app.use(errorHandler(logger))

  return app
}

module.exports = { createGatewayApp, ROUTES_PUBLIQUES, estPublique }
