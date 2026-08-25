'use strict'

const request = require('supertest')
const { fakePool, testConfig, bearer, silentLogger } = require('@hrflow/shared')
const { createPaieApp } = require('../src/app')
const { createMemoryPayouts, createStripePayouts, PayoutError } = require('../src/payouts')

function construire({ reponses, payouts = createMemoryPayouts() } = {}) {
  const requetes = []
  const pool = fakePool((sql, params) => {
    requetes.push({ sql, params })
    return reponses ? reponses(sql, params) : { rows: [] }
  })
  const app = createPaieApp({ pool, config: testConfig(), logger: silentLogger('paie'), payouts })
  return { app, pool, payouts, requetes }
}

function reponsesNominales(overrides = {}) {
  return (sql) => {
    if (/FROM employees/.test(sql))
      return { rows: overrides.employe ?? [{ id: 10, salaire_mensuel_brut: 3000, taux_activite: 1 }] }
    if (/SELECT id, data, statut FROM bulletins_paie/.test(sql)) return { rows: overrides.existants ?? [] }
    if (/INSERT INTO bulletins_paie/.test(sql)) return { rows: [{ id: 501 }] }
    if (/SELECT id, employee_id, periode_reference/.test(sql)) return { rows: overrides.bulletin ?? [] }
    if (/SELECT 1 AS ok/.test(sql)) return { rows: [{ ok: 1 }] }
    return { rows: [] }
  }
}

const RH = () => bearer({ role: 'rh', companyId: '100', employeeId: '1' })

describe('SEC-04 — la route de migration a disparu', () => {
  it('POST /paie/migrate renvoie 404', async () => {
    const { app } = construire({ reponses: reponsesNominales() })
    const reponse = await request(app).post('/paie/migrate').send({})

    // C'est la route qui a provoqué 3 h 07 de coupure le 14 août 2024.
    expect(reponse.status).toBe(404)
  })

  it('reste inaccessible avec un jeton administrateur', async () => {
    const { app } = construire({ reponses: reponsesNominales() })
    const reponse = await request(app)
      .post('/paie/migrate')
      .set('Authorization', bearer({ role: 'admin' }))
      .send({})

    expect(reponse.status).toBe(404)
  })
})

describe('POST /paie/calculer — contrôle d’accès', () => {
  it('refuse une requête anonyme', async () => {
    const { app } = construire({ reponses: reponsesNominales() })
    const reponse = await request(app).post('/paie/calculer').send({ employeeId: '10', mois: 6, annee: 2024 })
    expect(reponse.status).toBe(401)
  })

  it('refuse un salarié qui voudrait déclencher sa propre paie', async () => {
    const { app } = construire({ reponses: reponsesNominales() })
    const reponse = await request(app)
      .post('/paie/calculer')
      .set('Authorization', bearer({ role: 'salarie' }))
      .send({ employeeId: '10', mois: 6, annee: 2024 })

    expect(reponse.status).toBe(403)
  })

  it('refuse un salarié d’une autre entreprise (cloisonnement)', async () => {
    const { app, requetes } = construire({ reponses: reponsesNominales() })
    await request(app)
      .post('/paie/calculer')
      .set('Authorization', bearer({ role: 'rh', companyId: '999' }))
      .send({ employeeId: '10', mois: 6, annee: 2024 })

    const lecture = requetes.find((r) => /FROM employees/.test(r.sql))
    expect(lecture.params).toEqual(['10', '999'])
  })
})

