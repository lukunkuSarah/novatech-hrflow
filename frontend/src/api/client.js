import axios from 'axios'
import { getToken, clearSession } from './session'

/**
 * Client HTTP.
 *
 * L'URL de l'API vient de la configuration de build, sans valeur de repli
 * pointant vers un environnement réel.
 */
const baseURL = import.meta.env.VITE_API_URL || '/api'

export const api = axios.create({
  baseURL,
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' }
})

// Le jeton est joint à chaque requête depuis la mémoire, jamais lu d'un stockage persistant.
api.interceptors.request.use((config) => {
  const token = getToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response && error.response.status === 401) clearSession()
    // La réponse d'erreur n'est pas journalisée telle quelle : elle peut
    // contenir des éléments de contexte que rien n'oblige à exposer en console.
    return Promise.reject(error)
  }
)

export function messageErreur(error) {
  return error?.response?.data?.error?.message || 'Une erreur est survenue'
}
