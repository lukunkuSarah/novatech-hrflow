'use strict'

const request = require('supertest')

const { createApp } = require('../src/http')
const { asyncHandler, notFoundHandler, errorHandler, installProcessGuards, AppError } = require('../src/errors')
const { createPool, withTransaction, pingCheck } = require('../src/db')
const { withTimeout } = require('../src/health')
const { safeFilename } = require('../src/validate')
const { silentLogger, fakePool } = require('../src/testing')

function app({ allowedOrigins = 'https://hrflow.novatech.io' } = {}) {
  const a = createApp({ logger: silentLogger(), allowedOrigins, bodyLimit: '1kb' })
  a.get('/ok', (req, res) => res.json({ requestId: req.id }))
  a.post('/echo', (req, res) => res.json(req.body))
  a.use(notFoundHandler)
  a.use(errorHandler(silentLogger()))
  return a
}

describe('en-têtes de sécurité HTTP (SEC-17)', () => {
  it('pose les en-têtes que la configuration Nginx auditée ne posait pas', async () => {
    const reponse = await request(app()).get('/ok')

    expect(reponse.headers['x-content-type-options']).toBe('nosniff')
    expect(reponse.headers['x-frame-options']).toBeDefined()
    expect(reponse.headers['content-security-policy']).toContain("default-src 'self'")
    expect(reponse.headers['strict-transport-security']).toContain('max-age=31536000')
    expect(reponse.headers['referrer-policy']).toBe('no-referrer')
  })

  it('ne divulgue plus la technologie serveur', async () => {
    const reponse = await request(app()).get('/ok')
    expect(reponse.headers['x-powered-by']).toBeUndefined()
  })
})

describe('CORS — liste explicite au lieu du caractère générique (SEC-11)', () => {
  it('accepte une origine déclarée', async () => {
    const reponse = await request(app()).get('/ok').set('Origin', 'https://hrflow.novatech.io')

    expect(reponse.status).toBe(200)
    expect(reponse.headers['access-control-allow-origin']).toBe('https://hrflow.novatech.io')
    // Le point de la correction : jamais de '*'.
    expect(reponse.headers['access-control-allow-origin']).not.toBe('*')
  })

  it('refuse une origine inconnue', async () => {
    const reponse = await request(app()).get('/ok').set('Origin', 'https://site-attaquant.example')

    expect(reponse.status).toBe(403)
  })

  it('laisse passer un appel sans origine (serveur à serveur)', async () => {
    const reponse = await request(app()).get('/ok')
    expect(reponse.status).toBe(200)
  })
})

describe('identifiant de corrélation (QUA-14)', () => {
  it('génère un identifiant et le renvoie au client', async () => {
    const reponse = await request(app()).get('/ok')
    expect(reponse.headers['x-request-id']).toBeDefined()
    expect(reponse.body.requestId).toBe(reponse.headers['x-request-id'])
  })

  it('reprend un identifiant fourni en amont', async () => {
    const reponse = await request(app()).get('/ok').set('X-Request-Id', 'trace-abc-12345')
    expect(reponse.body.requestId).toBe('trace-abc-12345')
  })

  it('ignore un identifiant malformé plutôt que de le propager', async () => {
    const reponse = await request(app()).get('/ok').set('X-Request-Id', '<script>alert(1)</script>')
    expect(reponse.body.requestId).not.toContain('<script>')
  })
})

describe('limite de taille du corps de requête (INF-09)', () => {
  it('refuse un corps au-delà de la limite', async () => {
    const reponse = await request(app())
      .post('/echo')
      .send({ donnees: 'x'.repeat(4096) })

    expect(reponse.status).toBe(413)
  })

  it('accepte un corps de taille normale', async () => {
    const reponse = await request(app()).post('/echo').send({ donnees: 'ok' })
    expect(reponse.status).toBe(200)
    expect(reponse.body).toEqual({ donnees: 'ok' })
  })
})

describe('accès base de données', () => {
  it('refuse de créer un pool sans chaîne de connexion — aucune valeur de repli (SEC-09)', () => {
    expect(() => createPool({})).toThrow(/DATABASE_URL manquant/)
  })

  it('valide la connexion via la sonde', async () => {
    const pool = fakePool([{ rows: [{ ok: 1 }] }])
    await expect(pingCheck(pool)()).resolves.toBe(true)
  })

  it('signale une base qui répond de façon inattendue', async () => {
    const pool = fakePool([{ rows: [] }])
    await expect(pingCheck(pool)()).rejects.toThrow(/Réponse inattendue/)
  })

  it('valide la transaction quand tout réussit (QUA-04)', async () => {
    const pool = fakePool([{ rows: [] }, { rows: [{ id: 1 }] }, { rows: [] }])
    const resultat = await withTransaction(pool, async (client) => {
      const { rows } = await client.query('INSERT INTO t VALUES ($1) RETURNING id', [1])
      return rows[0]
    })

    expect(resultat).toEqual({ id: 1 })
    expect(pool.sqls).toEqual(['BEGIN', 'INSERT INTO t VALUES ($1) RETURNING id', 'COMMIT'])
  })

  it('annule la transaction dès qu’une étape échoue', async () => {
    const pool = fakePool([{ rows: [] }, new Error('contrainte violée'), { rows: [] }])

    await expect(
      withTransaction(pool, async (client) => {
        await client.query('INSERT INTO t VALUES ($1)', [1])
      })
    ).rejects.toThrow('contrainte violée')

    expect(pool.sqls).toContain('ROLLBACK')
    expect(pool.sqls).not.toContain('COMMIT')
  })
})

