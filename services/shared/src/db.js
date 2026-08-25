'use strict'

const { Pool } = require('pg')

/**
 * Accès à la base de données.
 *
 * Corrige SEC-02 (injection SQL), SEC-09 (identifiants codés en dur),
 * QUA-04 (écritures non transactionnelles) et INF-09 (absence de limites).
 *
 * Deux règles non négociables, appliquées par la forme même de l'API :
 *   1. aucune valeur de repli sur les identifiants de connexion ;
 *   2. `query` n'accepte qu'un texte SQL constant et des paramètres séparés —
 *      la concaténation de chaînes reste possible en JavaScript, mais le code
 *      de revue la repère immédiatement puisque plus aucun appel n'en contient.
 */

function createPool({
  connectionString,
  ssl,
  max = 10,
  idleTimeoutMillis = 30000,
  connectionTimeoutMillis = 5000
} = {}) {
  if (!connectionString) {
    throw new Error('createPool : DATABASE_URL manquant — aucune valeur de repli (SEC-09)')
  }

  return new Pool({
    connectionString,
    ssl: ssl === true ? { rejectUnauthorized: true } : undefined,
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis,
    // Empêche une requête pathologique de bloquer une connexion indéfiniment.
    statement_timeout: 10000,
    query_timeout: 10000
  })
}

/**
 * Exécute une fonction dans une transaction.
 * Corrige QUA-04 : l'insertion du bulletin et l'ordre de virement doivent
 * réussir ou échouer ensemble, jamais l'un sans l'autre.
 */
async function withTransaction(pool, fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // L'échec du retour arrière ne doit pas masquer l'erreur d'origine.
    }
    throw err
  } finally {
    client.release()
  }
}

/** Sonde de disponibilité de la base, destinée à /health/ready. */
function pingCheck(pool) {
  return async function ping() {
    const { rows } = await pool.query('SELECT 1 AS ok')
    if (!rows.length) throw new Error('Réponse inattendue de la base')
    return true
  }
}

module.exports = { createPool, withTransaction, pingCheck }
