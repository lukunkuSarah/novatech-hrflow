/**
 * Interception réseau de l'API HRFlow.
 *
 * Les réponses reproduisent le contrat décrit dans docs/openapi.yaml. Toute
 * divergence entre ce contrat et l'implémentation réelle est détectée
 * séparément, par les 120 tests d'intégration et par les tests de fumée
 * exécutés après chaque déploiement (scripts/smoke-test.js).
 */

export const SALARIE = {
  id: 3,
  role: 'salarie',
  companyId: 100,
  employeeId: 12
}

export const IDENTIFIANTS = {
  email: 'mohamed.alrashid@mercure.example',
  motDePasse: 'DemoHRFlow2024!'
}

/** Solde volontairement pourvu de demandes en attente : c'est l'objet du scénario E2E-04. */
export const SOLDE = {
  employeeId: '12',
  joursAcquis: 25,
  joursPris: 10,
  joursEnAttente: 3,
  soldeTheorique: 15,
  soldeDisponible: 12
}

function json(route, statut, corps) {
  return route.fulfill({
    status: statut,
    contentType: 'application/json',
    headers: { 'X-Request-Id': 'e2e-' + Math.random().toString(36).slice(2, 10) },
    body: JSON.stringify(corps)
  })
}

/**
 * Branche l'API simulée sur une page.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} [options]
 * @param {'succes'|'identifiants-invalides'|'panne'} [options.connexion]
 * @param {'succes'|'panne'|'expire'} [options.solde]
 */
export async function brancherApi(page, options = {}) {
  const { connexion = 'succes', solde = 'succes' } = options

  await page.route('**/api/auth/login', async (route) => {
    if (connexion === 'identifiants-invalides') {
      // Message strictement identique pour un compte inconnu et un mot de passe
      // erroné : l'énumération de comptes doit rester impossible (SEC-13).
      return json(route, 401, {
        error: { code: 'UNAUTHORIZED', message: 'Identifiants invalides', requestId: 'e2e-401' }
      })
    }
    if (connexion === 'panne') {
      return json(route, 500, {
        error: { code: 'INTERNAL_ERROR', message: 'Erreur interne', requestId: 'e2e-500' }
      })
    }
    return json(route, 200, {
      accessToken: 'jeton-e2e-non-persistant',
      refreshToken: 'r'.repeat(64),
      expiresIn: '15m',
      user: SALARIE
    })
  })

  await page.route('**/api/conges/solde/**', async (route) => {
    if (solde === 'panne') {
      return json(route, 502, {
        error: { code: 'BAD_GATEWAY', message: 'Service temporairement indisponible', requestId: 'e2e-502' }
      })
    }
    if (solde === 'expire') {
      return json(route, 401, {
        error: { code: 'UNAUTHORIZED', message: 'Jeton expiré', requestId: 'e2e-401b' }
      })
    }
    return json(route, 200, SOLDE)
  })
}

/** Remplit le formulaire de connexion et le soumet. */
export async function seConnecter(page, identifiants = IDENTIFIANTS) {
  await page.getByLabel(/adresse e-mail/i).fill(identifiants.email)
  await page.getByLabel(/mot de passe/i).fill(identifiants.motDePasse)
  await page.getByRole('button', { name: /connexion/i }).click()
}

/** Contenu des deux stockages du navigateur, pour la vérification SEC-18. */
export async function stockagesNavigateur(page) {
  return page.evaluate(() => ({
    local: Object.fromEntries(Object.entries(window.localStorage)),
    session: Object.fromEntries(Object.entries(window.sessionStorage))
  }))
}
