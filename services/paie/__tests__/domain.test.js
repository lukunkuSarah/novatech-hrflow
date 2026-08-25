'use strict'

const { calculerBulletin, validerPeriode, cleIdempotence, versCentimes, versEuros } = require('../src/domain')

describe('arrondis — le défaut le plus discret du service (QUA-02)', () => {
  it('calcule au centime près, sans dérive de virgule flottante', () => {
    const bulletin = calculerBulletin({ salaireBrutMensuel: 2537.83 })

    // 253783 centimes × 0,22 = 55832,26 → 55832 centimes.
    expect(bulletin.cotisationsSalariales).toBe(558.32)
    expect(bulletin.net).toBe(1979.51)
    // La somme reste exacte : c'est ce que l'ancien calcul ne garantissait pas.
    expect(bulletin.net + bulletin.cotisationsSalariales).toBe(bulletin.brut)
  })

  it('produit un montant de virement en centimes entiers', () => {
    const bulletin = calculerBulletin({ salaireBrutMensuel: 2537.83 })
    expect(Number.isInteger(bulletin.netCentimes)).toBe(true)
    expect(bulletin.netCentimes).toBe(197951)
  })

  it('calcule le coût employeur', () => {
    const bulletin = calculerBulletin({ salaireBrutMensuel: 3000 })
    expect(bulletin.cotisationsPatronales).toBe(1260)
    expect(bulletin.coutEmployeur).toBe(4260)
  })

  it('signale que le barème appliqué n’est pas validé', () => {
    // Point de transparence : le barème est repris tel quel du système audité.
    expect(calculerBulletin({ salaireBrutMensuel: 2000 }).bareme.valide).toBe(false)
  })

  it('refuse un salaire négatif ou non numérique', () => {
    expect(() => calculerBulletin({ salaireBrutMensuel: -100 })).toThrow()
    expect(() => calculerBulletin({ salaireBrutMensuel: 'beaucoup' })).toThrow()
  })

  it('refuse un salaire nul', () => {
    expect(() => calculerBulletin({ salaireBrutMensuel: 0 })).toThrow(/Salaire brut nul/)
  })

  it('refuse un barème inconnu', () => {
    expect(() => calculerBulletin({ salaireBrutMensuel: 2000, baremeId: 'inexistant' })).toThrow(/Barème inconnu/)
  })
})

describe('périmètre non couvert — mieux vaut refuser que calculer faux', () => {
  it('refuse d’émettre un bulletin à temps partiel', () => {
    expect(() => calculerBulletin({ salaireBrutMensuel: 2000, tauxActivite: 0.8 })).toThrow(
      /temps partiel n'est pas couvert/
    )
  })

  it('refuse une quotité de travail aberrante', () => {
    expect(() => calculerBulletin({ salaireBrutMensuel: 2000, tauxActivite: 0 })).toThrow(/Quotité/)
    expect(() => calculerBulletin({ salaireBrutMensuel: 2000, tauxActivite: 1.5 })).toThrow(/Quotité/)
  })
})

describe('validation de la période', () => {
  it('accepte une période valide et la normalise', () => {
    expect(validerPeriode({ mois: 6, annee: 2024 })).toEqual({ mois: 6, annee: 2024, periode: '2024-06' })
  })

  it('complète le mois sur deux chiffres', () => {
    expect(validerPeriode({ mois: 1, annee: 2024 }).periode).toBe('2024-01')
  })

  it('refuse un mois hors bornes', () => {
    expect(() => validerPeriode({ mois: 13, annee: 2024 })).toThrow(/Mois invalide/)
    expect(() => validerPeriode({ mois: 0, annee: 2024 })).toThrow(/Mois invalide/)
  })

  it('refuse une année aberrante', () => {
    expect(() => validerPeriode({ mois: 6, annee: 1789 })).toThrow(/Année invalide/)
  })
})

describe('clé d’idempotence — anti double virement (QUA-03)', () => {
  it('produit la même clé pour le même salarié et la même période', () => {
    const a = cleIdempotence({ employeeId: '10', periode: '2024-06' })
    const b = cleIdempotence({ employeeId: '10', periode: '2024-06' })
    expect(a).toBe(b)
  })

  it('produit des clés distinctes pour des périodes différentes', () => {
    expect(cleIdempotence({ employeeId: '10', periode: '2024-06' })).not.toBe(
      cleIdempotence({ employeeId: '10', periode: '2024-07' })
    )
  })
})

describe('conversions monétaires', () => {
  it('convertit dans les deux sens sans perte', () => {
    expect(versCentimes(1234.56)).toBe(123456)
    expect(versEuros(123456)).toBe(1234.56)
    expect(versEuros(versCentimes(0.07))).toBe(0.07)
  })
})
