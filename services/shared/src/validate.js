'use strict'

const { AppError } = require('./errors')

/**
 * Validation des entrées.
 *
 * Corrige SEC-02 en amont (aucune donnée non validée n'atteint la couche SQL)
 * et QUA-05 (dates de congés incohérentes acceptées telles quelles).
 *
 * Implémentation volontairement sans dépendance externe : le périmètre à
 * valider est restreint et connu, et chaque dépendance ajoutée est une surface
 * d'attaque supplémentaire dans une chaîne dont c'est précisément le défaut.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const rules = {
  email(value, field) {
    const v = String(value ?? '')
      .trim()
      .toLowerCase()
    if (!EMAIL.test(v) || v.length > 254) throw AppError.badRequest(`${field} : adresse e-mail invalide`)
    return v
  },

  string(value, field, { min = 1, max = 255, pattern } = {}) {
    const v = String(value ?? '').trim()
    if (v.length < min || v.length > max) {
      throw AppError.badRequest(`${field} : longueur attendue entre ${min} et ${max} caractères`)
    }
    if (pattern && !pattern.test(v)) throw AppError.badRequest(`${field} : format invalide`)
    return v
  },

  integer(value, field, { min = -Infinity, max = Infinity } = {}) {
    const v = Number(value)
    if (!Number.isInteger(v) || v < min || v > max) {
      throw AppError.badRequest(`${field} : entier attendu entre ${min} et ${max}`)
    }
    return v
  },

  /** Identifiant opaque : accepte un entier positif ou un UUID. */
  id(value, field) {
    const v = String(value ?? '').trim()
    const isInt = /^\d{1,12}$/.test(v)
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
    if (!isInt && !isUuid) throw AppError.badRequest(`${field} : identifiant invalide`)
    return v
  },

  isoDate(value, field) {
    const v = String(value ?? '').trim()
    if (!ISO_DATE.test(v)) throw AppError.badRequest(`${field} : date attendue au format AAAA-MM-JJ`)
    const date = new Date(`${v}T00:00:00.000Z`)
    if (Number.isNaN(date.getTime())) throw AppError.badRequest(`${field} : date invalide`)
    // Contrôle de cohérence : le 2024-02-31 passe l'expression régulière mais pas le calendrier.
    if (date.toISOString().slice(0, 10) !== v) throw AppError.badRequest(`${field} : date inexistante`)
    return v
  },

  enum(value, field, allowed) {
    const v = String(value ?? '').trim()
    if (!allowed.includes(v)) {
      throw AppError.badRequest(`${field} : valeur attendue parmi ${allowed.join(', ')}`)
    }
    return v
  },

  password(value, field) {
    const v = String(value ?? '')
    if (v.length < 12 || v.length > 128) {
      throw AppError.badRequest(`${field} : 12 caractères minimum`)
    }
    return v
  }
}

/**
 * Valide un objet selon un schéma déclaratif.
 * @example
 *   const { email, password } = validate(req.body, {
 *     email: ['email'],
 *     password: ['password']
 *   })
 */
function validate(source, schema) {
  if (source === null || typeof source !== 'object') {
    throw AppError.badRequest('Corps de requête invalide')
  }

  const out = {}
  for (const [field, spec] of Object.entries(schema)) {
    const [ruleName, options] = Array.isArray(spec) ? spec : [spec]
    const rule = rules[ruleName]
    if (!rule) throw new Error(`Règle de validation inconnue : ${ruleName}`)
    out[field] = rule(source[field], field, options)
  }
  return out
}

/**
 * Nettoie un nom de fichier téléversé.
 * Corrige SEC-07 : `file.originalname` était réutilisé tel quel, ce qui autorise
 * `../../etc/cron.d/payload` comme nom de fichier.
 */
function safeFilename(original, { fallbackExtension = '' } = {}) {
  const base =
    String(original || '')
      .split(/[\\/]/)
      .pop() || ''
  const match = /\.([a-z0-9]{1,8})$/i.exec(base)
  const extension = match ? `.${match[1].toLowerCase()}` : fallbackExtension
  return { extension }
}

module.exports = { validate, rules, safeFilename, EMAIL, ISO_DATE }
