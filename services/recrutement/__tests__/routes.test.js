'use strict'

const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const request = require('supertest')
const { fakePool, testConfig, bearer, silentLogger } = require('@hrflow/shared')
const { createRecrutementApp } = require('../src/app')

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(128, 0x20)])

let repertoire

function construire(reponses) {
  const requetes = []
  const pool = fakePool((sql, params) => {
    requetes.push({ sql, params })
    return reponses ? reponses(sql, params) : { rows: [] }
  })
  const app = createRecrutementApp({
    pool,
    config: testConfig({ UPLOAD_DIR: repertoire }),
    logger: silentLogger('recrutement')
  })
  return { app, pool, requetes }
}

function reponsesNominales(overrides = {}) {
  return (sql) => {
    if (/INSERT INTO candidats/.test(sql)) {
      return { rows: [{ id: 900, nom: 'Dupont', prenom: 'Marie', statut: 'recu' }] }
    }
    if (/FROM candidats/.test(sql)) return { rows: overrides.liste ?? [] }
    if (/UPDATE candidats/.test(sql)) return { rows: overrides.maj ?? [{ id: 900, statut: 'entretien' }] }
    if (/SELECT 1 AS ok/.test(sql)) return { rows: [{ ok: 1 }] }
    return { rows: [] }
  }
}

const RH = () => bearer({ role: 'rh', companyId: '100' })

beforeEach(async () => {
  repertoire = await fs.mkdtemp(path.join(os.tmpdir(), 'hrflow-routes-'))
})

afterEach(async () => {
  await fs.rm(repertoire, { recursive: true, force: true })
})

describe('POST /recrutement/candidat — contrôle d’accès (SEC-08)', () => {
  it('refuse un dépôt anonyme', async () => {
    const { app } = construire(reponsesNominales())
    const reponse = await request(app).post('/recrutement/candidat').field('nom', 'Dupont').attach('cv', PDF, 'cv.pdf')

    expect(reponse.status).toBe(401)
  })

  it('refuse un rôle non habilité', async () => {
    const { app } = construire(reponsesNominales())
    const reponse = await request(app)
      .post('/recrutement/candidat')
      .set('Authorization', bearer({ role: 'salarie' }))
      .field('nom', 'Dupont')
      .attach('cv', PDF, 'cv.pdf')

    expect(reponse.status).toBe(403)
  })
})

describe('POST /recrutement/candidat — téléversement (SEC-07)', () => {
  function requeteValide(app) {
    return request(app)
      .post('/recrutement/candidat')
      .set('Authorization', RH())
      .field('nom', 'Dupont')
      .field('prenom', 'Marie')
      .field('email', 'marie.dupont@example.org')
      .field('poste', 'Développeuse')
  }

  it('accepte un CV PDF valide', async () => {
    const { app } = construire(reponsesNominales())
    const reponse = await requeteValide(app).attach('cv', PDF, 'mon-cv.pdf')

    expect(reponse.status).toBe(201)
    expect(reponse.body.id).toBe(900)
  })

  it('neutralise un nom de fichier de traversée de répertoire', async () => {
    const { app, requetes } = construire(reponsesNominales())
    await requeteValide(app).attach('cv', PDF, '../../../var/www/hrflow/public/shell.pdf')

    const insertion = requetes.find((r) => /INSERT INTO candidats/.test(r.sql))
    const nomStocke = insertion.params[5]

    // Le nom stocké est généré, sans aucune trace du chemin fourni.
    expect(nomStocke).toMatch(/^[0-9a-f-]{36}\.pdf$/)
    expect(nomStocke).not.toContain('..')
    expect(nomStocke).not.toContain('/')

    // Le fichier a bien été écrit dans le répertoire prévu, et lui seul.
    const fichiers = await fs.readdir(repertoire)
    expect(fichiers).toEqual([nomStocke])
  })

  it('refuse un fichier dont le contenu ne correspond pas au type annoncé', async () => {
    const { app } = construire(reponsesNominales())
    // En-tête d'exécutable Windows, reconstitué par octets (voir uploads.test.js).
    const executable = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.alloc(32, 0x00)])
    const reponse = await requeteValide(app).attach('cv', executable, {
      filename: 'cv.pdf',
      contentType: 'application/pdf'
    })

    expect(reponse.status).toBe(400)
    expect(await fs.readdir(repertoire)).toEqual([])
  })

  it('refuse un type de fichier non autorisé', async () => {
    const { app } = construire(reponsesNominales())
    const reponse = await requeteValide(app).attach('cv', Buffer.from('contenu de script'), {
      filename: 'cv.sh',
      contentType: 'application/x-sh'
    })

    expect(reponse.status).toBe(400)
  })

  it('refuse une candidature sans CV', async () => {
    const { app } = construire(reponsesNominales())
    const reponse = await requeteValide(app)
    expect(reponse.status).toBe(400)
  })

  it('valide les champs du formulaire', async () => {
    const { app } = construire(reponsesNominales())
    const reponse = await request(app)
      .post('/recrutement/candidat')
      .set('Authorization', RH())
      .field('nom', 'Dupont')
      .field('prenom', 'Marie')
      .field('email', 'pas-une-adresse')
      .field('poste', 'Développeuse')
      .attach('cv', PDF, 'cv.pdf')

    expect(reponse.status).toBe(400)
  })

  it('conserve le nom d’origine comme simple libellé', async () => {
    const { app, requetes } = construire(reponsesNominales())
    await requeteValide(app).attach('cv', PDF, 'CV Marie Dupont.pdf')

    const insertion = requetes.find((r) => /INSERT INTO candidats/.test(r.sql))
    expect(insertion.params[6]).toBe('CV Marie Dupont.pdf')
  })
})

