import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

/**
 * Point d'entrée de l'application — il n'existait pas dans le dépôt audité
 * (constat QUA-09), ce qui rendait toute construction du frontend impossible.
 */
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
