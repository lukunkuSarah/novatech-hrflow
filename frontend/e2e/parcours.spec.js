import { test, expect } from '@playwright/test'
import { brancherApi, seConnecter, stockagesNavigateur, IDENTIFIANTS, SOLDE } from './api-simulee.js'

/**
 * Cinq parcours de bout en bout — livrable L2.
 *
 * Chaque scénario est rattaché à un constat d'audit ou à un parcours métier
 * critique. Correspondance complète dans docs/PLAN-DE-TESTS.md § 7.
 */

test.describe('E2E-01 — Connexion et consultation du solde', () => {
  test('un salarié se connecte et voit son solde de congés', async ({ page }) => {
    await brancherApi(page)
    await page.goto('/')

    await expect(page.getByRole('heading', { name: 'HRFlow' })).toBeVisible()
    await expect(page.getByRole('form', { name: /formulaire de connexion/i })).toBeVisible()

    await seConnecter(page)

    // La connexion réussie remplace le formulaire par le tableau de bord.
    await expect(page.getByRole('heading', { name: /mes congés/i })).toBeVisible()
    await expect(page.getByRole('form', { name: /formulaire de connexion/i })).toHaveCount(0)

    // Les quatre compteurs du solde sont rendus.
    await expect(page.getByText('Jours acquis')).toBeVisible()
    await expect(page.getByText('Solde disponible')).toBeVisible()
  })

  test("l'appel au solde porte un jeton d'authentification", async ({ page }) => {
    await brancherApi(page)

    const requete = page.waitForRequest((r) => r.url().includes('/api/conges/solde/'))
    await page.goto('/')
    await seConnecter(page)

    const entetes = (await requete).headers()
    expect(entetes.authorization).toMatch(/^Bearer /)
  })
})

test.describe('E2E-02 — Identifiants invalides (SEC-13)', () => {
  test('le message est générique et la navigation ne se fait pas', async ({ page }) => {
    await brancherApi(page, { connexion: 'identifiants-invalides' })
    await page.goto('/')

    await seConnecter(page, { email: 'inconnu@mercure.example', motDePasse: 'mauvais-mot-de-passe' })

    const alerte = page.getByRole('alert')
    await expect(alerte).toBeVisible()
    await expect(alerte).toHaveText(/identifiants invalides/i)

    // Le message ne doit pas distinguer un compte inconnu d'un mot de passe
    // erroné : sans cela, l'énumération de comptes redevient possible.
    await expect(alerte).not.toHaveText(/compte|inexistant|inconnu|mot de passe incorrect/i)

    // L'utilisateur reste sur le formulaire.
    await expect(page.getByRole('form', { name: /formulaire de connexion/i })).toBeVisible()
    await expect(page.getByRole('heading', { name: /mes congés/i })).toHaveCount(0)
  })
})

test.describe('E2E-03 — Aucun jeton persisté dans le navigateur (SEC-18)', () => {
  test('localStorage et sessionStorage restent vides après connexion', async ({ page }) => {
    await brancherApi(page)
    await page.goto('/')
    await seConnecter(page)
    await expect(page.getByRole('heading', { name: /mes congés/i })).toBeVisible()

    const stockages = await stockagesNavigateur(page)

    // La version auditée écrivait localStorage.setItem('hrflow_token', …),
    // lisible par tout script de la page.
    expect(stockages.local).toEqual({})
    expect(stockages.session).toEqual({})
    expect(JSON.stringify(stockages)).not.toContain('jeton-e2e-non-persistant')
  })

  test('le rechargement de la page ramène au formulaire de connexion', async ({ page }) => {
    await brancherApi(page)
    await page.goto('/')
    await seConnecter(page)
    await expect(page.getByRole('heading', { name: /mes congés/i })).toBeVisible()

    await page.reload()

    // Contrepartie assumée du jeton en mémoire seule (ADR-003) : la session ne
    // survit pas au rechargement. C'est le comportement attendu, pas un défaut.
    await expect(page.getByRole('form', { name: /formulaire de connexion/i })).toBeVisible()
  })
})

test.describe('E2E-04 — Le solde disponible déduit les demandes en attente (QUA-05)', () => {
  test('les quatre compteurs affichent les valeurs du service', async ({ page }) => {
    await brancherApi(page)
    await page.goto('/')
    await seConnecter(page)

    const liste = page.locator('dl')
    await expect(liste).toBeVisible()

    // 25 acquis − 10 pris − 3 en attente = 12 disponibles.
    await expect(liste).toContainText(String(SOLDE.joursAcquis))
    await expect(liste).toContainText(String(SOLDE.joursPris))
    await expect(liste).toContainText(String(SOLDE.joursEnAttente))

    // Le chiffre mis en avant est le solde DISPONIBLE, pas le solde théorique :
    // l'interface auditée n'affichait que le second, ce qui permettait de poser
    // plusieurs fois les mêmes jours tant qu'aucune demande n'était validée.
    const disponible = page.locator('dd strong')
    await expect(disponible).toHaveText(String(SOLDE.soldeDisponible))
    expect(SOLDE.soldeDisponible).toBeLessThan(SOLDE.soldeTheorique)
  })
})

test.describe('E2E-05 — Panne du service (SEC-12)', () => {
  test("l'erreur affichée ne divulgue aucun détail technique", async ({ page }) => {
    await brancherApi(page, { solde: 'panne' })
    await page.goto('/')
    await seConnecter(page)

    const alerte = page.getByRole('alert')
    await expect(alerte).toBeVisible()
    await expect(alerte).toHaveText(/service temporairement indisponible/i)

    // Ni trace d'exécution, ni chemin interne, ni adresse de service.
    const texte = await page.locator('body').innerText()
    expect(texte).not.toMatch(/at Object\.|node_modules|127\.0\.0\.1|ECONNREFUSED|localhost:300/)
  })

  test('une panne à la connexion laisse un message, pas une page blanche', async ({ page }) => {
    await brancherApi(page, { connexion: 'panne' })
    await page.goto('/')
    await seConnecter(page)

    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page.getByRole('button', { name: /connexion/i })).toBeEnabled()
  })
})