describe('POST /paie/calculer — émission et paiement', () => {
  it('émet le bulletin puis déclenche le virement', async () => {
    const { app, payouts } = construire({ reponses: reponsesNominales() })

    const reponse = await request(app)
      .post('/paie/calculer')
      .set('Authorization', RH())
      .send({ employeeId: '10', mois: 6, annee: 2024 })

    expect(reponse.status).toBe(201)
    expect(reponse.body.statut).toBe('paye')
    expect(reponse.body.net).toBe(2340)
    expect(payouts.ordres.size).toBe(1)
  })

  it('écrit le bulletin dans une transaction (QUA-04)', async () => {
    const { app, requetes } = construire({ reponses: reponsesNominales() })
    await request(app)
      .post('/paie/calculer')
      .set('Authorization', RH())
      .send({ employeeId: '10', mois: 6, annee: 2024 })

    const sqls = requetes.map((r) => r.sql)
    expect(sqls[0]).toBe('BEGIN')
    expect(sqls).toContain('COMMIT')
  })

  it('utilise une clé d’idempotence déterministe (QUA-03)', async () => {
    const { app, payouts } = construire({ reponses: reponsesNominales() })
    await request(app)
      .post('/paie/calculer')
      .set('Authorization', RH())
      .send({ employeeId: '10', mois: 6, annee: 2024 })

    expect([...payouts.ordres.keys()]).toEqual(['hrflow-paie-10-2024-06'])
  })

  it('ne recalcule ni ne repaie un bulletin déjà émis', async () => {
    const { app, payouts } = construire({
      reponses: reponsesNominales({
        existants: [{ id: 501, statut: 'paye', data: { net: 2340, netCentimes: 234000 } }]
      })
    })

    const reponse = await request(app)
      .post('/paie/calculer')
      .set('Authorization', RH())
      .send({ employeeId: '10', mois: 6, annee: 2024 })

    expect(reponse.status).toBe(200)
    expect(reponse.body.idempotent).toBe(true)
    expect(payouts.ordres.size).toBe(0)
  })

  it('refuse une période invalide', async () => {
    const { app } = construire({ reponses: reponsesNominales() })
    const reponse = await request(app)
      .post('/paie/calculer')
      .set('Authorization', RH())
      .send({ employeeId: '10', mois: 13, annee: 2024 })

    expect(reponse.status).toBe(400)
  })

  it('renvoie 404 pour un salarié inconnu', async () => {
    const { app } = construire({ reponses: reponsesNominales({ employe: [] }) })
    const reponse = await request(app)
      .post('/paie/calculer')
      .set('Authorization', RH())
      .send({ employeeId: '10', mois: 6, annee: 2024 })

    expect(reponse.status).toBe(404)
  })

  it('refuse un salarié à temps partiel plutôt que d’émettre un bulletin faux (QUA-02)', async () => {
    const { app } = construire({
      reponses: reponsesNominales({ employe: [{ id: 10, salaire_mensuel_brut: 3000, taux_activite: 0.8 }] })
    })
    const reponse = await request(app)
      .post('/paie/calculer')
      .set('Authorization', RH())
      .send({ employeeId: '10', mois: 6, annee: 2024 })

    expect(reponse.status).toBe(400)
  })
})

describe('échec de virement — plus jamais avalé en silence (QUA-03)', () => {
  it('persiste l’échec et le remonte à l’appelant', async () => {
    const payouts = createMemoryPayouts({ failWith: new PayoutError('carte refusée', { retryable: false }) })
    const { app, requetes } = construire({ reponses: reponsesNominales(), payouts })

    const reponse = await request(app)
      .post('/paie/calculer')
      .set('Authorization', RH())
      .send({ employeeId: '10', mois: 6, annee: 2024 })

    // L'ancienne version renvoyait 200 et un bulletin, salarié non payé.
    expect(reponse.status).toBe(502)
    expect(reponse.body.statut).toBe('paiement_en_echec')

    const miseAJour = requetes.find((r) => /UPDATE bulletins_paie SET statut/.test(r.sql))
    expect(miseAJour.params[0]).toBe('paiement_en_echec')
  })

  it('distingue un échec rejouable d’un échec définitif', async () => {
    const payouts = createMemoryPayouts({ failWith: new PayoutError('service indisponible', { retryable: true }) })
    const { app } = construire({ reponses: reponsesNominales(), payouts })

    const reponse = await request(app)
      .post('/paie/calculer')
      .set('Authorization', RH())
      .send({ employeeId: '10', mois: 6, annee: 2024 })

    expect(reponse.body.statut).toBe('paiement_a_rejouer')
  })
})

