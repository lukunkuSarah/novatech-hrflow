'use strict'

const { AppError } = require('@hrflow/shared')

/**
 * Règles métier des congés, isolées de la couche HTTP et de la base.
 *
 * Corrige QUA-05. Le calcul d'origine était :
 *   Math.ceil((new Date(dateFin) - new Date(dateDebut)) / 86400000)
 *
 * Trois défauts en une ligne :
 *   1. des dates inversées produisent un nombre de jours négatif, qui vient
 *      *augmenter* le solde du salarié — fraude exploitable sans outil ;
 *   2. les week-ends et jours fériés sont décomptés comme des jours ouvrés ;
 *   3. la borne finale est exclue, donc un congé d'une journée vaut zéro jour.
 *
 * Isoler ces règles ici les rend testables sans base de données : c'est ce qui
 * permet d'atteindre le seuil de couverture exigé sur la logique critique.
 */

/** Jours fériés France métropolitaine à date fixe (les fériés mobiles sont calculés). */
const FERIES_FIXES = ['01-01', '05-01', '05-08', '07-14', '08-15', '11-01', '11-11', '12-25']

/** Calcul de la date de Pâques (algorithme de Butcher), base des fériés mobiles. */
function paques(annee) {
  const a = annee % 19
  const b = Math.floor(annee / 100)
  const c = annee % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const mois = Math.floor((h + l - 7 * m + 114) / 31)
  const jour = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(Date.UTC(annee, mois - 1, jour))
}

function ajouterJours(date, jours) {
  const copie = new Date(date.getTime())
  copie.setUTCDate(copie.getUTCDate() + jours)
  return copie
}

function joursFeries(annee) {
  const base = paques(annee)
  const mobiles = [
    ajouterJours(base, 1), // lundi de Pâques
    ajouterJours(base, 39), // Ascension
    ajouterJours(base, 50) // lundi de Pentecôte
  ].map((d) => d.toISOString().slice(0, 10))

  const fixes = FERIES_FIXES.map((jourMois) => `${annee}-${jourMois}`)
  return new Set([...fixes, ...mobiles])
}

const cacheFeries = new Map()
function feriesPourAnnee(annee) {
  if (!cacheFeries.has(annee)) cacheFeries.set(annee, joursFeries(annee))
  return cacheFeries.get(annee)
}

/**
 * Nombre de jours ouvrés entre deux dates, bornes incluses.
 * Exclut samedis, dimanches et jours fériés.
 *
 * @param {string} dateDebut AAAA-MM-JJ
 * @param {string} dateFin   AAAA-MM-JJ
 * @returns {number} nombre de jours ouvrés, toujours strictement positif
 * @throws {AppError} si la date de fin précède la date de début
 */
function calculerJoursOuvres(dateDebut, dateFin) {
  const debut = new Date(`${dateDebut}T00:00:00.000Z`)
  const fin = new Date(`${dateFin}T00:00:00.000Z`)

  // Le contrôle qui manquait : sans lui, le solde augmente (QUA-05).
  if (fin < debut) {
    throw AppError.badRequest('La date de fin ne peut pas précéder la date de début')
  }

  const dureeMaximaleJours = 365
  const etendue = Math.round((fin - debut) / 86400000)
  if (etendue > dureeMaximaleJours) {
    throw AppError.badRequest('Une demande ne peut pas couvrir plus de 365 jours')
  }

  let compte = 0
  for (let jour = new Date(debut.getTime()); jour <= fin; jour = ajouterJours(jour, 1)) {
    const jourSemaine = jour.getUTCDay()
    const estWeekend = jourSemaine === 0 || jourSemaine === 6
    const estFerie = feriesPourAnnee(jour.getUTCFullYear()).has(jour.toISOString().slice(0, 10))
    if (!estWeekend && !estFerie) compte += 1
  }

  if (compte === 0) {
    throw AppError.badRequest('La période demandée ne contient aucun jour ouvré')
  }
  return compte
}

/**
 * Calcule le solde à partir des compteurs.
 * L'affichage d'origine ignorait les demandes en attente : un salarié pouvait
 * poser plusieurs fois les mêmes jours tant qu'aucune n'était validée.
 */
function calculerSolde({ joursAcquis, joursPris, joursEnAttente }) {
  const acquis = Number(joursAcquis) || 0
  const pris = Number(joursPris) || 0
  const enAttente = Number(joursEnAttente) || 0
  return {
    joursAcquis: acquis,
    joursPris: pris,
    joursEnAttente: enAttente,
    soldeTheorique: acquis - pris,
    // Seul chiffre sur lequel s'appuyer pour autoriser une nouvelle demande.
    soldeDisponible: acquis - pris - enAttente
  }
}

/** Deux périodes se chevauchent-elles ? Bornes incluses des deux côtés. */
function chevauche(a, b) {
  return !(a.fin < b.debut || b.fin < a.debut)
}

module.exports = { calculerJoursOuvres, calculerSolde, chevauche, joursFeries, paques }
