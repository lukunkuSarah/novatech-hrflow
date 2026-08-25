'use strict'

/**
 * Chargement et validation de la configuration.
 *
 * Corrige SEC-09 (secrets codés en dur en valeur de repli) et SEC-10.
 *
 * Règle : aucune valeur de repli pour un secret. Un service dont la
 * configuration est incomplète doit refuser de démarrer — un service qui
 * démarre avec un secret par défaut est un service compromis qui s'ignore.
 */

const REDACTED = '[redacted]'

/** Motifs de noms de variables dont la valeur ne doit jamais être journalisée. */
const SENSITIVE = /(SECRET|PASSWORD|TOKEN|KEY|PASS|DSN|CREDENTIAL)/i

class ConfigError extends Error {
  constructor(missing) {
    super(
      `Configuration incomplète — variables d'environnement manquantes : ${missing.join(', ')}. ` +
        `Le service refuse de démarrer (voir docs/00-AUDIT-J1.md, SEC-09).`
    )
    this.name = 'ConfigError'
    this.missing = missing
  }
}

/**
 * Vérifie la présence des variables requises et retourne un objet de configuration.
 *
 * @param {object} options
 * @param {string[]} options.required  Variables sans lesquelles le service ne peut pas fonctionner.
 * @param {object}   [options.optional] Variables facultatives et leur valeur par défaut (non secrètes).
 * @param {object}   [options.env]      Source des variables (injectable pour les tests).
 * @returns {object} configuration validée
 * @throws {ConfigError} si une variable requise est absente ou vide
 */
function loadConfig({ required = [], optional = {}, env = process.env } = {}) {
  const missing = required.filter((key) => {
    const value = env[key]
    return value === undefined || value === null || String(value).trim() === ''
  })

  if (missing.length > 0) throw new ConfigError(missing)

  const config = {}
  for (const key of required) config[key] = env[key]
  for (const [key, fallback] of Object.entries(optional)) {
    config[key] = env[key] !== undefined && env[key] !== '' ? env[key] : fallback
  }

  config.isProduction = (env.NODE_ENV || 'development') === 'production'
  config.nodeEnv = env.NODE_ENV || 'development'
  return config
}

/**
 * Copie d'un objet de configuration sûre à journaliser.
 * Les valeurs sensibles sont remplacées, jamais tronquées : un préfixe de secret
 * reste une information exploitable.
 */
function redact(config) {
  const safe = {}
  for (const [key, value] of Object.entries(config)) {
    safe[key] = SENSITIVE.test(key) ? REDACTED : value
  }
  return safe
}

module.exports = { loadConfig, redact, ConfigError, SENSITIVE }
