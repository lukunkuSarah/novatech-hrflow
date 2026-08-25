'use strict'

const { createFeatureFlags, positionDansLaCohorte } = require('../src/drapeaux')

describe('lecture de la configuration', () => {
  it('aucun drapeau déclaré : tout est éteint', () => {
    const d = createFeatureFlags({ env: {} })
    expect(d.actif('paie.temps-partiel')).toBe(false)
  })

  it('lit les drapeaux depuis la variable d’environnement', () => {
    const d = createFeatureFlags({ env: { FEATURE_FLAGS: '{"paie.temps-partiel": true}' } })
    expect(d.actif('paie.temps-partiel')).toBe(true)
  })

  it('refuse de démarrer sur une configuration illisible', () => {
    // Sinon le service part avec tous les drapeaux éteints, silencieusement, et
    // l'on cherche pendant des heures pourquoi la fonctionnalité ne s'active pas.
    expect(() => createFeatureFlags({ env: { FEATURE_FLAGS: '{ceci nest pas du json' } })).toThrow(/JSON invalide/)
  })

  it('un drapeau inconnu est éteint, jamais allumé par défaut', () => {
    const d = createFeatureFlags({ definitions: { autre: true } })
    expect(d.actif('drapeau.inexistant')).toBe(false)
  })
})

describe('activation par entreprise', () => {
  const d = createFeatureFlags({
    definitions: { 'paie.temps-partiel': { actif: true, entreprises: [100, 200] } }
  })

  it('active pour une entreprise listée', () => {
    expect(d.actif('paie.temps-partiel', { companyId: 100 })).toBe(true)
    expect(d.actif('paie.temps-partiel', { companyId: '200' })).toBe(true)
  })

  it('reste éteint pour les autres', () => {
    expect(d.actif('paie.temps-partiel', { companyId: 999 })).toBe(false)
  })

  it('accepte indifféremment un identifiant en nombre ou en chaîne', () => {
    expect(d.actif('paie.temps-partiel', { companyId: '100' })).toBe(d.actif('paie.temps-partiel', { companyId: 100 }))
  })
})

describe('déploiement progressif', () => {
  it('0 % n’active rien, 100 % active tout', () => {
    const zero = createFeatureFlags({ definitions: { f: { actif: true, pourcentage: 0 } } })
    const cent = createFeatureFlags({ definitions: { f: { actif: true, pourcentage: 100 } } })
    for (const id of [1, 42, 777, 8200]) {
      expect(zero.actif('f', { companyId: id })).toBe(false)
      expect(cent.actif('f', { companyId: id })).toBe(true)
    }
  })

  it('la décision est stable pour une même entreprise', () => {
    // Un tirage aléatoire ferait basculer le client d'une requête à l'autre :
    // il verrait la fonctionnalité apparaître puis disparaître.
    const d = createFeatureFlags({ definitions: { f: { actif: true, pourcentage: 50 } } })
    const premiere = d.actif('f', { companyId: 4242 })
    for (let i = 0; i < 50; i += 1) {
      expect(d.actif('f', { companyId: 4242 })).toBe(premiere)
    }
  })

  it('répartit à peu près conformément au pourcentage demandé', () => {
    const d = createFeatureFlags({ definitions: { f: { actif: true, pourcentage: 25 } } })
    let actifs = 0
    for (let id = 1; id <= 2000; id += 1) {
      if (d.actif('f', { companyId: id })) actifs += 1
    }
    const part = (actifs / 2000) * 100
    expect(part).toBeGreaterThan(20)
    expect(part).toBeLessThan(30)
  })

  it('deux drapeaux au même pourcentage ne touchent pas la même cohorte', () => {
    // Sans la clé dans l'empreinte, les mêmes clients essuieraient toutes les
    // nouveautés successives.
    const a = createFeatureFlags({ definitions: { alpha: { actif: true, pourcentage: 50 } } })
    const b = createFeatureFlags({ definitions: { beta: { actif: true, pourcentage: 50 } } })
    let divergences = 0
    for (let id = 1; id <= 200; id += 1) {
      if (a.actif('alpha', { companyId: id }) !== b.actif('beta', { companyId: id })) divergences += 1
    }
    expect(divergences).toBeGreaterThan(50)
  })

  it('une entreprise listée passe outre le pourcentage', () => {
    const d = createFeatureFlags({
      definitions: { f: { actif: true, pourcentage: 1, entreprises: [100] } }
    })
    expect(d.actif('f', { companyId: 100 })).toBe(true)
  })

  it('actif: false éteint le drapeau quel que soit le reste', () => {
    const d = createFeatureFlags({
      definitions: { f: { actif: false, pourcentage: 100, entreprises: [100] } }
    })
    expect(d.actif('f', { companyId: 100 })).toBe(false)
  })
})

describe('répartition déterministe', () => {
  it('renvoie une position comprise entre 0 et 100', () => {
    for (const id of ['1', '8200', 'anonyme']) {
      const p = positionDansLaCohorte('f', id)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThan(100)
    }
  })

  it('donne toujours la même position pour la même paire', () => {
    expect(positionDansLaCohorte('f', '100')).toBe(positionDansLaCohorte('f', '100'))
  })
})

describe('garde de route', () => {
  function appeler(d, cle, user) {
    let recu = 'aucun'
    d.exiger(cle)({ user }, {}, (err) => {
      recu = err ? err.status : 'suite'
    })
    return recu
  }

  it('laisse passer quand le drapeau est allumé', () => {
    const d = createFeatureFlags({ definitions: { f: { actif: true, entreprises: [100] } } })
    expect(appeler(d, 'f', { companyId: 100 })).toBe('suite')
  })

  it('répond 404 quand le drapeau est éteint', () => {
    // 404 plutôt que 403 : une fonctionnalité non activée n'existe pas encore
    // pour ce client, elle ne lui est pas refusée.
    const d = createFeatureFlags({ definitions: { f: { actif: false } } })
    expect(appeler(d, 'f', { companyId: 100 })).toBe(404)
  })
})

describe('état des drapeaux', () => {
  it('restitue la décision pour chaque drapeau connu', () => {
    const d = createFeatureFlags({
      definitions: { a: true, b: false, c: { actif: true, entreprises: [100] } }
    })
    expect(d.etat({ companyId: 100 })).toEqual({ a: true, b: false, c: true })
    expect(d.etat({ companyId: 999 })).toEqual({ a: true, b: false, c: false })
  })
})
