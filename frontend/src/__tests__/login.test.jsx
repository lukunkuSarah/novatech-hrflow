import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import Login from '../components/Login'
import { api } from '../api/client'
import { getToken, clearSession } from '../api/session'

/**
 * Tests du formulaire de connexion.
 *
 * Les tests d'origine étaient deux `expect(true).toBe(true)`, avec ce
 * commentaire : « test vide pour éviter l'erreur CI » (constat QUA-06).
 * Un test qui ne peut pas échouer n'est pas un test : il transforme la
 * barrière de qualité en décoration.
 */

vi.mock('../api/client', async () => {
  const actual = await vi.importActual('../api/client')
  return { ...actual, api: { post: vi.fn(), get: vi.fn() } }
})

describe('Login', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearSession()
  })

  it('affiche les champs attendus', () => {
    render(<Login />)
    expect(screen.getByLabelText(/adresse e-mail/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/mot de passe/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /connexion/i })).toBeInTheDocument()
  })

  it('conserve le jeton en mémoire et non dans localStorage (SEC-18)', async () => {
    api.post.mockResolvedValue({
      data: { accessToken: 'jeton-de-test', user: { id: 1, employeeId: 10, role: 'salarie' } }
    })
    const onConnecte = vi.fn()

    render(<Login onConnecte={onConnecte} />)
    await userEvent.type(screen.getByLabelText(/adresse e-mail/i), 'salarie@novatech.io')
    await userEvent.type(screen.getByLabelText(/mot de passe/i), 'motdepasse-solide')
    await userEvent.click(screen.getByRole('button', { name: /connexion/i }))

    await waitFor(() => expect(onConnecte).toHaveBeenCalled())

    expect(getToken()).toBe('jeton-de-test')
    // Le point central de la correction : rien n'est persisté côté navigateur.
    expect(window.localStorage.getItem('hrflow_token')).toBeNull()
    expect(window.localStorage.length).toBe(0)
  })

  it("affiche un message d'erreur générique en cas d'échec", async () => {
    api.post.mockRejectedValue({ response: { status: 401, data: { error: { message: 'Identifiants invalides' } } } })

    render(<Login />)
    await userEvent.type(screen.getByLabelText(/adresse e-mail/i), 'inconnu@novatech.io')
    await userEvent.type(screen.getByLabelText(/mot de passe/i), 'mauvais-mot-de-passe')
    await userEvent.click(screen.getByRole('button', { name: /connexion/i }))

    const alerte = await screen.findByRole('alert')
    expect(alerte).toHaveTextContent('Identifiants invalides')
    expect(getToken()).toBeNull()
  })
})
