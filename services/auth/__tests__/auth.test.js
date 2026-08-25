'use strict'

const request = require('supertest')
const bcrypt = require('bcryptjs')
const { fakePool, testConfig, bearer, silentLogger } = require('@hrflow/shared')

const { createAuthApp, hashToken } = require('../src/app')
const { createMemoryMailer } = require('../src/mailer')

/**
 * Tests du service d'authentification.
 *
 * Chaque bloc correspond à un constat de l'audit. Un test qui échouerait ici
 * signifie qu'une vulnérabilité fermée a été rouverte : c'est la raison d'être
 * de la barrière « TEST » du pipeline.
 */

const MOT_DE_PASSE = 'MotDePasseSolide2024'
const HASH = bcrypt.hashSync(MOT_DE_PASSE, 4)

const UTILISATEUR = {
  id: 7,
  email: 'salarie@novatech.io',
  password_hash: HASH,
  role: 'salarie',
  company_id: 100,
  employee_id: 10,
  failed_attempts: 0,
  locked_until: null
}

/** Construit une application de test avec un pool qui répond selon le SQL reçu. */
function construire({ utilisateur = UTILISATEUR, resets = [], refresh = [] } = {}) {
  const requetes = []

  const pool = fakePool((sql, params) => {
    requetes.push({ sql, params })

    if (/FROM users\s+WHERE email = \$1/s.test(sql)) {
      return { rows: utilisateur ? [utilisateur] : [] }
    }
    if (/SELECT id FROM users WHERE email = \$1/.test(sql)) {
      return { rows: utilisateur ? [{ id: utilisateur.id }] : [] }
    }
    if (/FROM password_resets/.test(sql)) {
      return { rows: resets }
    }
    if (/FROM refresh_tokens/.test(sql)) {
      return { rows: refresh }
    }
    return { rows: [], rowCount: 0 }
  })

  const mailer = createMemoryMailer()
  const app = createAuthApp({
    pool,
    config: testConfig(),
    logger: silentLogger('auth'),
    mailer,
    limits: { loginMax: 1000, resetMax: 1000 }
  })

  return { app, pool, mailer, requetes }
}

describe('POST /auth/login — injection SQL (SEC-02)', () => {
  it('utilise une requête paramétrée, jamais une concaténation', async () => {
    const { app, requetes } = construire()

    await request(app).post('/auth/login').send({ email: UTILISATEUR.email, password: MOT_DE_PASSE })

    const requeteUtilisateurs = requetes.find((r) => /FROM users/.test(r.sql))
    expect(requeteUtilisateurs.sql).toContain('$1')
    // La valeur transite par les paramètres, jamais dans le texte de la requête.
    expect(requeteUtilisateurs.sql).not.toContain(UTILISATEUR.email)
    expect(requeteUtilisateurs.params).toEqual([UTILISATEUR.email])
  })

  it("rejette une charge d'injection avant même d'atteindre la base", async () => {
    const { app, requetes } = construire()

    const reponse = await request(app)
      .post('/auth/login')
      .send({ email: "admin@novatech.io' OR '1'='1", password: 'peu importe' })

    expect(reponse.status).toBe(400)
    expect(requetes.filter((r) => /FROM users/.test(r.sql))).toHaveLength(0)
  })

  it('rejette un corps de requête vide sans faire tomber le service (QUA-01)', async () => {
    const { app } = construire()
    const reponse = await request(app).post('/auth/login').send({})
    expect(reponse.status).toBe(400)
  })
})

describe('POST /auth/login — comportement nominal', () => {
  it('émet un jeton d’accès court et un jeton de renouvellement', async () => {
    const { app } = construire()

    const reponse = await request(app).post('/auth/login').send({ email: UTILISATEUR.email, password: MOT_DE_PASSE })

    expect(reponse.status).toBe(200)
    expect(reponse.body.accessToken).toBeDefined()
    expect(reponse.body.refreshToken).toHaveLength(64)
    expect(reponse.body.expiresIn).toBe('15m')
  })

  it("ne renvoie jamais l'empreinte du mot de passe", async () => {
    const { app } = construire()
    const reponse = await request(app).post('/auth/login').send({ email: UTILISATEUR.email, password: MOT_DE_PASSE })

    expect(JSON.stringify(reponse.body)).not.toContain('$2a$')
    expect(reponse.body.user).toEqual({ id: 7, role: 'salarie', companyId: 100, employeeId: 10 })
  })

  it('stocke le jeton de renouvellement sous forme hachée', async () => {
    const { app, requetes } = construire()
    const reponse = await request(app).post('/auth/login').send({ email: UTILISATEUR.email, password: MOT_DE_PASSE })

    const insertion = requetes.find((r) => /INSERT INTO refresh_tokens/.test(r.sql))
    expect(insertion.params[0]).toBe(hashToken(reponse.body.refreshToken))
    expect(insertion.params[0]).not.toBe(reponse.body.refreshToken)
  })
})

