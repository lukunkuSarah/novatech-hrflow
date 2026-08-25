import React, { useState } from 'react'
import { api, messageErreur } from '../api/client'
import { setSession } from '../api/session'

/**
 * Formulaire de connexion.
 *
 * Corrections par rapport à la version auditée :
 *   - SEC-18 : le jeton n'est plus écrit dans `localStorage` mais conservé en mémoire ;
 *   - QUA-10 : suppression du lien de contournement d'authentification laissé en commentaire ;
 *   - le message d'erreur reste volontairement identique quelle que soit la cause
 *     (compte inconnu ou mot de passe faux), pour ne pas permettre d'énumérer les comptes ;
 *   - la navigation passe par le routeur au lieu d'un rechargement complet de page.
 */
export default function Login({ onConnecte }) {
  const [email, setEmail] = useState('')
  const [motDePasse, setMotDePasse] = useState('')
  const [erreur, setErreur] = useState(null)
  const [enCours, setEnCours] = useState(false)

  const seConnecter = async (event) => {
    event.preventDefault()
    setErreur(null)
    setEnCours(true)

    try {
      const { data } = await api.post('/auth/login', { email, password: motDePasse })
      setSession({ token: data.accessToken, user: data.user })
      if (onConnecte) onConnecte(data.user)
    } catch (err) {
      setErreur(messageErreur(err))
    } finally {
      setEnCours(false)
    }
  }

  return (
    <div className="login-container">
      <h1>HRFlow</h1>
      <form onSubmit={seConnecter} aria-label="Formulaire de connexion">
        <label htmlFor="email">Adresse e-mail</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <label htmlFor="motDePasse">Mot de passe</label>
        <input
          id="motDePasse"
          name="motDePasse"
          type="password"
          autoComplete="current-password"
          required
          placeholder="Mot de passe"
          value={motDePasse}
          onChange={(e) => setMotDePasse(e.target.value)}
        />

        {erreur && (
          <p className="error" role="alert">
            {erreur}
          </p>
        )}

        <button type="submit" disabled={enCours}>
          {enCours ? 'Connexion…' : 'Connexion'}
        </button>
      </form>
    </div>
  )
}
