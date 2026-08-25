'use strict'

const request = require('supertest')
const { createMetrics, gabaritDeRoute } = require('../src/metriques')
const { createApp } = require('../src/http')
const { notFoundHandler, errorHandler } = require('../src/errors')
const { silentLogger } = require('../src/testing')

/**
 * Les quatre signaux d'or doivent être mesurables. Ces tests vérifient que
 * l'instrumentation produit réellement les séries attendues — et qu'elle ne
 * fait pas exploser leur cardinalité, défaut classique d'une instrumentation
 * posée trop vite.
 */

function app(metrics) {
  const a = createApp({ logger: silentLogger(), allowedOrigins: '', metrics })
  a.get('/conges/solde/:employeeId', (req, res) => res.json({ solde: 12 }))
  a.get('/panne', (req, res) => res.status(500).json({ erreur: true }))
  a.use(notFoundHandler)
  a.use(errorHandler(silentLogger()))
  return a
}

describe('normalisation des routes — maîtrise de la cardinalité', () => {
  it('remplace un identifiant numérique par un gabarit', () => {
    expect(gabaritDeRoute({ path: '/conges/solde/10' })).toBe('/conges/solde/:id')
    expect(gabaritDeRoute({ path: '/conges/solde/8200' })).toBe('/conges/solde/:id')
  })

  it('remplace un identifiant UUID par un gabarit', () => {
    expect(gabaritDeRoute({ path: '/recrutement/cv/3f2504e0-4f89-11d3-9a0c-0305e82c3301' })).toBe(
      '/recrutement/cv/:uuid'
    )
  })

  it('préfère le gabarit déclaré par Express quand il est disponible', () => {
    expect(gabaritDeRoute({ route: { path: '/solde/:employeeId' }, baseUrl: '/conges' })).toBe(
      '/conges/solde/:employeeId'
    )
  })

  it('laisse intacts les chemins sans identifiant', () => {
    expect(gabaritDeRoute({ path: '/health/ready' })).toBe('/health/ready')
  })
})

describe('exposition des métriques', () => {
  it('publie le registre au format Prometheus', async () => {
    const metrics = createMetrics({ service: 'test' })
    const reponse = await request(app(metrics)).get('/metrics')

    expect(reponse.status).toBe(200)
    expect(reponse.headers['content-type']).toMatch(/text\/plain/)
    expect(reponse.text).toContain('# HELP')
  })

  it('étiquette chaque série avec le service et la version', async () => {
    const metrics = createMetrics({ service: 'conges', version: 'a1b2c3d' })
    await request(app(metrics)).get('/conges/solde/10')
    const reponse = await request(app(metrics)).get('/metrics')

    expect(reponse.text).toMatch(/service="conges"/)
    expect(reponse.text).toMatch(/version="a1b2c3d"/)
  })
})

describe('les quatre signaux d’or', () => {
  it('TRAFIC — compte les requêtes traitées', async () => {
    const metrics = createMetrics({ service: 'test' })
    const a = app(metrics)

    await request(a).get('/conges/solde/10')
    await request(a).get('/conges/solde/11')

    const texte = (await request(a).get('/metrics')).text
    const ligne = texte.split('\n').find((l) => l.startsWith('hrflow_requetes_total') && l.includes('solde'))
    expect(ligne).toBeDefined()
    // Deux identifiants différents alimentent UNE seule série.
    expect(ligne).toContain('route="/conges/solde/:employeeId"')
    expect(ligne.trim().endsWith('2')).toBe(true)
  })

  it('ERREURS — distingue les réponses en échec par leur statut', async () => {
    const metrics = createMetrics({ service: 'test' })
    const a = app(metrics)

    await request(a).get('/conges/solde/10')
    await request(a).get('/panne')

    const texte = (await request(a).get('/metrics')).text
    expect(texte).toMatch(/hrflow_requetes_total\{[^}]*statut="200"/)
    expect(texte).toMatch(/hrflow_requetes_total\{[^}]*statut="500"/)
  })

  it('LATENCE — produit un histogramme, pas une moyenne', async () => {
    const metrics = createMetrics({ service: 'test' })
    const a = app(metrics)
    await request(a).get('/conges/solde/10')

    const texte = (await request(a).get('/metrics')).text
    // Un histogramme permet de calculer les centiles ; une moyenne masquerait
    // la requête lente sur cent, celle que l'utilisateur remarque.
    expect(texte).toContain('hrflow_duree_requete_secondes_bucket')
    expect(texte).toContain('hrflow_duree_requete_secondes_sum')
    expect(texte).toContain('hrflow_duree_requete_secondes_count')
    expect(texte).toMatch(/le="0\.1"/)
  })

  it('SATURATION — expose les métriques du processus', async () => {
    const metrics = createMetrics({ service: 'test' })
    const texte = (await request(app(metrics)).get('/metrics')).text

    expect(texte).toContain('nodejs_process_cpu_seconds_total')
    expect(texte).toContain('nodejs_process_resident_memory_bytes')
    expect(texte).toContain('nodejs_nodejs_eventloop_lag_seconds')
  })
})

describe('compteurs métier des alertes', () => {
  it('suit les échecs de connexion (alerte de force brute)', async () => {
    const metrics = createMetrics({ service: 'auth' })
    metrics.connexionsEchouees.inc({ motif: 'mot_de_passe' })
    metrics.connexionsEchouees.inc({ motif: 'compte_verrouille' })

    const texte = (await request(app(metrics)).get('/metrics')).text
    expect(texte).toContain('hrflow_connexions_echouees_total')
    expect(texte).toMatch(/motif="compte_verrouille"/)
  })

  it('suit les bulletins dont le virement n’a pas abouti', async () => {
    const metrics = createMetrics({ service: 'paie' })
    metrics.bulletinsEnEchec.set(3)

    const texte = (await request(app(metrics)).get('/metrics')).text
    expect(texte).toMatch(/hrflow_bulletins_paiement_en_echec\{[^}]*\}\s+3/)
  })
})

describe('application sans instrumentation', () => {
  it('démarre normalement et n’expose pas /metrics', async () => {
    const reponse = await request(app(undefined)).get('/metrics')
    expect(reponse.status).toBe(404)
  })
})