describe('POST /auth/login — énumération et force brute (SEC-13)', () => {
  it('renvoie le même message pour un compte inconnu et un mot de passe faux', async () => {
    const inconnu = await request(construire({ utilisateur: null }).app)
      .post('/auth/login')
      .send({ email: 'inconnu@novatech.io', password: MOT_DE_PASSE })

    const mauvais = await request(construire().app)
      .post('/auth/login')
      .send({ email: UTILISATEUR.email, password: 'MauvaisMotDePasse2024' })

    expect(inconnu.status).toBe(401)
    expect(mauvais.status).toBe(401)
    expect(inconnu.body.error.message).toBe(mauvais.body.error.message)
  })

  it('incrémente le compteur d’échecs et verrouille au cinquième', async () => {
    const { app, requetes } = construire({
      utilisateur: { ...UTILISATEUR, failed_attempts: 4 }
    })

    await request(app).post('/auth/login').send({ email: UTILISATEUR.email, password: 'faux' })

    const miseAJour = requetes.find((r) => /SET failed_attempts = \$1, locked_until = \$2/.test(r.sql))
    expect(miseAJour.params[0]).toBe(5)
    expect(miseAJour.params[1]).toBeInstanceOf(Date)
  })

  it('refuse un compte verrouillé sans même comparer le mot de passe', async () => {
    const dansUnQuartDHeure = new Date(Date.now() + 15 * 60 * 1000)
    const { app } = construire({
      utilisateur: { ...UTILISATEUR, locked_until: dansUnQuartDHeure }
    })

    const reponse = await request(app).post('/auth/login').send({ email: UTILISATEUR.email, password: MOT_DE_PASSE })

    expect(reponse.status).toBe(429)
  })

  it('remet le compteur à zéro après une connexion réussie', async () => {
    const { app, requetes } = construire({ utilisateur: { ...UTILISATEUR, failed_attempts: 3 } })

    await request(app).post('/auth/login').send({ email: UTILISATEUR.email, password: MOT_DE_PASSE })

    expect(requetes.some((r) => /SET failed_attempts = 0/.test(r.sql))).toBe(true)
  })

  it('applique la limitation de débit quand le seuil est atteint', async () => {
    const { app: limite } = (() => {
      const base = construire()
      return {
        app: createAuthApp({
          pool: base.pool,
          config: testConfig(),
          logger: silentLogger('auth'),
          mailer: base.mailer,
          limits: { loginMax: 2, windowMs: 60000 }
        })
      }
    })()

    await request(limite).post('/auth/login').send({ email: UTILISATEUR.email, password: 'faux' })
    await request(limite).post('/auth/login').send({ email: UTILISATEUR.email, password: 'faux' })
    const troisieme = await request(limite).post('/auth/login').send({ email: UTILISATEUR.email, password: 'faux' })

    expect(troisieme.status).toBe(429)
  })
})

describe('réinitialisation de mot de passe — prise de contrôle de compte (SEC-03)', () => {
  it("l'ancienne route POST /auth/reset-password n'existe plus", async () => {
    const { app } = construire()
    const reponse = await request(app).post('/auth/reset-password').send({ email: 'admin@novatech.io' })
    expect(reponse.status).toBe(404)
  })

  it('une demande ne modifie aucun mot de passe — elle émet seulement un jeton', async () => {
    const { app, requetes, mailer } = construire()

    const reponse = await request(app).post('/auth/password-reset/request').send({ email: UTILISATEUR.email })

    expect(reponse.status).toBe(200)
    // Aucune écriture sur users : c'était tout le problème de la version d'origine.
    expect(requetes.some((r) => /UPDATE users SET password_hash/.test(r.sql))).toBe(false)
    expect(mailer.sent).toHaveLength(1)
  })

  it('le jeton part par courriel et n’est jamais journalisé (SEC-15)', async () => {
    const lignes = []
    const base = construire()
    const app = createAuthApp({
      pool: base.pool,
      config: testConfig(),
      logger: require('@hrflow/shared').createLogger({
        service: 'auth',
        stream: { write: (l) => lignes.push(l) }
      }),
      mailer: base.mailer,
      limits: { resetMax: 100 }
    })

    await request(app).post('/auth/password-reset/request').send({ email: UTILISATEUR.email })

    const jeton = base.mailer.sent[0].token
    expect(jeton).toHaveLength(64)
    expect(lignes.join('\n')).not.toContain(jeton)
  })

  it('répond la même chose pour une adresse inconnue (pas d’énumération)', async () => {
    const connu = await request(construire().app)
      .post('/auth/password-reset/request')
      .send({ email: UTILISATEUR.email })

    const inconnu = await request(construire({ utilisateur: null }).app)
      .post('/auth/password-reset/request')
      .send({ email: 'personne@novatech.io' })

    expect(connu.status).toBe(inconnu.status)
    expect(connu.body).toEqual(inconnu.body)
  })

  it('refuse un jeton de confirmation inconnu', async () => {
    const { app } = construire({ resets: [] })
    const reponse = await request(app)
      .post('/auth/password-reset/confirm')
      .send({ token: 'a'.repeat(64), newPassword: 'NouveauMotDePasse2024' })

    expect(reponse.status).toBe(400)
  })

  it('refuse un jeton expiré', async () => {
    const { app } = construire({
      resets: [{ user_id: 7, expires_at: new Date(Date.now() - 1000), used_at: null }]
    })
    const reponse = await request(app)
      .post('/auth/password-reset/confirm')
      .send({ token: 'a'.repeat(64), newPassword: 'NouveauMotDePasse2024' })

    expect(reponse.status).toBe(400)
  })

  it('refuse un jeton déjà utilisé', async () => {
    const { app } = construire({
      resets: [{ user_id: 7, expires_at: new Date(Date.now() + 60000), used_at: new Date() }]
    })
    const reponse = await request(app)
      .post('/auth/password-reset/confirm')
      .send({ token: 'a'.repeat(64), newPassword: 'NouveauMotDePasse2024' })

    expect(reponse.status).toBe(400)
  })

  it('accepte un jeton valide, met à jour l’empreinte et révoque les sessions', async () => {
    const { app, requetes } = construire({
      resets: [{ user_id: 7, expires_at: new Date(Date.now() + 60000), used_at: null }]
    })

    const reponse = await request(app)
      .post('/auth/password-reset/confirm')
      .send({ token: 'a'.repeat(64), newPassword: 'NouveauMotDePasse2024' })

    expect(reponse.status).toBe(200)

    const miseAJour = requetes.find((r) => /UPDATE users SET password_hash/.test(r.sql))
    expect(miseAJour.params[0]).toMatch(/^\$2[aby]\$/)
    expect(bcrypt.compareSync('NouveauMotDePasse2024', miseAJour.params[0])).toBe(true)

    expect(requetes.some((r) => /UPDATE refresh_tokens SET revoked_at/.test(r.sql))).toBe(true)
  })

  it('impose une longueur minimale au nouveau mot de passe', async () => {
    const { app } = construire()
    const reponse = await request(app)
      .post('/auth/password-reset/confirm')
      .send({ token: 'a'.repeat(64), newPassword: 'court' })

    expect(reponse.status).toBe(400)
  })
})

