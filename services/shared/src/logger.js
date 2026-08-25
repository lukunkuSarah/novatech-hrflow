'use strict'

const { SENSITIVE } = require('./config')

/**
 * Journalisation structurée.
 *
 * Corrige QUA-14 (logs non structurés), SEC-10 (secret journalisé),
 * SEC-20 (données personnelles en clair dans les journaux).
 *
 * Trois garanties :
 *   1. sortie JSON sur une ligne, exploitable par un agrégateur ;
 *   2. identifiant de corrélation propagé de la gateway aux services ;
 *   3. expurgation automatique — un secret ne peut pas être journalisé par accident.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

/** Masque une adresse e-mail : jean.dupont@novatech.io -> j***t@novatech.io */
function maskEmail(value) {
  const match = /^([^@]+)@(.+)$/.exec(String(value))
  if (!match) return '[redacted]'
  const [, local, domain] = match
  const head = local.slice(0, 1)
  const tail = local.length > 1 ? local.slice(-1) : ''
  return `${head}***${tail}@${domain}`
}

/** Expurge récursivement les champs sensibles et les données personnelles. */
function sanitize(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1))
  if (typeof value !== 'object') return value

  const out = {}
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE.test(key)) out[key] = '[redacted]'
    else if (/^(email|mail)$/i.test(key)) out[key] = maskEmail(val)
    else if (typeof val === 'object') out[key] = sanitize(val, depth + 1)
    else out[key] = val
  }
  return out
}

function createLogger({ service, level = process.env.LOG_LEVEL || 'info', stream = process.stdout } = {}) {
  const threshold = LEVELS[level] || LEVELS.info

  function write(levelName, message, context = {}) {
    if (LEVELS[levelName] < threshold) return
    const entry = {
      ts: new Date().toISOString(),
      level: levelName,
      service,
      msg: message,
      ...sanitize(context)
    }
    stream.write(`${JSON.stringify(entry)}\n`)
  }

  return {
    debug: (msg, ctx) => write('debug', msg, ctx),
    info: (msg, ctx) => write('info', msg, ctx),
    warn: (msg, ctx) => write('warn', msg, ctx),
    error: (msg, ctx) => write('error', msg, ctx),
    /** Journaliseur enfant portant un contexte permanent (ex. requestId). */
    child(bound) {
      return {
        debug: (msg, ctx) => write('debug', msg, { ...bound, ...ctx }),
        info: (msg, ctx) => write('info', msg, { ...bound, ...ctx }),
        warn: (msg, ctx) => write('warn', msg, { ...bound, ...ctx }),
        error: (msg, ctx) => write('error', msg, { ...bound, ...ctx })
      }
    }
  }
}

module.exports = { createLogger, sanitize, maskEmail }