describe('POST /paie/bulletins/:id/rejouer-paiement', () => {
  it('rejoue un virement en échec avec la même clé d’idempotence', async () => {
    const { app, payouts } = construire({
      reponses: reponsesNominales({
        bulletin: [
          {
            id: 501,
            employee_id: '10',
            periode_reference: '2024-06',
            statut: 'paiement_a_rejouer',
            data: { netCentimes: 234000 }
          }
        ]
      })
    })

    const reponse = await request(app).post('/paie/bulletins/501/rejouer-paiement').set('Authorization', RH()).send({})

    expect(reponse.status).toBe(200)
    expect(reponse.body.statut).toBe('paye')
    expect([...payouts.ordres.keys()]).toEqual(['hrflow-paie-10-2024-06'])
  })

  it('ne rejoue pas un bulletin déjà payé', async () => {
    const { app, payouts } = construire({
      reponses: reponsesNominales({
        bulletin: [{ id: 501, employee_id: '10', periode_reference: '2024-06', statut: 'paye', data: {} }]
      })
    })

    const reponse = await request(app).post('/paie/bulletins/501/rejouer-paiement').set('Authorization', RH()).send({})

    expect(reponse.body.idempotent).toBe(true)
    expect(payouts.ordres.size).toBe(0)
  })

  it('renvoie 404 pour un bulletin d’une autre entreprise', async () => {
    const { app } = construire({ reponses: reponsesNominales({ bulletin: [] }) })
    const reponse = await request(app).post('/paie/bulletins/501/rejouer-paiement').set('Authorization', RH()).send({})

    expect(reponse.status).toBe(404)
  })
})

describe('GET /paie/bulletins/:employeeId', () => {
  it('autorise un salarié sur ses propres bulletins', async () => {
    const { app } = construire({ reponses: reponsesNominales() })
    const reponse = await request(app)
      .get('/paie/bulletins/10')
      .set('Authorization', bearer({ role: 'salarie', employeeId: '10' }))

    expect(reponse.status).toBe(200)
  })

  it('refuse un salarié sur les bulletins d’un autre (SEC-08)', async () => {
    const { app } = construire({ reponses: reponsesNominales() })
    const reponse = await request(app)
      .get('/paie/bulletins/99')
      .set('Authorization', bearer({ role: 'salarie', employeeId: '10' }))

    expect(reponse.status).toBe(403)
  })

  it('plafonne le nombre de bulletins renvoyés', async () => {
    const { app, requetes } = construire({ reponses: reponsesNominales() })
    await request(app).get('/paie/bulletins/10?limit=9999').set('Authorization', RH())

    const lecture = requetes.find((r) => /FROM bulletins_paie\s+WHERE employee_id/.test(r.sql))
    expect(lecture.params[2]).toBe(60)
  })
})

describe('client de virement Stripe', () => {
  it('refuse de se construire sans clé (SEC-09)', () => {
    expect(() => createStripePayouts({ apiKey: '' })).toThrow(/clé API manquante/)
  })

  it('transmet la clé d’idempotence dans l’en-tête', async () => {
    let appel = null
    const payouts = createStripePayouts({
      apiKey: 'sk_test_x',
      fetchImpl: async (url, options) => {
        appel = { url, options }
        return { ok: true, json: async () => ({ id: 'po_1', status: 'paid' }) }
      }
    })

    await payouts.virer({ montantCentimes: 234000, idempotencyKey: 'hrflow-paie-10-2024-06' })

    expect(appel.options.headers['Idempotency-Key']).toBe('hrflow-paie-10-2024-06')
    expect(appel.options.body.toString()).toContain('amount=234000')
  })

  it('refuse un montant non entier ou négatif', async () => {
    const payouts = createStripePayouts({ apiKey: 'sk_test_x', fetchImpl: async () => ({ ok: true }) })
    await expect(payouts.virer({ montantCentimes: 12.5, idempotencyKey: 'k' })).rejects.toThrow(PayoutError)
    await expect(payouts.virer({ montantCentimes: -1, idempotencyKey: 'k' })).rejects.toThrow(PayoutError)
  })

  it('exige une clé d’idempotence', async () => {
    const payouts = createStripePayouts({ apiKey: 'sk_test_x', fetchImpl: async () => ({ ok: true }) })
    await expect(payouts.virer({ montantCentimes: 100 })).rejects.toThrow(/idempotence/)
  })

  it('marque comme rejouable une erreur temporaire du prestataire', async () => {
    const payouts = createStripePayouts({ apiKey: 'sk_test_x', fetchImpl: async () => ({ ok: false, status: 503 }) })
    await expect(payouts.virer({ montantCentimes: 100, idempotencyKey: 'k' })).rejects.toMatchObject({
      retryable: true
    })
  })

  it('marque comme définitive une erreur de requête', async () => {
    const payouts = createStripePayouts({ apiKey: 'sk_test_x', fetchImpl: async () => ({ ok: false, status: 400 }) })
    await expect(payouts.virer({ montantCentimes: 100, idempotencyKey: 'k' })).rejects.toMatchObject({
      retryable: false
    })
  })
})
