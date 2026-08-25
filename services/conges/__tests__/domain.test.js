'use strict'

const { calculerJoursOuvres, calculerSolde, paques, joursFeries } = require('../src/domain')

/**
 * Tests de la règle métier des congés.
 *
 * Le premier test de ce fichier est le plus important du service : il vérifie
 * qu'on ne peut plus augmenter son solde en inversant les dates (QUA-05).
 */

describe('calcul des jours ouvrés (QUA-05)', () => {
  it('refuse une période dont la fin précède le début', () => {
    // Comportement d'origine : renvoyait -4, qui venait s'ajouter au solde.
    expect(() => calculerJoursOuvres('2024-06-14', '2024-06-10')).toThrow(
      /La date de fin ne peut pas précéder la date de début/
    )
  })

  it('compte une journée pour un congé d’un seul jour ouvré', () => {
    // Comportement d'origine : 0 jour, car la borne finale était exclue.
    expect(calculerJoursOuvres('2024-06-11', '2024-06-11')).toBe(1)
  })

  it('exclut les samedis et dimanches', () => {
    // Du lundi 10 au vendredi 21 juin 2024 : 12 jours calendaires, 10 ouvrés.
    expect(calculerJoursOuvres('2024-06-10', '2024-06-21')).toBe(10)
  })

  it('exclut les jours fériés fixes', () => {
    // Du lundi 12 au vendredi 16 août 2024 : 5 jours ouvrés moins le 15 août.
    expect(calculerJoursOuvres('2024-08-12', '2024-08-16')).toBe(4)
  })

  it('exclut les jours fériés mobiles (lundi de Pâques)', () => {
    // Pâques 2024 : 31 mars, donc lundi de Pâques le 1er avril.
    expect(calculerJoursOuvres('2024-04-01', '2024-04-05')).toBe(4)
  })

  it('refuse une période supérieure à un an', () => {
    expect(() => calculerJoursOuvres('2024-01-01', '2025-06-01')).toThrow(/plus de 365 jours/)
  })

  it('refuse une période ne contenant aucun jour ouvré', () => {
    // Samedi 15 et dimanche 16 juin 2024.
    expect(() => calculerJoursOuvres('2024-06-15', '2024-06-16')).toThrow(/aucun jour ouvré/)
  })

  it('traverse correctement un changement d’année', () => {
    // Du lundi 30 décembre 2024 au vendredi 3 janvier 2025,
    // moins le 1er janvier férié.
    expect(calculerJoursOuvres('2024-12-30', '2025-01-03')).toBe(4)
  })
})

describe('calcul de Pâques et des jours fériés', () => {
  it('retrouve les dates de Pâques connues', () => {
    expect(paques(2024).toISOString().slice(0, 10)).toBe('2024-03-31')
    expect(paques(2025).toISOString().slice(0, 10)).toBe('2025-04-20')
  })

  it('produit les onze jours fériés français', () => {
    const feries = joursFeries(2024)
    expect(feries.size).toBe(11)
    expect(feries.has('2024-05-01')).toBe(true)
    expect(feries.has('2024-05-09')).toBe(true) // Ascension
    expect(feries.has('2024-05-20')).toBe(true) // lundi de Pentecôte
  })
})

describe('calcul du solde', () => {
  it('déduit les demandes en attente du solde disponible', () => {
    const solde = calculerSolde({ joursAcquis: 25, joursPris: 10, joursEnAttente: 5 })

    expect(solde.soldeTheorique).toBe(15)
    // La version d'origine n'affichait que le solde théorique : un salarié
    // pouvait poser plusieurs fois les mêmes jours tant qu'aucune demande
    // n'était validée.
    expect(solde.soldeDisponible).toBe(10)
  })

  it('tolère des compteurs absents', () => {
    expect(calculerSolde({ joursAcquis: 25 })).toMatchObject({
      joursPris: 0,
      joursEnAttente: 0,
      soldeDisponible: 25
    })
  })

  it('accepte des compteurs fournis sous forme de chaînes par la base', () => {
    expect(calculerSolde({ joursAcquis: '25', joursPris: '3', joursEnAttente: '2' }).soldeDisponible).toBe(20)
  })
})
