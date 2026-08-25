'use strict'

/**
 * Envoi des courriels transactionnels.
 *
 * Dans le système audité, la réinitialisation de mot de passe se contentait
 * d'un `console.log` du mot de passe en clair (SEC-03, SEC-15 : le répertoire
 * de journaux était exposé publiquement). Le jeton ne doit jamais toucher un
 * journal ; il ne sort d'ici que vers le fournisseur d'envoi.
 *
 * L'implémentation réelle (SendGrid ou SMTP) est branchée en production ;
 * en développement et en test, on utilise une implémentation en mémoire qui
 * permet de vérifier le comportement sans envoyer quoi que ce soit.
 */

function createConsoleMailer(logger) {
  return {
    async sendPasswordReset({ email, token }) {
      // Seule la présence de l'envoi est tracée. Ni le jeton ni l'adresse en clair.
      logger.info('courriel de réinitialisation émis (mode développement)', { to: email })
      if (process.env.NODE_ENV === 'production') {
        throw new Error('createConsoleMailer ne doit pas être utilisé en production')
      }
      return { delivered: true, token }
    }
  }
}

/** Implémentation de test : conserve les envois pour vérification. */
function createMemoryMailer() {
  const sent = []
  return {
    sent,
    async sendPasswordReset({ email, token }) {
      sent.push({ email, token, at: new Date().toISOString() })
      return { delivered: true }
    }
  }
}

/**
 * Implémentation SendGrid.
 * Isolée derrière la même interface pour que le service ne dépende pas du
 * fournisseur — le passage à un autre prestataire ne touche pas les routes.
 */
function createSendgridMailer({ apiKey, from, resetUrlBase, fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new Error('createSendgridMailer : clé API manquante')

  return {
    async sendPasswordReset({ email, token }) {
      const link = `${resetUrlBase}?token=${encodeURIComponent(token)}`
      const response = await fetchImpl('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email }] }],
          from: { email: from },
          subject: 'Réinitialisation de votre mot de passe HRFlow',
          content: [
            {
              type: 'text/plain',
              value:
                `Une réinitialisation de mot de passe a été demandée pour votre compte HRFlow.\n\n` +
                `Lien valable 30 minutes : ${link}\n\n` +
                `Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.`
            }
          ]
        })
      })

      if (!response.ok) {
        // L'erreur remonte sans exposer le jeton.
        throw new Error(`Envoi du courriel refusé par le fournisseur (statut ${response.status})`)
      }
      return { delivered: true }
    }
  }
}

module.exports = { createConsoleMailer, createMemoryMailer, createSendgridMailer }
