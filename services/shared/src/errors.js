'use strict'

/**
 * Gestion d'erreurs.
 *
 * Corrige QUA-01 (rejet de promesse non géré → arrêt du processus) et
 * SEC-12 (traces d'exécution renvoyées au client).
 *
 * Express 4 n'intercepte pas les rejets de promesses des gestionnaires
 * asynchrones : sans `asyncHandler`, une seule requête malformée suffit à
 * arrêter le processus. C'est le déni de service décrit en QUA-01.
 */

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code
    this.details = details
    this.expected = true
  }

  static badRequest(message, details) {
    return new AppError(400, 'BAD_REQUEST', message, details)
  }
  static unauthorized(message = 'Authentification requise') {
    return new AppError(401, 'UNAUTHORIZED', message)
  }
  static forbidden(message = 'Accès refusé') {
    return new AppError(403, 'FORBIDDEN', message)
  }
  static notFound(message = 'Ressource introuvable') {
    return new AppError(404, 'NOT_FOUND', message)
  }
  static conflict(message, details) {
    return new AppError(409, 'CONFLICT', message, details)
  }
  static tooManyRequests(message = 'Trop de requêtes') {
    return new AppError(429, 'TOO_MANY_REQUESTS', message)
  }
  static internal(message = 'Erreur interne') {
    return new AppError(500, 'INTERNAL_ERROR', message)
  }
}

/** Encadre un gestionnaire asynchrone pour que tout rejet parte vers le middleware d'erreurs. */
function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next)
  }
}

/** Middleware 404 — placé après toutes les routes. */
function notFoundHandler(req, res, next) {
  next(AppError.notFound(`Route inconnue : ${req.method} ${req.originalUrl}`))
}

/**
 * Middleware d'erreurs terminal.
 * Ne divulgue jamais de trace d'exécution : le détail va dans le journal côté
 * serveur, le client reçoit un code d'erreur et un identifiant de corrélation.
 */
function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars -- Express identifie ce middleware par son arité (4 arguments)
  return function handle(err, req, res, next) {
    const status = err.status || 500
    const isExpected = err.expected === true

    const log = (req.log || logger)[status >= 500 ? 'error' : 'warn'].bind(req.log || logger)
    log(err.message, {
      code: err.code || 'INTERNAL_ERROR',
      status,
      method: req.method,
      path: req.originalUrl,
      // La trace reste côté serveur : elle est nécessaire au diagnostic, jamais au client.
      stack: status >= 500 ? err.stack : undefined
    })

    res.status(status).json({
      error: {
        code: err.code || 'INTERNAL_ERROR',
        message: isExpected ? err.message : 'Erreur interne',
        details: isExpected ? err.details : undefined,
        requestId: req.id
      }
    })
  }
}

/**
 * Filets de sécurité au niveau du processus.
 * Une exception non capturée laisse le processus dans un état indéterminé :
 * on journalise puis on sort proprement, en laissant l'orchestrateur redémarrer.
 */
function installProcessGuards(logger, { exit = (code) => process.exit(code) } = {}) {
  process.on('unhandledRejection', (reason) => {
    logger.error('Rejet de promesse non géré', { reason: String(reason && reason.stack ? reason.stack : reason) })
    exit(1)
  })
  process.on('uncaughtException', (err) => {
    logger.error('Exception non capturée', { reason: err.stack })
    exit(1)
  })
}

module.exports = { AppError, asyncHandler, notFoundHandler, errorHandler, installProcessGuards }
