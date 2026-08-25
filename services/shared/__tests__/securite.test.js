'use strict'

const express = require('express')
const request = require('supertest')

const { loadConfig, ConfigError, redact } = require('../src/config')
const { createLogger, maskEmail, sanitize } = require('../src/logger')
const { AppError, asyncHandler, notFoundHandler, errorHandler } = require('../src/errors')
const { signAccessToken, requireAuth, requireRole, requireSelfOrRole, companyScope } = require('../src/auth')
const { validate } = require('../src/validate')
const { healthRouter } = require('../src/health')
const { silentLogger, testConfig, bearer } = require('../src/testing')

const SECRET = testConfig().JWT_SECRET

describe('config — refus de démarrer sans secret (SEC-09)', () => {
  it('lève une erreur explicite quand une variable requise manque', () => {
    expect(() => loadConfig({ required: ['JWT_SECRET'], env: {} })).toThrow(ConfigError)
  })

  it('refuse également une variable présente mais vide', () => {
    expect(() => loadConfig({ required: ['JWT_SECRET'], env: { JWT_SECRET: '   ' } })).toThrow(ConfigError)
  })

  it('applique les valeurs par défaut des variables facultatives', () => {
    const config = loadConfig({
      required: ['JWT_SECRET'],
      optional: { PORT: '3001' },
      env: { JWT_SECRET: 'x' }
    })
    expect(config.PORT).toBe('3001')
    expect(config.isProduction).toBe(false)
  })

  it('expurge les secrets avant journalisation (SEC-10)', () => {
    const safe = redact({ JWT_SECRET: 'valeur-reelle', DB_PASSWORD: 'p', PORT: '3001' })
    expect(safe.JWT_SECRET).toBe('[redacted]')
    expect(safe.DB_PASSWORD).toBe('[redacted]')
    expect(safe.PORT).toBe('3001')
  })
})

