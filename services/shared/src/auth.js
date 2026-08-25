'use strict'

const jwt = require('jsonwebtoken')
const { AppError } = require('./errors')

/**
 * Authentification et autorisation.
 *
 * Corrige SEC-06 (middleware d'authentification désactivé),
 * SEC-08 (absence de contrôle d'accès horizontal et de cloisonnement
 * multi-locataire), SEC-19 (algorithme de signature non contraint) et
 * SEC-21 (absence de révocation).
 *
 * Principe retenu : défense en profondeur. La passerelle authentifie, mais
 * chaque service revérifie pour son propre compte. L'incident d'origine vient
 * précisément de l'hypothèse inverse — les services supposaient que la
 * passerelle avait vérifié, alors que son middleware était commenté.
 */

const ALGORITHMS = ['HS256']
const ISSUER = 'hrflow-auth'
const AUDIENCE = 'hrflow-api'

/** Émet un jeton d'accès de courte durée. */
function signAccessToken(payload, secret, { expiresIn = '15m' } = {}) {
  return jwt.sign(payload, secret, {
    algorithm: 'HS256',
    expiresIn,
    issuer: ISSUER,
    audience: AUDIENCE
  })
}

/**
 * Vérifie un jeton.
 * L'algorithme est explicitement contraint : sans cette contrainte, un jeton
 * signé avec `alg: none` ou une confusion d'algorithme peut être accepté.
 */
function verifyToken(token, secret) {
  return jwt.verify(token, secret, { algorithms: ALGORITHMS, issuer: ISSUER, audience: AUDIENCE })
}

function extractBearer(req) {
  const header = req.headers.authorization || ''
  const [scheme, value] = header.split(' ')
  if (!/^Bearer$/i.test(scheme || '') || !value) return null
  return value.trim()
}

/**
 * Middleware d'authentification.
 *
 * @param {object} options
 * @param {string} options.secret          Secret de signature.
 * @param {Function} [options.isRevoked]   Prédicat asynchrone de révocation (liste de retrait).
 */
function requireAuth({ secret, isRevoked } = {}) {
  if (!secret) throw new Error('requireAuth : secret manquant')

  return async function authenticate(req, res, next) {
    try {
      const token = extractBearer(req)
      if (!token) throw AppError.unauthorized('Jeton absent')

      let claims
      try {
        claims = verifyToken(token, secret)
      } catch (err) {
        const message = err.name === 'TokenExpiredError' ? 'Jeton expiré' : 'Jeton invalide'
        throw AppError.unauthorized(message)
      }

      if (isRevoked && (await isRevoked(claims))) {
        throw AppError.unauthorized('Jeton révoqué')
      }

      // eslint-disable-next-line require-atomic-updates -- `req` est propre à cette requête : aucun accès concurrent possible.
      req.user = {
        userId: claims.sub,
        employeeId: claims.employeeId,
        companyId: claims.companyId,
        role: claims.role
      }
      next()
    } catch (err) {
      next(err)
    }
  }
}

/** Restreint l'accès à une liste de rôles. */
function requireRole(...roles) {
  const allowed = new Set(roles.flat())
  return function authorize(req, res, next) {
    if (!req.user) return next(AppError.unauthorized())
    if (!allowed.has(req.user.role)) {
      return next(AppError.forbidden(`Rôle requis : ${[...allowed].join(' ou ')}`))
    }
    next()
  }
}

/**
 * Autorise l'accès à une ressource rattachée à un salarié :
 * soit l'appelant est ce salarié, soit il détient un rôle habilité.
 *
 * C'est le correctif de SEC-08 : sans ce contrôle, `/conges/solde/:employeeId`
 * expose les données de n'importe quel salarié de n'importe quel client.
 */
function requireSelfOrRole(paramName, ...roles) {
  const allowed = new Set(roles.flat())
  return function authorize(req, res, next) {
    if (!req.user) return next(AppError.unauthorized())
    const target = String(req.params[paramName] ?? req.body[paramName] ?? '')
    const isSelf = target !== '' && target === String(req.user.employeeId)
    if (isSelf || allowed.has(req.user.role)) return next()
    return next(AppError.forbidden('Accès limité à vos propres données'))
  }
}

/**
 * Garde-fou de cloisonnement multi-locataire.
 * Toute requête de lecture ou d'écriture doit être filtrée par entreprise :
 * cet utilitaire rend l'oubli visible plutôt que silencieux.
 */
function companyScope(req) {
  if (!req.user || !req.user.companyId) {
    throw AppError.forbidden('Contexte client indéterminé')
  }
  return req.user.companyId
}

module.exports = {
  signAccessToken,
  verifyToken,
  requireAuth,
  requireRole,
  requireSelfOrRole,
  companyScope,
  extractBearer,
  ALGORITHMS,
  ISSUER,
  AUDIENCE
}
