'use strict'

const request = require('supertest')
const { fakePool, testConfig, bearer, silentLogger } = require('@hrflow/shared')
const { createCongesApp } = require('../src/app')

function construire(reponses) {
  const requetes = []
  const pool = fakePool((sql, params) => {
    requetes.push({ sql, params })
    return typeof reponses === 'function' ? reponses(sql, params) : { rows: [], rowCount: 0 }
  })
  const app = createCongesApp({ pool, config: testConfig(), logger: silentLogger('conges') })
  return { app, pool, requetes }
}

const SOLDE_PAR_DEFAUT = { jours_acquis: 25, jours_pris: 5, jours_en_attente: 2 }

function reponsesNominales(overrides = {}) {
  return (sql) => {
    if (/GROUP BY e.jours_conges_acquis/.test(sql)) return { rows: [overrides.solde ?? SOLDE_PAR_DEFAUT] }
    if (/FOR UPDATE/.test(sql)) return { rows: overrides.employe ?? [{ jours_conges_acquis: 25 }] }
    if (/statut IN \('en_attente', 'approuve'\)/.test(sql)) return { rows: overrides.conflits ?? [] }
    if (/COALESCE\(SUM\(nombre_jours\)/.test(sql)) return { rows: overrides.compteurs ?? [{ pris: 5, attente: 2 }] }
    if (/INSERT INTO conges/.test(sql)) {
      return { rows: [{ id: 42, employee_id: 10, nombre_jours: 5, statut: 'en_attente' }] }
    }
    if (/UPDATE conges/.test(sql)) return { rows: overrides.decision ?? [{ id: 42, statut: 'approuve' }] }
    if (/SELECT 1 AS ok/.test(sql)) return { rows: [{ ok: 1 }] }
    return { rows: [] }
  }
}

describe('GET /conges/solde/:employeeId — contrôle d’accès (SEC-06, SEC-08)', () => {
  it('refuse une requête sans jeton', async () => {
    const { app } = construire(reponsesNominales())
    expect((await request(app).get('/conges/solde/10')).status).toBe(401)
  })

  it('refuse à un salarié le solde d’un autre salarié', async () => {
    const { app } = construire(reponsesNominales())
    const reponse = await request(app)
      .get('/conges/solde/99')
      .set('Authorization', bearer({ role: 'salarie', employeeId: '10' }))

    expect(reponse.status).toBe(403)
  })

  it('autorise un salarié à consulter son propre solde', async () => {
    const { app } = construire(reponsesNominales())
    const reponse = await request(app)
      .get('/conges/solde/10')
      .set('Authorization', bearer({ role: 'salarie', employeeId: '10' }))

    expect(reponse.status).toBe(200)
    expect(reponse.body).toMatchObject({ joursAcquis: 25, joursPris: 5, soldeDisponible: 18 })
  })

  it('autorise le service RH sur n’importe quel salarié de son entreprise', async () => {
    const { app } = construire(reponsesNominales())
    const reponse = await request(app)
      .get('/conges/solde/99')
      .set('Authorization', bearer({ role: 'rh', employeeId: '1' }))

    expect(reponse.status).toBe(200)
  })

  it('filtre systématiquement par entreprise (cloisonnement multi-locataire)', async () => {
    const { app, requetes } = construire(reponsesNominales())
    await request(app)
      .get('/conges/solde/10')
      .set('Authorization', bearer({ role: 'rh', companyId: '100' }))

    const lecture = requetes.find((r) => /GROUP BY/.test(r.sql))
    expect(lecture.sql).toContain('e.company_id = $2')
    expect(lecture.params).toEqual(['10', '100'])
  })

  it('renvoie 404 pour un salarié inexistant dans l’entreprise', async () => {
    const { app } = construire(() => ({ rows: [] }))
    const reponse = await request(app)
      .get('/conges/solde/10')
      .set('Authorization', bearer({ role: 'rh' }))
    expect(reponse.status).toBe(404)
  })

  it('rejette un identifiant non conforme sans requêter la base (SEC-02)', async () => {
    const { app, requetes } = construire(reponsesNominales())
    const reponse = await request(app)
      .get('/conges/solde/1%3B%20DROP%20TABLE%20conges')
      .set('Authorization', bearer({ role: 'rh' }))

    expect(reponse.status).toBe(400)
    expect(requetes.some((r) => /GROUP BY/.test(r.sql))).toBe(false)
  })
})

describe('POST /conges/demande', () => {
  const jeton = () => bearer({ role: 'salarie', employeeId: '10', companyId: '100' })

  it('exige une authentification', async () => {
    const { app } = construire(reponsesNominales())
    const reponse = await request(app).post('/conges/demande').send({ dateDebut: '2024-06-10', dateFin: '2024-06-14' })

    expect(reponse.status).toBe(401)
  })

  it('enregistre une demande valide', async () => {
    const { app } = construire(reponsesNominales())
    const reponse = await request(app)
      .post('/conges/demande')
      .set('Authorization', jeton())
      .send({ dateDebut: '2024-06-10', dateFin: '2024-06-14', motif: 'Vacances' })

    expect(reponse.status).toBe(201)
    expect(reponse.body.id).toBe(42)
  })

  it('ignore un employeeId fourni dans le corps et retient celui du jeton', async () => {
    const { app, requetes } = construire(reponsesNominales())
    await request(app)
      .post('/conges/demande')
      .set('Authorization', jeton())
      .send({ employeeId: '999', dateDebut: '2024-06-10', dateFin: '2024-06-14', motif: 'x' })

    const insertion = requetes.find((r) => /INSERT INTO conges/.test(r.sql))
    expect(insertion.params[0]).toBe('10')
    expect(insertion.params).not.toContain('999')
  })

  it('refuse des dates inversées (QUA-05)', async () => {
    const { app } = construire(reponsesNominales())
    const reponse = await request(app)
      .post('/conges/demande')
      .set('Authorization', jeton())
      .send({ dateDebut: '2024-06-14', dateFin: '2024-06-10', motif: 'x' })

    expect(reponse.status).toBe(400)
  })

  it('refuse une période qui chevauche une demande existante', async () => {
    const { app } = construire(
      reponsesNominales({ conflits: [{ id: 7, date_debut: '2024-06-12', date_fin: '2024-06-13' }] })
    )
    const reponse = await request(app)
      .post('/conges/demande')
      .set('Authorization', jeton())
      .send({ dateDebut: '2024-06-10', dateFin: '2024-06-14', motif: 'x' })

    expect(reponse.status).toBe(409)
    expect(reponse.body.error.details.conflit.id).toBe(7)
  })

  it('refuse une demande supérieure au solde disponible', async () => {
    const { app } = construire(reponsesNominales({ compteurs: [{ pris: 20, attente: 3 }] }))
    const reponse = await request(app)
      .post('/conges/demande')
      .set('Authorization', jeton())
      .send({ dateDebut: '2024-06-10', dateFin: '2024-06-14', motif: 'x' })

    expect(reponse.status).toBe(409)
    expect(reponse.body.error.details).toEqual({ demande: 5, disponible: 2 })
  })

  it('ouvre une transaction et pose un verrou sur le salarié (QUA-04)', async () => {
    const { app, requetes } = construire(reponsesNominales())
    await request(app)
      .post('/conges/demande')
      .set('Authorization', jeton())
      .send({ dateDebut: '2024-06-10', dateFin: '2024-06-14', motif: 'x' })

    const sqls = requetes.map((r) => r.sql)
    expect(sqls[0]).toBe('BEGIN')
    expect(sqls.some((s) => /FOR UPDATE/.test(s))).toBe(true)
    expect(sqls.at(-1)).toBe('COMMIT')
  })

  it('annule la transaction quand une règle métier bloque', async () => {
    const { app, requetes } = construire(reponsesNominales({ compteurs: [{ pris: 25, attente: 0 }] }))
    await request(app)
      .post('/conges/demande')
      .set('Authorization', jeton())
      .send({ dateDebut: '2024-06-10', dateFin: '2024-06-14', motif: 'x' })

    expect(requetes.map((r) => r.sql)).toContain('ROLLBACK')
  })

  it('refuse un compte non rattaché à un salarié', async () => {
    const { app } = construire(reponsesNominales())
    const jetonSansSalarie = bearer({ role: 'admin', employeeId: '', companyId: '100' })
    const reponse = await request(app)
      .post('/conges/demande')
      .set('Authorization', jetonSansSalarie)
      .send({ dateDebut: '2024-06-10', dateFin: '2024-06-14', motif: 'x' })

    expect(reponse.status).toBe(403)
  })

  it('renvoie 404 si le salarié du jeton n’existe pas dans l’entreprise', async () => {
    const { app } = construire(reponsesNominales({ employe: [] }))
    const reponse = await request(app)
      .post('/conges/demande')
      .set('Authorization', jeton())
      .send({ dateDebut: '2024-06-10', dateFin: '2024-06-14', motif: 'x' })

    expect(reponse.status).toBe(404)
  })
})

describe('PATCH /conges/:id/decision', () => {
  it('refuse un salarié qui tenterait de valider sa propre demande', async () => {
    const { app } = construire(reponsesNominales())
    const reponse = await request(app)
      .patch('/conges/42/decision')
      .set('Authorization', bearer({ role: 'salarie' }))
      .send({ decision: 'approuve' })

    expect(reponse.status).toBe(403)
  })

  it('accepte une décision d’un rôle habilité', async () => {
    const { app } = construire(reponsesNominales())
    const reponse = await request(app)
      .patch('/conges/42/decision')
      .set('Authorization', bearer({ role: 'manager' }))
      .send({ decision: 'approuve' })

    expect(reponse.status).toBe(200)
  })

  it('refuse une valeur de décision hors énumération', async () => {
    const { app } = construire(reponsesNominales())
    const reponse = await request(app)
      .patch('/conges/42/decision')
      .set('Authorization', bearer({ role: 'rh' }))
      .send({ decision: 'valide_stp' })

    expect(reponse.status).toBe(400)
  })

  it('renvoie 404 pour une demande déjà traitée', async () => {
    const { app } = construire(reponsesNominales({ decision: [] }))
    const reponse = await request(app)
      .patch('/conges/42/decision')
      .set('Authorization', bearer({ role: 'rh' }))
      .send({ decision: 'refuse' })

    expect(reponse.status).toBe(404)
  })
})

describe('GET /conges — liste paginée', () => {
  it('exige un rôle habilité', async () => {
    const { app } = construire(reponsesNominales())
    expect(
      (
        await request(app)
          .get('/conges')
          .set('Authorization', bearer({ role: 'salarie' }))
      ).status
    ).toBe(403)
  })

  it('plafonne la taille de page demandée', async () => {
    const { app, requetes } = construire(reponsesNominales())
    await request(app)
      .get('/conges?limit=5000')
      .set('Authorization', bearer({ role: 'rh' }))

    const lecture = requetes.find((r) => /FROM conges\s+WHERE company_id/.test(r.sql))
    expect(lecture.params[1]).toBe(200)
  })
})

describe('SEC-05 — la route de debug a disparu', () => {
  it('GET /conges/debug/all renvoie 404 et n’expose plus rien', async () => {
    const { app } = construire(reponsesNominales())
    const reponse = await request(app).get('/conges/debug/all')

    expect(reponse.status).toBe(404)
    expect(Array.isArray(reponse.body)).toBe(false)
  })

  it('reste inaccessible même avec un jeton administrateur', async () => {
    const { app } = construire(reponsesNominales())
    const reponse = await request(app)
      .get('/conges/debug/all')
      .set('Authorization', bearer({ role: 'admin' }))
    expect(reponse.status).toBe(404)
  })
})