describe('logger — expurgation automatique (SEC-10, SEC-20)', () => {
  it('ne laisse jamais passer un secret, même imbriqué', () => {
    const lignes = []
    const logger = createLogger({ service: 'test', stream: { write: (l) => lignes.push(l) } })

    logger.info('démarrage', { config: { JWT_SECRET: 'ultra-secret', PORT: 3001 } })

    expect(lignes[0]).not.toContain('ultra-secret')
    expect(lignes[0]).toContain('[redacted]')
  })

  it('masque les adresses e-mail', () => {
    expect(maskEmail('jean.dupont@novatech.io')).toBe('j***t@novatech.io')
    expect(sanitize({ email: 'a@b.io' }).email).toContain('@b.io')
  })

  it('produit une ligne JSON exploitable par un agrégateur', () => {
    const lignes = []
    const logger = createLogger({ service: 'auth', stream: { write: (l) => lignes.push(l) } })
    logger.warn('tentative refusée', { userId: 42 })

    const entree = JSON.parse(lignes[0])
    expect(entree).toMatchObject({ level: 'warn', service: 'auth', msg: 'tentative refusée', userId: 42 })
    expect(entree.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('asyncHandler — le processus ne meurt plus sur un rejet (QUA-01)', () => {
  function app({ withHandler }) {
    const a = express()
    const boom = async () => {
      throw new Error('base indisponible')
    }
    a.get('/boom', withHandler ? asyncHandler(boom) : (req, res, next) => boom().then(res.json).catch(next))
    a.use(notFoundHandler)
    a.use(errorHandler(silentLogger()))
    return a
  }

  it('convertit un rejet en réponse 500 au lieu de laisser fuir le rejet', async () => {
    const reponse = await request(app({ withHandler: true })).get('/boom')
    expect(reponse.status).toBe(500)
  })

  it("ne divulgue ni message interne ni trace d'exécution (SEC-12)", async () => {
    const reponse = await request(app({ withHandler: true })).get('/boom')
    expect(reponse.body.error.message).toBe('Erreur interne')
    expect(reponse.body.error.stack).toBeUndefined()
    expect(JSON.stringify(reponse.body)).not.toContain('base indisponible')
  })

  it('conserve le message des erreurs métier attendues', async () => {
    const a = express()
    a.get(
      '/refuse',
      asyncHandler(async () => {
        throw AppError.forbidden('Accès limité à vos propres données')
      })
    )
    a.use(errorHandler(silentLogger()))

    const reponse = await request(a).get('/refuse')
    expect(reponse.status).toBe(403)
    expect(reponse.body.error.message).toBe('Accès limité à vos propres données')
  })

  it('renvoie 404 sur une route inconnue', async () => {
    const reponse = await request(app({ withHandler: true })).get('/inexistant')
    expect(reponse.status).toBe(404)
  })
})

describe('requireAuth — la garde que l’équipe précédente avait commentée (SEC-06)', () => {
  function protege() {
    const a = express()
    a.get('/prive', requireAuth({ secret: SECRET }), (req, res) => res.json({ user: req.user }))
    a.use(errorHandler(silentLogger()))
    return a
  }

  it('refuse une requête sans jeton', async () => {
    const reponse = await request(protege()).get('/prive')
    expect(reponse.status).toBe(401)
  })

  it('refuse un jeton signé avec un autre secret', async () => {
    const jeton = signAccessToken({ sub: '1' }, 'un-autre-secret-totalement-different')
    const reponse = await request(protege()).get('/prive').set('Authorization', `Bearer ${jeton}`)
    expect(reponse.status).toBe(401)
  })

  it("refuse un jeton dont l'algorithme est 'none' (SEC-19)", async () => {
    // Jeton forgé : en-tête {"alg":"none"}, sans signature.
    const entete = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const charge = Buffer.from(JSON.stringify({ sub: '1', role: 'admin' })).toString('base64url')
    const jetonForge = `${entete}.${charge}.`

    const reponse = await request(protege()).get('/prive').set('Authorization', `Bearer ${jetonForge}`)
    expect(reponse.status).toBe(401)
  })

  it('refuse un jeton expiré', async () => {
    const jeton = signAccessToken({ sub: '1' }, SECRET, { expiresIn: '-1s' })
    const reponse = await request(protege()).get('/prive').set('Authorization', `Bearer ${jeton}`)
    expect(reponse.status).toBe(401)
    expect(reponse.body.error.message).toBe('Jeton expiré')
  })

  it('accepte un jeton valide et expose les revendications', async () => {
    const reponse = await request(protege())
      .get('/prive')
      .set('Authorization', bearer({ role: 'rh' }))
    expect(reponse.status).toBe(200)
    expect(reponse.body.user).toMatchObject({ role: 'rh', companyId: '100' })
  })

  it('honore la liste de révocation (SEC-21)', async () => {
    const a = express()
    a.get('/prive', requireAuth({ secret: SECRET, isRevoked: async () => true }), (req, res) => res.json({ ok: true }))
    a.use(errorHandler(silentLogger()))

    const reponse = await request(a).get('/prive').set('Authorization', bearer())
    expect(reponse.status).toBe(401)
    expect(reponse.body.error.message).toBe('Jeton révoqué')
  })
})

describe('autorisation — cloisonnement et accès horizontal (SEC-08)', () => {
  function app() {
    const a = express()
    a.get('/rh', requireAuth({ secret: SECRET }), requireRole(['rh', 'admin']), (req, res) => res.json({ ok: true }))
    a.get(
      '/salarie/:employeeId',
      requireAuth({ secret: SECRET }),
      requireSelfOrRole('employeeId', ['rh']),
      (req, res) => res.json({ companyId: companyScope(req) })
    )
    a.use(errorHandler(silentLogger()))
    return a
  }

  it('refuse un rôle non habilité', async () => {
    const reponse = await request(app())
      .get('/rh')
      .set('Authorization', bearer({ role: 'salarie' }))
    expect(reponse.status).toBe(403)
  })

  it('autorise un rôle habilité', async () => {
    const reponse = await request(app())
      .get('/rh')
      .set('Authorization', bearer({ role: 'admin' }))
    expect(reponse.status).toBe(200)
  })

  it('autorise un salarié à consulter ses propres données', async () => {
    const reponse = await request(app())
      .get('/salarie/10')
      .set('Authorization', bearer({ role: 'salarie', employeeId: '10' }))
    expect(reponse.status).toBe(200)
  })

  it("refuse à un salarié l'accès aux données d'un autre salarié", async () => {
    const reponse = await request(app())
      .get('/salarie/99')
      .set('Authorization', bearer({ role: 'salarie', employeeId: '10' }))
    expect(reponse.status).toBe(403)
  })

  it('refuse un jeton sans rattachement client', async () => {
    const jeton = signAccessToken({ sub: '1', employeeId: '10', role: 'salarie' }, SECRET)
    const reponse = await request(app()).get('/salarie/10').set('Authorization', `Bearer ${jeton}`)
    expect(reponse.status).toBe(403)
  })
})

describe('validate — aucune donnée non contrôlée ne descend vers SQL (SEC-02)', () => {
  it('rejette une adresse e-mail malformée', () => {
    expect(() => validate({ email: "' OR 1=1 --" }, { email: ['email'] })).toThrow(AppError)
  })

  it('rejette un identifiant non numérique et non UUID', () => {
    expect(() => validate({ id: '1; DROP TABLE users' }, { id: ['id'] })).toThrow(AppError)
  })

  it('rejette une date inexistante au calendrier', () => {
    expect(() => validate({ d: '2024-02-31' }, { d: ['isoDate'] })).toThrow(AppError)
  })

  it('rejette une valeur hors énumération', () => {
    expect(() => validate({ s: 'valide_moi' }, { s: ['enum', ['approuve', 'refuse']] })).toThrow(AppError)
  })

  it('impose une longueur minimale de mot de passe', () => {
    expect(() => validate({ p: 'court' }, { p: ['password'] })).toThrow(AppError)
    expect(validate({ p: 'un-mot-de-passe-suffisant' }, { p: ['password'] }).p).toBeDefined()
  })

  it('normalise les valeurs acceptées', () => {
    const sortie = validate({ email: '  Jean@NovaTech.IO ', id: '42' }, { email: ['email'], id: ['id'] })
    expect(sortie).toEqual({ email: 'jean@novatech.io', id: '42' })
  })
})

describe('sondes de santé — plus de 200 systématique (INF-01)', () => {
  function app(dependencies) {
    const a = express()
    a.use(healthRouter({ service: 'test', version: '1.0.0', dependencies }))
    a.use(errorHandler(silentLogger()))
    return a
  }

  it('répond 200 sur /health/live sans interroger les dépendances', async () => {
    const reponse = await request(app([{ name: 'db', check: () => Promise.reject(new Error('down')) }])).get(
      '/health/live'
    )
    expect(reponse.status).toBe(200)
    expect(reponse.body.status).toBe('alive')
  })

  it('répond 503 sur /health/ready quand une dépendance critique est tombée', async () => {
    const reponse = await request(app([{ name: 'postgres', check: () => Promise.reject(new Error('refusée')) }])).get(
      '/health/ready'
    )
    expect(reponse.status).toBe(503)
    expect(reponse.body.status).toBe('unready')
    expect(reponse.body.dependencies[0]).toMatchObject({ name: 'postgres', status: 'down' })
  })

  it('répond 200 quand toutes les dépendances répondent', async () => {
    const reponse = await request(app([{ name: 'postgres', check: async () => true }])).get('/health/ready')
    expect(reponse.status).toBe(200)
    expect(reponse.body.status).toBe('ready')
  })

  it('/health hérite du comportement réel et non du 200 systématique', async () => {
    const reponse = await request(app([{ name: 'postgres', check: () => Promise.reject(new Error('down')) }])).get(
      '/health'
    )
    expect(reponse.status).toBe(503)
  })
})
