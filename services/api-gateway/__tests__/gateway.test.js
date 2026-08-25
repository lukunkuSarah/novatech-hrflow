'use strict'

const request = require('supertest')
const { testConfig, bearer, silentLogger } = require('@hrflow/shared')
const { createGatewayApp, estPublique } = require('../src/app')

/**
 * Tests de la passerelle.
 *
 * Le point central : le middleware d'authentification, commenté « temporairement »
 * en mars 2024 et jamais remis (SEC-06). Ces tests le rendent impossible à
 * recommenter sans casser le pipeline.
 */

function construire({ fetchImpl = async () => ({ ok: true }), config = {} } = {}) {
  return createGatewayApp({
    config: testConfig({
      AUTH_URL: 'http://127.0.0.1:59001',
      PAIE_URL: 'http://127.0.0.1:59002',
      CONGES_URL: 'http://127.0.0.1:59003',
      RECRUTEMENT_URL: 'http://127.0.0.1:59004',
      ...config
    }),
    logger: silentLogger('api-gateway'),
    fetchImpl
  })
}

describe('authentification à la passerelle (SEC-06)', () => {
  it.each([
    ['/api/paie/calculer', 'post'],
    ['/api/conges/solde/10', 'get'],
    ['/api/recrutement/candidats', 'get']
  ])('refuse %s sans jeton', async (chemin, methode) => {
    const app = construire()
    const reponse = await request(app)[methode](chemin)
    expect(reponse.status).toBe(401)
  })

  it('refuse un jeton invalide', async () => {
    const app = construire()
    const reponse = await request(app).get('/api/conges/solde/10').set('Authorization', 'Bearer pas-un-jeton')
    expect(reponse.status).toBe(401)
  })

  it('laisse passer la connexion, qui sert précisément à obtenir un jeton', () => {
    expect(estPublique({ method: 'POST', path: '/api/auth/login' })).toBe(true)
    expect(estPublique({ method: 'POST', path: '/api/auth/refresh' })).toBe(true)
    expect(estPublique({ method: 'POST', path: '/api/auth/password-reset/request' })).toBe(true)
  })

  it("ne rend pas publique une route d'authentification non listée", () => {
    expect(estPublique({ method: 'POST', path: '/api/auth/logout' })).toBe(false)
    expect(estPublique({ method: 'GET', path: '/api/auth/login' })).toBe(false)
    expect(estPublique({ method: 'POST', path: '/api/paie/calculer' })).toBe(false)
  })

  it('transmet la requête au service quand le jeton est valide', async () => {
    const app = construire()
    // Aucun service n'écoute sur le port de test : la passerelle doit répondre
    // 502, ce qui prouve que la requête a franchi l'authentification.
    const reponse = await request(app)
      .get('/api/conges/solde/10')
      .set('Authorization', bearer({ role: 'rh' }))

    expect(reponse.status).toBe(502)
    expect(reponse.body.error.code).toBe('BAD_GATEWAY')
  })
})

describe('propagation vers le service en aval', () => {
  const http = require('http')
  let serveur
  let port

  beforeAll(async () => {
    serveur = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ url: req.url, headers: req.headers }))
    })
    await new Promise((resolve) => serveur.listen(0, '127.0.0.1', resolve))
    port = serveur.address().port
  })

  afterAll(async () => {
    await new Promise((resolve) => serveur.close(resolve))
  })

  it('retire le préfixe /api/conges avant de transmettre', async () => {
    const app = construire({ config: { CONGES_URL: `http://127.0.0.1:${port}` } })
    const reponse = await request(app)
      .get('/api/conges/solde/10')
      .set('Authorization', bearer({ role: 'rh' }))

    expect(reponse.status).toBe(200)
    expect(reponse.body.url).toBe('/conges/solde/10')
  })

  it("propage l'identifiant de corrélation et l'identité vérifiée", async () => {
    const app = construire({ config: { CONGES_URL: `http://127.0.0.1:${port}` } })
    const reponse = await request(app)
      .get('/api/conges/solde/10')
      .set('X-Request-Id', 'trace-integration-1')
      .set('Authorization', bearer({ role: 'rh', userId: '55', companyId: '100' }))

    expect(reponse.body.headers['x-request-id']).toBe('trace-integration-1')
    expect(reponse.body.headers['x-user-id']).toBe('55')
    expect(reponse.body.headers['x-company-id']).toBe('100')
  })

  it('transmet aussi le chemin racine du préfixe', async () => {
    const app = construire({ config: { CONGES_URL: `http://127.0.0.1:${port}` } })
    const reponse = await request(app)
      .get('/api/conges')
      .set('Authorization', bearer({ role: 'rh' }))

    expect(reponse.status).toBe(200)
    expect(reponse.body.url).toBe('/conges')
  })

  it("n'ajoute pas d'en-tête d'identité sur une route publique", async () => {
    const app = construire({ config: { AUTH_URL: `http://127.0.0.1:${port}` } })
    const reponse = await request(app).post('/api/auth/login').send({ email: 'a@b.io', password: 'x' })

    expect(reponse.status).toBe(200)
    expect(reponse.body.url).toBe('/auth/login')
    // Aucune identité vérifiée à ce stade : la passerelle n'en invente pas.
    expect(reponse.body.headers['x-user-id']).toBeUndefined()
    expect(reponse.body.headers['x-request-id']).toBeDefined()
  })

  it("transmet l'en-tête Authorization pour que le service revérifie lui-même", async () => {
    // Défense en profondeur : la passerelle ne se substitue pas au service.
    const app = construire({ config: { CONGES_URL: `http://127.0.0.1:${port}` } })
    const reponse = await request(app)
      .get('/api/conges/solde/10')
      .set('Authorization', bearer({ role: 'rh' }))

    expect(reponse.body.headers.authorization).toMatch(/^Bearer /)
  })
})

