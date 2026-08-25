import React, { useEffect, useState } from 'react'
import { api, messageErreur } from '../api/client'

/**
 * Tableau de bord minimal : solde de congés du salarié connecté.
 *
 * L'identifiant interrogé vient du profil renvoyé à la connexion. Même si
 * l'interface en demandait un autre, le service refuserait : le contrôle
 * d'accès est côté serveur (SEC-08), l'interface n'est pas une barrière.
 */
export default function Dashboard({ utilisateur }) {
  const [solde, setSolde] = useState(null)
  const [erreur, setErreur] = useState(null)

  useEffect(() => {
    let annule = false
    api
      .get(`/conges/solde/${utilisateur.employeeId}`)
      .then(({ data }) => {
        if (!annule) setSolde(data)
      })
      .catch((err) => {
        if (!annule) setErreur(messageErreur(err))
      })
    return () => {
      annule = true
    }
  }, [utilisateur.employeeId])

  return (
    <main className="dashboard">
      <h1>Mes congés</h1>
      {erreur && <p role="alert">{erreur}</p>}
      {solde && (
        <dl>
          <dt>Jours acquis</dt>
          <dd>{solde.joursAcquis}</dd>
          <dt>Jours pris</dt>
          <dd>{solde.joursPris}</dd>
          <dt>Demandes en attente</dt>
          <dd>{solde.joursEnAttente}</dd>
          <dt>Solde disponible</dt>
          <dd>
            <strong>{solde.soldeDisponible}</strong>
          </dd>
        </dl>
      )}
    </main>
  )
}
