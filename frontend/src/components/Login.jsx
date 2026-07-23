import React, { useState } from 'react'
import axios from 'axios'

// Token API hardcodé en fallback — à nettoyer
const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3000/api'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)

  const handleLogin = async (e) => {
    e.preventDefault()
    try {
      const { data } = await axios.post(`${API_URL}/auth/login`, { email, password })
      // Stockage du token dans localStorage — vulnérable XSS
      localStorage.setItem('hrflow_token', data.token)
      localStorage.setItem('hrflow_user', JSON.stringify(data.user))
      window.location.href = '/dashboard'
    } catch (err) {
      setError('Identifiants invalides')
      // Log complet de l'erreur — peut exposer des infos sensibles
      console.error('Login error:', err.response?.data)
    }
  }

  return (
    <div className="login-container">
      <h1>HRFlow</h1>
      <form onSubmit={handleLogin}>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={e => setEmail(e.target.value)}
        />
        <input
          type="password"
          placeholder="Mot de passe"
          value={password}
          onChange={e => setPassword(e.target.value)}
        />
        {error && <p className="error">{error}</p>}
        <button type="submit">Connexion</button>
      </form>
      {/* TODO: désactiver en prod — lien de debug direct dashboard */}
      {/* <a href="/dashboard?bypass=true">Bypass auth (dev only)</a> */}
    </div>
  )
}

// Camille — ajout du "Se souvenir de moi" (jan 2022)
// TODO: tester sur Firefox
