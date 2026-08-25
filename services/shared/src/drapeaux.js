'use strict'

const crypto = require('crypto')
const { AppError } = require('./errors')

/**
 * Drapeaux de fonctionnalité.
 *
 * Le `.env` audité contenait ces deux lignes, commentées depuis 2021 :
 *
 *   # UNLEASH_URL=
 *   # UNLEASH_SECRET=
 *
 * suivies de « Feature flags (pas encore implémenté) ». Faute de drapeaux,
 * toute nouvelle fonctionnalité partait pour 8 200 utilisateurs d'un coup, et
 * la seule marche arrière disponible était un redéploiement — celle-là même
 * qui manquait le 14 août.
 *
 * Un drapeau sépare deux décisions que le système audité confondait :
 * **déployer** du code et **activer** un comportement. Le code part en
 * production éteint ; on l'allume pour un client, puis pour dix pour cent, puis
 * pour tous ; et on l'éteint en une seconde sans redéployer.
 *
 * Choix d'implémentation : pas de service externe. Unleash ou LaunchDarkly
 * introduiraient une dépendance réseau supplémentaire dans le chemin de chaque
 * requête, pour une équipe qui compte six drapeaux. La configuration suffit,
 * et l'interface est volontairement compatible avec une bascule ultérieure.
 */

/**
 * Répartition déterministe et stable.
 *
 * Un tirage aléatoire ferait basculer un même client d'une requête à l'autre :
 * il verrait la fonctionnalité apparaître et disparaître. L'empreinte de la
 * clé et de l'identifiant donne toujours le même résultat pour un même client,
 * et une répartition différente d'un drapeau à l'autre.
 */
function positionDansLaCohorte(cle, identifiant) {
  const empreinte = crypto.createHash('sha256').update(`${cle}:${identifiant}`).digest()
  return (empreinte.readUInt32BE(0) % 10000) / 100
}

/**
 * @param {object} options
 * @param {object} [options.definitions] Drapeaux, sinon lus depuis FEATURE_FLAGS.
 * @param {object} [options.env]
 * @param {object} [options.logger]
 */
function createFeatureFlags({ definitions, env = process.env, logger } = {}) {
  let drapeaux = definitions

  if (!drapeaux) {
    const brut = env.FEATURE_FLAGS
    if (!brut) {
      drapeaux = {}
    } else {
      try {
        drapeaux = JSON.parse(brut)
      } catch {
        // Une configuration de drapeaux illisible doit arrêter le démarrage :
        // sinon le service part avec tous les drapeaux éteints, silencieusement,
        // et l'on cherche pendant des heures pourquoi la fonctionnalité livrée
        // ne s'active pas.
        throw new Error('FEATURE_FLAGS : JSON invalide — le service refuse de démarrer')
      }
    }
  }

  /**
   * Le drapeau est-il actif pour ce contexte ?
   *
   * Ordre d'évaluation, du plus spécifique au plus général :
   *   1. drapeau inconnu ou désactivé  → faux
   *   2. entreprise explicitement listée → vrai
   *   3. répartition progressive        → selon la position dans la cohorte
   *   4. drapeau simplement activé      → vrai
   *
   * @param {string} cle
   * @param {object} [contexte]
   * @param {string|number} [contexte.companyId]
   */
  function actif(cle, contexte = {}) {
    const drapeau = drapeaux[cle]
    if (drapeau === undefined) return false
    if (typeof drapeau === 'boolean') return drapeau
    if (drapeau.actif === false) return false

    const entreprises = drapeau.entreprises
    if (Array.isArray(entreprises) && contexte.companyId !== undefined) {
      if (entreprises.map(String).includes(String(contexte.companyId))) return true
      // Une liste d'entreprises sans pourcentage vaut restriction : le drapeau
      // n'est actif que pour elles.
      if (drapeau.pourcentage === undefined) return false
    }

    if (typeof drapeau.pourcentage === 'number') {
      if (drapeau.pourcentage <= 0) return false
      if (drapeau.pourcentage >= 100) return true
      const identifiant = String(contexte.companyId ?? 'anonyme')
      return positionDansLaCohorte(cle, identifiant) < drapeau.pourcentage
    }

    return drapeau.actif === true
  }

  /**
   * Refuse la requête si le drapeau est éteint.
   * Le message reste explicite : une fonctionnalité désactivée n'est pas une
   * panne, et l'utilisateur doit pouvoir le distinguer.
   */
  function exiger(cle, message) {
    return function garde(req, res, next) {
      const companyId = req.user ? req.user.companyId : undefined
      if (actif(cle, { companyId })) return next()
      return next(new AppError(404, 'FEATURE_DISABLED', message || 'Fonctionnalité non disponible'))
    }
  }

  /** État de tous les drapeaux — exposé aux exploitants, jamais aux clients. */
  function etat(contexte = {}) {
    return Object.fromEntries(Object.keys(drapeaux).map((cle) => [cle, actif(cle, contexte)]))
  }

  if (logger) logger.info('drapeaux de fonctionnalité chargés', { nombre: Object.keys(drapeaux).length })

  return { actif, exiger, etat, definitions: drapeaux }
}

module.exports = { createFeatureFlags, positionDansLaCohorte }
