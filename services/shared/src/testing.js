'use strict'

const { signAccessToken } = require('./auth')
const { createLogger } = require('./logger')

/**
 * Utilitaires de test partagés.
 *
 * Les tests doivent tourner en intégration continue sans base de données ni
 * réseau : une suite de tests qui exige une infrastructure finit par être
 * désactivée — c'est exactement ce qui s'est produit ici en janvier 2022
 * (« tests désactivés car ils cassaient le pipeline »).
 */

/** Journaliseur silencieux : les tests ne polluent pas la sortie. */
function silentLogger(service = 'test') {
  return createLogger({ service, stream: { write() {} } })
}

/**
 * Faux pool PostgreSQL.
 *
 * @param {Array|Function} reponses  Suite de résultats renvoyés dans l'ordre,
 *   ou fonction (sql, params) => résultat pour un contrôle fin.
 */
function fakePool(reponses = []) {
  const appels = []
  let index = 0

  function resoudre(sql, params) {
    appels.push({ sql, params })
    if (typeof reponses === 'function') return reponses(sql, params, appels.length - 1)
    const reponse = reponses[index++]
    if (reponse === undefined) return { rows: [], rowCount: 0 }
    if (reponse instanceof Error) throw reponse
    return reponse
  }

  const client = {
    query: async (sql, params) => resoudre(sql, params),
    release() {}
  }

  return {
    appels,
    /** Requêtes SQL émises, utile pour vérifier le paramétrage (SEC-02). */
    get sqls() {
      return appels.map((a) => a.sql)
    },
    query: async (sql, params) => resoudre(sql, params),
    connect: async () => client,
    end: async () => {}
  }
}

/** Configuration minimale d'un service sous test. */
function testConfig(extra = {}) {
  return {
    JWT_SECRET: 'secret-de-test-uniquement-non-utilise-en-production',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    APP_VERSION: 'test',
    ACCESS_TOKEN_TTL: '15m',
    UPLOAD_DIR: './tmp/test-cv',
    RATE_LIMIT_PAR_MINUTE: '1000',
    PROXY_TIMEOUT_MS: '2000',
    isProduction: false,
    nodeEnv: 'test',
    ...extra
  }
}

/** Fabrique un en-tête Authorization valide pour un rôle donné. */
function bearer({
  secret = testConfig().JWT_SECRET,
  userId = '1',
  employeeId = '10',
  companyId = '100',
  role = 'salarie',
  expiresIn = '15m'
} = {}) {
  const token = signAccessToken({ sub: userId, employeeId, companyId, role }, secret, { expiresIn })
  return `Bearer ${token}`
}

module.exports = { fakePool, testConfig, bearer, silentLogger }
