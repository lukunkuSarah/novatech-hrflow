#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Pool } = require('pg')

/**
 * Applicateur de migrations.
 *
 * Remplace la route `POST /paie/migrate` (SEC-04), qui exécutait du SQL de
 * schéma dans le processus servant le trafic de production, sans
 * authentification et sans trace.
 *
 * Garanties apportées :
 *   - chaque migration est un fichier versionné, relu et testé ;
 *   - chacune s'exécute dans sa propre transaction : elle passe entièrement ou
 *     pas du tout ;
 *   - un verrou consultatif empêche deux exécutions simultanées ;
 *   - l'empreinte de chaque fichier appliqué est enregistrée : une migration
 *     modifiée après coup est détectée au lieu d'être ignorée ;
 *   - l'historique est consultable dans la table `schema_migrations`.
 *
 * USAGE : node db/migrate.js <up|status|down>
 */

const REPERTOIRE = path.join(__dirname, 'migrations')
const VERROU = 4242 // identifiant arbitraire mais stable du verrou consultatif

function journaliser(message) {
  process.stdout.write(`[migrate] ${message}\n`)
}

function empreinte(contenu) {
  return crypto.createHash('sha256').update(contenu).digest('hex').slice(0, 16)
}

function listerMigrations() {
  if (!fs.existsSync(REPERTOIRE)) return []
  return fs
    .readdirSync(REPERTOIRE)
    .filter((nom) => nom.endsWith('.sql') && !nom.endsWith('.down.sql'))
    .sort()
    .map((nom) => {
      const contenu = fs.readFileSync(path.join(REPERTOIRE, nom), 'utf8')
      return { nom, contenu, empreinte: empreinte(contenu) }
    })
}

async function preparer(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      nom          VARCHAR(255) PRIMARY KEY,
      empreinte    VARCHAR(64) NOT NULL,
      appliquee_le TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      duree_ms     INTEGER
    )
  `)
}

async function dejaAppliquees(client) {
  const { rows } = await client.query('SELECT nom, empreinte FROM schema_migrations')
  return new Map(rows.map((r) => [r.nom, r.empreinte]))
}

async function commandeUp(pool) {
  const client = await pool.connect()
  try {
    // Verrou consultatif : deux déploiements simultanés ne peuvent pas appliquer
    // la même migration en même temps.
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS obtenu', [VERROU])
    if (!rows[0].obtenu) {
      throw new Error('Une autre migration est déjà en cours. Abandon.')
    }

    await preparer(client)
    const appliquees = await dejaAppliquees(client)
    const migrations = listerMigrations()
    let compte = 0

    for (const migration of migrations) {
      const empreinteConnue = appliquees.get(migration.nom)

      if (empreinteConnue) {
        if (empreinteConnue !== migration.empreinte) {
          // Une migration déjà appliquée puis modifiée signifie que les
          // environnements ont divergé silencieusement.
          throw new Error(
            `La migration ${migration.nom} a été modifiée après son application ` +
              `(empreinte ${empreinteConnue} → ${migration.empreinte}). ` +
              `Créez une nouvelle migration plutôt que de modifier celle-ci.`
          )
        }
        continue
      }

      journaliser(`application de ${migration.nom}`)
      const debut = Date.now()

      await client.query('BEGIN')
      try {
        await client.query(migration.contenu)
        await client.query(
          'INSERT INTO schema_migrations (nom, empreinte, duree_ms) VALUES ($1, $2, $3)',
          [migration.nom, migration.empreinte, Date.now() - debut]
        )
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw new Error(`Échec de ${migration.nom} : ${err.message}`)
      }

      journaliser(`  ${migration.nom} appliquée en ${Date.now() - debut} ms`)
      compte += 1
    }

    journaliser(compte === 0 ? 'schéma déjà à jour' : `${compte} migration(s) appliquée(s)`)
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [VERROU]).catch(() => {})
    client.release()
  }
}

async function commandeStatus(pool) {
  const client = await pool.connect()
  try {
    await preparer(client)
    const appliquees = await dejaAppliquees(client)
    for (const migration of listerMigrations()) {
      const etat = appliquees.has(migration.nom) ? 'appliquée' : 'EN ATTENTE'
      journaliser(`${etat.padEnd(11)} ${migration.nom}`)
    }
  } finally {
    client.release()
  }
}

/**
 * Retour arrière de la dernière migration.
 *
 * Il exige un fichier `<nom>.down.sql` explicite : une annulation de migration
 * ne s'improvise pas, et surtout elle ne se devine pas. En l'absence de ce
 * fichier, la commande refuse d'agir et renvoie vers la procédure de
 * restauration documentée.
 */
async function commandeDown(pool) {
  const client = await pool.connect()
  try {
    await preparer(client)
    const { rows } = await client.query(
      'SELECT nom FROM schema_migrations ORDER BY appliquee_le DESC, nom DESC LIMIT 1'
    )
    if (rows.length === 0) {
      journaliser('aucune migration à annuler')
      return
    }

    const nom = rows[0].nom
    const cheminDown = path.join(REPERTOIRE, nom.replace(/\.sql$/, '.down.sql'))

    if (!fs.existsSync(cheminDown)) {
      throw new Error(
        `Aucun fichier d'annulation pour ${nom}. ` +
          `Restauration à partir d'une sauvegarde : voir docs/RUNBOOK.md § restauration.`
      )
    }

    journaliser(`annulation de ${nom}`)
    await client.query('BEGIN')
    try {
      await client.query(fs.readFileSync(cheminDown, 'utf8'))
      await client.query('DELETE FROM schema_migrations WHERE nom = $1', [nom])
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    }
    journaliser(`${nom} annulée`)
  } finally {
    client.release()
  }
}

async function main() {
  const commande = process.argv[2] || 'up'

  if (!process.env.DATABASE_URL) {
    process.stderr.write('[migrate] DATABASE_URL manquant — aucune valeur de repli (SEC-09)\n')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })

  try {
    if (commande === 'up') await commandeUp(pool)
    else if (commande === 'status') await commandeStatus(pool)
    else if (commande === 'down') await commandeDown(pool)
    else {
      process.stderr.write(`[migrate] commande inconnue : ${commande}\n`)
      process.stderr.write('[migrate] usage : node db/migrate.js <up|status|down>\n')
      process.exit(1)
    }
  } catch (err) {
    process.stderr.write(`[migrate] ÉCHEC : ${err.message}\n`)
    process.exitCode = 1
  } finally {
    await pool.end().catch(() => {})
  }
}

main()