describe('POST /auth/refresh', () => {
  it('refuse un jeton de renouvellement inconnu', async () => {
    const { app } = construire({ refresh: [] })
    const reponse = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: 'b'.repeat(64) })
    expect(reponse.status).toBe(401)
  })

  it('refuse un jeton révoqué', async () => {
    const { app } = construire({
      refresh: [
        {
          user_id: 7,
          revoked_at: new Date(),
          expires_at: new Date(Date.now() + 60000),
          role: 'salarie',
          company_id: 100,
          employee_id: 10
        }
      ]
    })
    const reponse = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: 'b'.repeat(64) })
    expect(reponse.status).toBe(401)
  })

  it('émet un nouveau jeton d’accès pour un renouvellement valide', async () => {
    const { app } = construire({
      refresh: [
        {
          user_id: 7,
          revoked_at: null,
          expires_at: new Date(Date.now() + 60000),
          role: 'salarie',
          company_id: 100,
          employee_id: 10
        }
      ]
    })
    const reponse = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: 'b'.repeat(64) })
    expect(reponse.status).toBe(200)
    expect(reponse.body.accessToken).toBeDefined()
  })
})

describe('POST /auth/verify et /auth/logout', () => {
  it('valide un jeton correct', async () => {
    const { app } = construire()
    const connexion = await request(app).post('/auth/login').send({ email: UTILISATEUR.email, password: MOT_DE_PASSE })

    const reponse = await request(app).post('/auth/verify').send({ token: connexion.body.accessToken })
    expect(reponse.status).toBe(200)
    expect(reponse.body.valid).toBe(true)
  })

  it('rejette un jeton falsifié sans expliquer pourquoi', async () => {
    const { app } = construire()
    const reponse = await request(app).post('/auth/verify').send({ token: 'jeton.completement.invalide' })
    expect(reponse.status).toBe(401)
    expect(reponse.body).toEqual({ valid: false })
  })

  it('exige une authentification pour se déconnecter', async () => {
    const { app } = construire()
    expect((await request(app).post('/auth/logout')).status).toBe(401)
  })

  it('révoque les jetons de renouvellement à la déconnexion (SEC-21)', async () => {
    const { app, requetes } = construire()
    const reponse = await request(app)
      .post('/auth/logout')
      .set('Authorization', bearer({ userId: '7' }))

    expect(reponse.status).toBe(204)
    expect(requetes.some((r) => /UPDATE refresh_tokens SET revoked_at/.test(r.sql))).toBe(true)
  })
})

describe('sondes de santé', () => {
  it('signale le service indisponible si la base ne répond pas (INF-01)', async () => {
    const pool = fakePool(() => {
      throw new Error('connexion refusée')
    })
    const app = createAuthApp({
      pool,
      config: testConfig(),
      logger: silentLogger('auth'),
      mailer: createMemoryMailer()
    })

    const reponse = await request(app).get('/health/ready')
    expect(reponse.status).toBe(503)
  })
})
