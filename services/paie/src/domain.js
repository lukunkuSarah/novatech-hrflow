'use strict'

const { AppError } = require('@hrflow/shared')

/**
 * Règles de calcul de la paie.
 *
 * Corrige QUA-02 (calcul erroné) et une partie de QUA-04.
 *
 * Le calcul d'origine posait trois problèmes distincts, qu'il faut traiter
 * différemment :
 *
 *   1. **Les arrondis** — le calcul se faisait en nombres flottants sur des
 *      euros. `1234.56 * 0.22` produit des fractions de centime qui dérivent
 *      d'un bulletin à l'autre. C'est un défaut purement technique : on le
 *      corrige ici, en calculant en centimes entiers.
 *
 *   2. **Le barème** — les taux (22 % et 42 %) étaient codés en dur, annotés
 *      « taux approximatif » et « à vérifier avec le comptable ». On les sort
 *      du code pour en faire une donnée datée et versionnée, mais **on ne les
 *      modifie pas** : changer un taux de cotisation sans validation d'un
 *      expert-comptable remplacerait une erreur par une autre. Le barème est
 *      donc reproduit à l'identique et explicitement marqué à valider.
 *
 *   3. **Le périmètre** — temps partiel, heures supplémentaires et primes
 *      variables ne sont pas gérés. Ils restent hors périmètre, mais la
 *      structure de données les accueille, et un bulletin dont les données
 *      d'entrée sortent du périmètre couvert est refusé plutôt que calculé
 *      faussement.
 */

/**
 * Barèmes par période d'application.
 * ⚠️ Valeurs reprises telles quelles du système existant. À faire valider par
 *    un expert-comptable avant toute émission de bulletin (cf. QUA-02).
 */
const BAREMES = {
  defaut: {
    libelle: 'Barème historique NovaTech (non validé)',
    valideParExpertComptable: false,
    tauxCotisationsSalariales: 0.22,
    tauxCotisationsPatronales: 0.42
  }
}

/** Conversion euros → centimes, sans dérive de virgule flottante. */
function versCentimes(montantEuros) {
  const valeur = Number(montantEuros)
  if (!Number.isFinite(valeur) || valeur < 0) {
    throw AppError.badRequest('Montant invalide')
  }
  return Math.round(valeur * 100)
}

function versEuros(centimes) {
  return Math.round(centimes) / 100
}

/**
 * Calcule un bulletin de paie.
 *
 * @param {object} params
 * @param {number} params.salaireBrutMensuel  Salaire brut mensuel, en euros.
 * @param {string} [params.baremeId]          Identifiant du barème appliqué.
 * @param {number} [params.tauxActivite]      Quotité de travail (1 = temps plein).
 * @returns {object} bulletin, montants en euros arrondis au centime
 */
function calculerBulletin({ salaireBrutMensuel, baremeId = 'defaut', tauxActivite = 1 }) {
  const bareme = BAREMES[baremeId]
  if (!bareme) throw AppError.badRequest(`Barème inconnu : ${baremeId}`)

  if (!Number.isFinite(Number(tauxActivite)) || tauxActivite <= 0 || tauxActivite > 1) {
    throw AppError.badRequest('Quotité de travail invalide (attendu : strictement entre 0 et 1)')
  }
  // Hors périmètre couvert : plutôt que de produire un bulletin faux, on refuse.
  if (tauxActivite !== 1) {
    throw AppError.badRequest(
      "Le temps partiel n'est pas couvert par le barème en vigueur — bulletin non émis (QUA-02)"
    )
  }

  const brutCentimes = versCentimes(salaireBrutMensuel)
  if (brutCentimes === 0) throw AppError.badRequest('Salaire brut nul')

  // Tous les calculs en entiers : un centime reste un centime.
  const salarialesCentimes = Math.round(brutCentimes * bareme.tauxCotisationsSalariales)
  const patronalesCentimes = Math.round(brutCentimes * bareme.tauxCotisationsPatronales)
  const netCentimes = brutCentimes - salarialesCentimes

  return {
    bareme: { id: baremeId, libelle: bareme.libelle, valide: bareme.valideParExpertComptable },
    brut: versEuros(brutCentimes),
    cotisationsSalariales: versEuros(salarialesCentimes),
    cotisationsPatronales: versEuros(patronalesCentimes),
    net: versEuros(netCentimes),
    coutEmployeur: versEuros(brutCentimes + patronalesCentimes),
    // Le montant à virer est exprimé en centimes : c'est l'unité attendue par
    // le prestataire de paiement, et la seule qui n'introduise pas d'arrondi.
    netCentimes
  }
}

/** Contrôle de la période demandée. */
function validerPeriode({ mois, annee }) {
  const m = Number(mois)
  const a = Number(annee)
  if (!Number.isInteger(m) || m < 1 || m > 12) throw AppError.badRequest('Mois invalide (1 à 12)')
  if (!Number.isInteger(a) || a < 2000 || a > 2100) throw AppError.badRequest('Année invalide')
  return { mois: m, annee: a, periode: `${a}-${String(m).padStart(2, '0')}` }
}

/**
 * Clé d'idempotence d'un virement.
 * Corrige QUA-03 : sans clé, un rejeu du calcul déclenche un second virement
 * pour le même mois. La clé est déterministe, donc un rejeu est neutralisé
 * par le prestataire lui-même.
 */
function cleIdempotence({ employeeId, periode }) {
  return `hrflow-paie-${employeeId}-${periode}`
}

module.exports = { calculerBulletin, validerPeriode, cleIdempotence, versCentimes, versEuros, BAREMES }
