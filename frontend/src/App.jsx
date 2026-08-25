import React, { useState } from 'react'
import Login from './components/Login'
import Dashboard from './pages/Dashboard'

export default function App() {
  const [utilisateur, setUtilisateur] = useState(null)

  if (!utilisateur) return <Login onConnecte={setUtilisateur} />
  return <Dashboard utilisateur={utilisateur} />
}
