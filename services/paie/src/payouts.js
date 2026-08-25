'use strict'

/**
 * Ordre de virement.
 *
 * Corrige QUA-03. Le code d'origine :
 *
 *   try { await axios.post('https://api.stripe.com/v1/payouts', ...) }
 *   catch (stripeErr) { console.error('[PAIE] Stripe error (ignored)') }
 *
 * Trois défauts :
 *   - l'erreur est avalée : le bulletin est émis alors que le salarié n'est pas payé ;
 *   - aucune clé d'idempotence : un rejeu paie deux fois ;
 *   - la clé secrète était présente en valeur de repli dans le code.
 *
 * Le contrat retenu ici : l'ordre de virement peut échouer, mais l'échec est
 * **explicite et persisté**. Un bulletin existe toujours dans un état connu
 * (`paye`, `en_echec`), jamais dans un état supposé.
 */

class PayoutError extends Error {
  constructor(message, { retryable = false, providerCode } = {}) {
    super(message)
    this.name = 'PayoutError'
    this.retryable = retryable
    this.providerCode = providerCode
  }
}

function createStripePayouts({ apiKey, fetchImpl = globalThis.fetch, baseUrl = 'https://api.stripe.com/v1' }) {
  if (!apiKey) throw new Error('createStripePayouts : clé API manquante (aucune valeur de repli, SEC-09)')

  return {
    /**
     * @param {object} params
     * @param {number} params.montantCentimes Montant en centimes (entier).
     * @param {string} params.idempotencyKey  Clé déterministe : même clé = même virement.
     */
    async virer({ montantCentimes, devise = 'eur', idempotencyKey, metadata = {} }) {
      if (!Number.isInteger(montantCentimes) || montantCentimes <= 0) {
        throw new PayoutError('Montant de virement invalide')
      }
      if (!idempotencyKey) throw new PayoutError("Clé d'idempotence manquante")

      const body = new URLSearchParams({ amount: String(montantCentimes), currency: devise })
      for (const [key, value] of Object.entries(metadata)) body.append(`metadata[${key}]`, String(value))

      const response = await fetchImpl(`${baseUrl}/payouts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          // Rejouer la même requête ne crée pas un second virement.
          'Idempotency-Key': idempotencyKey
        },
        body
      })

      if (!response.ok) {
        const status = response.status
        // 409/429/5xx : incident temporaire, le rejeu a du sens.
        const retryable = status === 409 || status === 429 || status >= 500
        throw new PayoutError(`Virement refusé par le prestataire (statut ${status})`, {
          retryable,
          providerCode: String(status)
        })
      }

      const payload = await response.json()
      return { id: payload.id, status: payload.status || 'pending' }
    }
  }
}

/** Implémentation de test : enregistre les ordres et respecte l'idempotence. */
function createMemoryPayouts({ failWith = null } = {}) {
  const ordres = new Map()
  return {
    ordres,
    async virer({ montantCentimes, idempotencyKey, metadata }) {
      if (failWith) throw failWith
      if (ordres.has(idempotencyKey)) return ordres.get(idempotencyKey)
      const result = { id: `po_${ordres.size + 1}`, status: 'paid', montantCentimes, metadata }
      ordres.set(idempotencyKey, result)
      return result
    }
  }
}

module.exports = { createStripePayouts, createMemoryPayouts, PayoutError }
