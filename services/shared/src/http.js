'use strict'

const crypto = require('crypto')
const express = require('express')
const helmet = require('helmet')
const cors = require('cors')
const { AppError } = require('./errors')

/**
 * Fabrique d'application Express durcie.
 *
 * Corrige SEC-11 (CORS permissif), SEC-17 (absence d'en-têtes de sécurité),
 * INF-09 (absence de limite de taille de corps) et QUA-14 (corrélation).
 */

/** Attribue un identifiant de corrélation à chaque requête et le renvoie au client. */
function requestId() {
  return function assignId(req, res, next) {
    const incoming = req.headers['x-request-id']
    req.id = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID()
    res.setHeader('X-Request-Id', req.id)
    next()
  }
}

/** Journalise chaque requête terminée, avec sa durée. */
function requestLogger(logger) {
  return function log(req, res, next) {
    const startedAt = process.hrtime.bigint()
    req.log = logger.child({ requestId: req.id })

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'
      req.log[level]('requête traitée', {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        userId: req.user ? req.user.userId : undefined
      })
    })

    next()
  }
}

/**
 * Construit la politique CORS.
 * Une liste d'origines explicite remplace le caractère générique : avec
 * `Access-Control-Allow-Origin: *`, n'importe quel site peut appeler l'API
 * depuis le navigateur d'un salarié authentifié.
 */
function corsPolicy(allowedOrigins) {
  const allowlist = (allowedOrigins || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)

  return cors({
    origin(origin, callback) {
      // Absence d'origine : appel serveur à serveur ou outil en ligne de commande.
      if (!origin) return callback(null, true)
      if (allowlist.includes(origin)) return callback(null, true)
      return callback(AppError.forbidden(`Origine non autorisée : ${origin}`))
    },
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    credentials: true,
    maxAge: 600
  })
}

/**
 * @param {object} options
 * @param {object} options.logger
 * @param {string} [options.allowedOrigins] Liste d'origines séparées par des virgules.
 * @param {string} [options.bodyLimit]      Taille maximale du corps JSON.
 */
function createApp({ logger, allowedOrigins, bodyLimit = '100kb' } = {}) {
  const app = express()

  app.disable('x-powered-by')
  app.set('trust proxy', 1)

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"]
        }
      },
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
      referrerPolicy: { policy: 'no-referrer' }
    })
  )

  app.use(requestId())
  app.use(requestLogger(logger))
  app.use(corsPolicy(allowedOrigins))
  app.use(express.json({ limit: bodyLimit }))

  return app
}

module.exports = { createApp, requestId, requestLogger, corsPolicy }