describe('service en aval indisponible (SEC-12)', () => {
  it("ne divulgue ni trace d'exécution ni adresse interne", async () => {
    const app = construire()
    const reponse = await request(app)
      .get('/api/paie/bulletins/10')
      .set('Authorization', bearer({ role: 'rh' }))

    const corps = JSON.stringify(reponse.body)
    expect(corps).not.toContain('127.0.0.1')
    expect(corps).not.toContain('ECONNREFUSED')
    expect(reponse.body.error.stack).toBeUndefined()
    expect(reponse.body.error.requestId).toBeDefined()
  })
})

describe('sonde de santé agrégée (INF-01)', () => {
  it('répond 200 quand tous les services répondent', async () => {
    const app = construire({ fetchImpl: async () => ({ ok: true }) })
    const reponse = await request(app).get('/health/ready')

    expect(reponse.status).toBe(200)
    expect(reponse.body.dependencies).toHaveLength(4)
    expect(reponse.body.dependencies.every((d) => d.status === 'up')).toBe(true)
  })

  it('répond 503 dès qu’un service est en panne — plus de 200 systématique', async () => {
    const app = construire({
      fetchImpl: async (url) => (url.includes('59002') ? { ok: false, status: 500 } : { ok: true })
    })
    const reponse = await request(app).get('/health/ready')

    expect(reponse.status).toBe(503)
    expect(reponse.body.dependencies.find((d) => d.name === 'paie').status).toBe('down')
  })

  it('répond 503 quand un service est injoignable', async () => {
    const app = construire({
      fetchImpl: async () => {
        throw new Error('connexion refusée')
      }
    })
    expect((await request(app).get('/health/ready')).status).toBe(503)
  })

  it('la sonde de vivacité reste verte même si les services sont tombés', async () => {
    const app = construire({
      fetchImpl: async () => {
        throw new Error('connexion refusée')
      }
    })
    const reponse = await request(app).get('/health/live')

    // Distinction essentielle : un service vivant mais non prêt ne doit pas
    // être redémarré en boucle par l'orchestrateur.
    expect(reponse.status).toBe(200)
    expect(reponse.body.status).toBe('alive')
  })

  it('la sonde de santé reste accessible sans authentification', async () => {
    const app = construire()
    expect((await request(app).get('/health/live')).status).toBe(200)
  })
})

describe('CORS et en-têtes (SEC-11, SEC-17)', () => {
  it('refuse une origine non déclarée', async () => {
    const app = construire()
    const reponse = await request(app).get('/health/live').set('Origin', 'https://exfiltration.example')
    expect(reponse.status).toBe(403)
  })

  it("n'émet jamais Access-Control-Allow-Origin: *", async () => {
    const app = construire()
    const reponse = await request(app).get('/health/live').set('Origin', 'http://localhost:5173')
    expect(reponse.headers['access-control-allow-origin']).toBe('http://localhost:5173')
  })

  it('pose les en-têtes de sécurité sur toutes les réponses', async () => {
    const app = construire()
    const reponse = await request(app).get('/health/live')
    expect(reponse.headers['x-content-type-options']).toBe('nosniff')
    expect(reponse.headers['x-powered-by']).toBeUndefined()
  })
})

describe('limitation de débit', () => {
  it('bloque au-delà du seuil configuré', async () => {
    const app = construire({ config: { RATE_LIMIT_PAR_MINUTE: '3' } })

    const codes = []
    for (let i = 0; i < 5; i += 1) {
      codes.push((await request(app).get('/api/conges/solde/10')).status)
    }

    expect(codes.at(-1)).toBe(429)
  })
})

describe('routes inconnues', () => {
  it('renvoie 404 sans divulguer la topologie interne', async () => {
    const app = construire()
    const reponse = await request(app).get('/interne/admin')

    expect(reponse.status).toBe(404)
    expect(JSON.stringify(reponse.body)).not.toContain('127.0.0.1')
  })
})
