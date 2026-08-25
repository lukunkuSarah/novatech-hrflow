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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{js,jsx}'],
      exclude: ['src/main.jsx', 'src/test-setup.js']
    }
  }
})