describe('délai maximal des sondes', () => {
  it('échoue explicitement si la dépendance ne répond pas à temps', async () => {
    const jamais = new Promise(() => {})
    await expect(withTimeout(jamais, 20, 'postgres')).rejects.toThrow(/Délai dépassé/)
  })

  it('retourne la valeur quand la dépendance répond', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 100, 'postgres')).resolves.toBe('ok')
  })
})

describe('nom de fichier téléversé (SEC-07)', () => {
  it("n'extrait qu'une extension, jamais un chemin", () => {
    expect(safeFilename('../../etc/passwd.pdf').extension).toBe('.pdf')
    expect(safeFilename('C:\\Windows\\System32\\payload.docx').extension).toBe('.docx')
    expect(safeFilename('sans-extension').extension).toBe('')
  })
})

describe('filets de sécurité du processus (QUA-01)', () => {
  it('journalise et sort proprement sur un rejet non géré', () => {
    const sorties = []
    const journal = []
    const logger = {
      ...silentLogger(),
      error: (msg, ctx) => journal.push({ msg, ctx })
    }

    const avant = process.listenerCount('unhandledRejection')
    installProcessGuards(logger, { exit: (code) => sorties.push(code) })

    process.emit('unhandledRejection', new Error('promesse orpheline'))

    expect(sorties).toEqual([1])
    expect(journal[0].msg).toMatch(/Rejet de promesse non géré/)

    // Nettoyage : on retire les écouteurs ajoutés par ce test.
    const ajoutes = process.listenerCount('unhandledRejection') - avant
    for (let i = 0; i < ajoutes; i += 1) {
      process.removeListener('unhandledRejection', process.listeners('unhandledRejection').at(-1))
    }
  })
})

describe('cas limites de journalisation et de validation', () => {
  const { createLogger, sanitize } = require('../src/logger')
  const { validate, rules } = require('../src/validate')
  const { healthRouter } = require('../src/health')

  it("n'écrit pas les messages sous le seuil configuré", () => {
    const lignes = []
    const logger = createLogger({ service: 't', level: 'warn', stream: { write: (l) => lignes.push(l) } })
    logger.debug('invisible')
    logger.info('invisible aussi')
    logger.warn('visible')
    expect(lignes).toHaveLength(1)
  })

  it('propage le contexte permanent du journaliseur enfant', () => {
    const lignes = []
    const logger = createLogger({ service: 't', level: 'debug', stream: { write: (l) => lignes.push(l) } })
    const enfant = logger.child({ requestId: 'abc' })
    enfant.debug('d')
    enfant.info('i')
    enfant.warn('w')
    enfant.error('e')
    expect(lignes).toHaveLength(4)
    expect(JSON.parse(lignes[1]).requestId).toBe('abc')
  })

  it('expurge à travers les tableaux et s’arrête en profondeur', () => {
    const sortie = sanitize({ liste: [{ JWT_SECRET: 'x' }, { PORT: 1 }], nul: null })
    expect(sortie.liste[0].JWT_SECRET).toBe('[redacted]')
    expect(sortie.liste[1].PORT).toBe(1)
    expect(sortie.nul).toBeNull()
  })

  it('masque une valeur qui n’est pas une adresse e-mail valide', () => {
    expect(sanitize({ email: 'pas-une-adresse' }).email).toBe('[redacted]')
  })

  it('applique les bornes des règles entières et de longueur', () => {
    expect(() => rules.integer(42, 'mois', { min: 1, max: 12 })).toThrow()
    expect(rules.integer(6, 'mois', { min: 1, max: 12 })).toBe(6)
    expect(() => rules.string('abc', 'code', { pattern: /^\d+$/ })).toThrow()
    expect(rules.string('123', 'code', { pattern: /^\d+$/ })).toBe('123')
  })

  it('rejette un corps de requête qui n’est pas un objet', () => {
    expect(() => validate(null, { a: ['id'] })).toThrow(/Corps de requête invalide/)
  })

  it('refuse un schéma s’appuyant sur une règle inconnue', () => {
    expect(() => validate({ a: 1 }, { a: ['inexistante'] })).toThrow(/Règle de validation inconnue/)
  })

  it('accepte un identifiant au format UUID', () => {
    const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
    expect(rules.id(uuid, 'id')).toBe(uuid)
  })

  it('reste disponible malgré une dépendance non critique en échec', async () => {
    const a = createApp({ logger: silentLogger(), allowedOrigins: '' })
    a.use(
      healthRouter({
        service: 't',
        dependencies: [
          { name: 'postgres', check: async () => true },
          { name: 'cache', critical: false, check: () => Promise.reject(new Error('froid')) }
        ]
      })
    )
    a.use(errorHandler(silentLogger()))

    const reponse = await request(a).get('/health/ready')
    expect(reponse.status).toBe(200)
    expect(reponse.body.dependencies.find((d) => d.name === 'cache').status).toBe('down')
  })
})

describe('erreurs applicatives', () => {
  it('expose les fabriques attendues avec le bon statut', () => {
    expect(AppError.badRequest('x').status).toBe(400)
    expect(AppError.unauthorized().status).toBe(401)
    expect(AppError.forbidden().status).toBe(403)
    expect(AppError.notFound().status).toBe(404)
    expect(AppError.conflict('x').status).toBe(409)
    expect(AppError.tooManyRequests().status).toBe(429)
    expect(AppError.internal().status).toBe(500)
  })

  it('transporte les détails jusqu’à la réponse', async () => {
    const a = createApp({ logger: silentLogger(), allowedOrigins: '' })
    a.get(
      '/conflit',
      asyncHandler(async () => {
        throw AppError.conflict('Solde insuffisant', { disponible: 3 })
      })
    )
    a.use(errorHandler(silentLogger()))

    const reponse = await request(a).get('/conflit')
    expect(reponse.status).toBe(409)
    expect(reponse.body.error.details).toEqual({ disponible: 3 })
  })
})