describe('GET /recrutement/candidats — pagination (QUA-11)', () => {
  it('exige une authentification', async () => {
    const { app } = construire(reponsesNominales())
    expect((await request(app).get('/recrutement/candidats')).status).toBe(401)
  })

  it('applique une taille de page par défaut', async () => {
    const { app, requetes } = construire(reponsesNominales())
    await request(app).get('/recrutement/candidats').set('Authorization', RH())

    const lecture = requetes.find((r) => /FROM candidats/.test(r.sql))
    expect(lecture.params[2]).toBe(25)
  })

  it('plafonne une taille de page excessive', async () => {
    const { app, requetes } = construire(reponsesNominales())
    await request(app).get('/recrutement/candidats?limit=100000').set('Authorization', RH())

    const lecture = requetes.find((r) => /FROM candidats/.test(r.sql))
    expect(lecture.params[2]).toBe(100)
  })

  it('filtre par entreprise', async () => {
    const { app, requetes } = construire(reponsesNominales())
    await request(app)
      .get('/recrutement/candidats')
      .set('Authorization', bearer({ role: 'rh', companyId: '777' }))

    const lecture = requetes.find((r) => /FROM candidats/.test(r.sql))
    expect(lecture.params[0]).toBe('777')
  })

  it('accepte un filtre de statut valide', async () => {
    const { app, requetes } = construire(reponsesNominales())
    const reponse = await request(app).get('/recrutement/candidats?statut=entretien').set('Authorization', RH())

    expect(reponse.status).toBe(200)
    expect(requetes.find((r) => /FROM candidats/.test(r.sql)).params[1]).toBe('entretien')
  })

  it('refuse un filtre de statut inconnu', async () => {
    const { app } = construire(reponsesNominales())
    const reponse = await request(app).get('/recrutement/candidats?statut=nimporte').set('Authorization', RH())
    expect(reponse.status).toBe(400)
  })

  it('renvoie le total avec les éléments', async () => {
    const { app } = construire(
      reponsesNominales({
        liste: [
          { id: 1, nom: 'A', total: '3' },
          { id: 2, nom: 'B', total: '3' }
        ]
      })
    )
    const reponse = await request(app).get('/recrutement/candidats').set('Authorization', RH())

    expect(reponse.body.total).toBe(3)
    expect(reponse.body.items[0].total).toBeUndefined()
  })
})

describe('PATCH /recrutement/candidat/:id/statut — autorisation (SEC-08)', () => {
  it('refuse un appel anonyme — n’importe qui pouvait modifier un statut', async () => {
    const { app } = construire(reponsesNominales())
    const reponse = await request(app).patch('/recrutement/candidat/900/statut').send({ statut: 'accepte' })
    expect(reponse.status).toBe(401)
  })

  it('refuse un rôle non habilité', async () => {
    const { app } = construire(reponsesNominales())
    const reponse = await request(app)
      .patch('/recrutement/candidat/900/statut')
      .set('Authorization', bearer({ role: 'salarie' }))
      .send({ statut: 'accepte' })

    expect(reponse.status).toBe(403)
  })

  it('accepte un statut valide d’un rôle habilité', async () => {
    const { app } = construire(reponsesNominales())
    const reponse = await request(app)
      .patch('/recrutement/candidat/900/statut')
      .set('Authorization', RH())
      .send({ statut: 'entretien' })

    expect(reponse.status).toBe(200)
  })

  it('refuse un statut hors énumération', async () => {
    const { app } = construire(reponsesNominales())
    const reponse = await request(app)
      .patch('/recrutement/candidat/900/statut')
      .set('Authorization', RH())
      .send({ statut: 'embauché_directement' })

    expect(reponse.status).toBe(400)
  })

  it('renvoie 404 pour une candidature d’une autre entreprise', async () => {
    const { app } = construire(reponsesNominales({ maj: [] }))
    const reponse = await request(app)
      .patch('/recrutement/candidat/900/statut')
      .set('Authorization', RH())
      .send({ statut: 'refuse' })

    expect(reponse.status).toBe(404)
  })

  it('journalise l’auteur de la modification', async () => {
    const { app, requetes } = construire(reponsesNominales())
    await request(app)
      .patch('/recrutement/candidat/900/statut')
      .set('Authorization', bearer({ role: 'rh', userId: '55', companyId: '100' }))
      .send({ statut: 'accepte' })

    const maj = requetes.find((r) => /UPDATE candidats/.test(r.sql))
    expect(maj.params[1]).toBe('55')
  })
})
