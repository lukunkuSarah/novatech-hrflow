'use strict'

const client = require('prom-client')

/**
 * Métriques applicatives — les quatre signaux d'or.
 *
 * Le système audité n'exposait aucune métrique. La seule information
 * disponible était une sonde `/health` qui répondait 200 en toutes
 * circonstances : impossible de savoir si la plateforme ralentissait, si le
 * taux d'erreur montait, ou si un service saturait.
 *
 * Les quatre signaux d'or (Google SRE) sont ceux qui, réunis, décrivent l'état
 * d'un service en ligne :
 *
 *   TRAFIC       hrflow_requetes_total                  — requêtes par seconde
 *   ERREURS      hrflow_requetes_total{statut=~"5.."}   — part des réponses en échec
 *   LATENCE      hrflow_duree_requete_secondes          — histogramme, centiles 50/95/99
 *   SATURATION   process_* et nodejs_*                  — CPU, mémoire, boucle d'événements
 *
 * Le choix de l'histogramme plutôt que d'une moyenne est délibéré : une moyenne
 * de latence masque exactement ce qu'on cherche. Une réponse sur cent à trois
 * secondes ne bouge pas la moyenne, mais c'est elle que l'utilisateur remarque.
 */

/**
 * Normalise un chemin en gabarit de route.
 *
 * Sans cette normalisation, `/conges/solde/10` et `/conges/solde/11` créent deux
 * séries distinctes : avec 8 200 salariés, la base de métriques explose. C'est
 * le défaut classique d'une instrumentation posée trop vite.
 */
function gabaritDeRoute(req) {
  if (req.route && req.route.path) {
    const base = req.baseUrl || ''
    return base + req.route.path || '/'
  }
  // Repli : les segments qui ressemblent à des identifiants sont masqués.
  return (req.path || '/')
    .split('/')
    .map((segment) => {
      if (/^\d+$/.test(segment)) return ':id'
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(segment)) return ':uuid'
      return segment
    })
    .join('/')
}

/**
 * Crée un registre de métriques et le middleware qui l'alimente.
 *
 * @param {object} options
 * @param {string} options.service  Nom du service, en étiquette de chaque série.
 * @param {string} [options.version]
 */
function createMetrics({ service, version = process.env.APP_VERSION || 'dev' } = {}) {
  const registre = new client.Registry()
  registre.setDefaultLabels({ service, version })

  // Saturation : CPU, mémoire résidente, retard de la boucle d'événements,
  // descripteurs de fichiers. Fournies par le collecteur standard.
  client.collectDefaultMetrics({ register: registre, prefix: 'nodejs_' })

  const requetes = new client.Counter({
    name: 'hrflow_requetes_total',
    help: 'Nombre de requêtes HTTP traitées',
    labelNames: ['methode', 'route', 'statut'],
    registers: [registre]
  })

  const duree = new client.Histogram({
    name: 'hrflow_duree_requete_secondes',
    help: 'Durée de traitement des requêtes HTTP',
    labelNames: ['methode', 'route', 'statut'],
    // Bornes resserrées sous la seconde : au-delà de deux secondes, le détail
    // n'apporte plus rien — la requête est déjà un incident.
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [registre]
  })

  const connexionsEchouees = new client.Counter({
    name: 'hrflow_connexions_echouees_total',
    help: "Tentatives de connexion refusées — support de l'alerte de force brute",
    labelNames: ['motif'],
    registers: [registre]
  })

  const bulletinsEnEchec = new client.Gauge({
    name: 'hrflow_bulletins_paiement_en_echec',
    help: "Bulletins émis dont le virement n'a pas abouti",
    registers: [registre]
  })

  /** Middleware de mesure : à poser avant les routes. */
  function mesurer(req, res, next) {
    const fin = duree.startTimer()
    res.on('finish', () => {
      const etiquettes = {
        methode: req.method,
        route: gabaritDeRoute(req),
        statut: String(res.statusCode)
      }
      fin(etiquettes)
      requetes.inc(etiquettes)
    })
    next()
  }

  /**
   * Route d'exposition.
   * Jamais accessible publiquement : Nginx la restreint au réseau de
   * supervision, au même titre que /health/ready.
   */
  async function exposer(req, res) {
    res.set('Content-Type', registre.contentType)
    res.end(await registre.metrics())
  }

  return { registre, mesurer, exposer, requetes, duree, connexionsEchouees, bulletinsEnEchec }
}

module.exports = { createMetrics, gabaritDeRoute }
