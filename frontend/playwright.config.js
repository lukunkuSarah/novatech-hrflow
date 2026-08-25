import { defineConfig, devices } from '@playwright/test'

/**
 * Configuration des tests de bout en bout.
 *
 * Les scénarios s'exécutent sur le frontend RÉELLEMENT CONSTRUIT (`vite build`
 * puis `vite preview`), pas sur le serveur de développement : c'est l'artefact
 * déployé qui est testé, pas une version intermédiaire.
 *
 * L'API est interceptée au niveau réseau et répond conformément au contrat
 * décrit dans docs/openapi.yaml. Motif détaillé dans docs/PLAN-DE-TESTS.md § 7 :
 * un test E2E dépendant de six conteneurs et d'une base mesure autant
 * l'infrastructure que l'application, devient instable, et un test instable
 * finit par être ignoré puis supprimé.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },

  // Aucune reprise automatique, même en intégration continue : un test qui
  // passe à la seconde tentative est un test instable, et un test instable
  // apprend à l'équipe à relancer sans lire l'échec.
  retries: 0,

  fullyParallel: true,

  // Un navigateur par exécuteur consomme environ 300 Mo. Sur un poste chargé,
  // huit scénarios lancés de front provoquent des expirations à la création de
  // la page — un échec de ressources, pas de code. Deux exécuteurs suffisent :
  // la suite tourne en une minute.
  workers: 2,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off'
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  // Construit puis sert l'application avant de lancer les scénarios.
  webServer: {
    // --host 127.0.0.1 est indispensable : sans lui, Vite écoute sur « localhost »,
    // que Windows résout d'abord en IPv6 (::1). La sonde de Playwright interroge
    // 127.0.0.1 en IPv4 et n'obtient jamais de réponse.
    command: 'npm run build && npm run preview -- --port 4173 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
})
