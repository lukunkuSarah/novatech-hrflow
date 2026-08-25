import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Remplace `react-scripts`, qui ne pouvait pas construire ce projet :
 * `public/index.html` et le point d'entrée `src/index.js` étaient absents
 * (constat QUA-09). L'étape « Build » du pipeline échouait donc en silence.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // En développement, l'API est atteinte via la passerelle.
      '/api': { target: 'http://localhost:3000', changeOrigin: true }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: false
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.js'],
    // Vitest se limite à `src/`. Sans cette borne, il ramasserait aussi les
    // scénarios de `e2e/`, qui relèvent de Playwright : les deux exécuteurs se
    // disputeraient les mêmes fichiers et échoueraient tous les deux.
    include: ['src/**/*.{test,spec}.{js,jsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{js,jsx}'],
      exclude: ['src/main.jsx', 'src/test-setup.js']
    }
  }
})
