'use strict'

const { silentLogger } = require('@hrflow/shared')
const { createConsoleMailer, createMemoryMailer, createSendgridMailer } = require('../src/mailer')

describe('envoi de courriel — le jeton ne doit jamais atterrir dans un journal (SEC-03, SEC-15)', () => {
  it('journalise l’émission sans le jeton en mode développement', async () => {
    const lignes = []
    const logger = { ...silentLogger(), info: (msg, ctx) => lignes.push(JSON.stringify({ msg, ctx })) }
    const mailer = createConsoleMailer(logger)

    const resultat = await mailer.sendPasswordReset({ email: 'a@novatech.io', token: 'jeton-secret-de-test' })

    expect(resultat.delivered).toBe(true)
    expect(lignes.join('')).not.toContain('jeton-secret-de-test')
  })

  it('refuse de servir en production', async () => {
    const ancien = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const mailer = createConsoleMailer(silentLogger())
      await expect(mailer.sendPasswordReset({ email: 'a@novatech.io', token: 'x' })).rejects.toThrow(
        /ne doit pas être utilisé en production/
      )
    } finally {
      // eslint-disable-next-line require-atomic-updates -- restauration volontaire d'une variable de test.
      process.env.NODE_ENV = ancien
    }
  })

  it('l’implémentation de test conserve les envois pour vérification', async () => {
    const mailer = createMemoryMailer()
    await mailer.sendPasswordReset({ email: 'a@novatech.io', token: 'jeton' })
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0]).toMatchObject({ email: 'a@novatech.io', token: 'jeton' })
  })
})

describe('implémentation SendGrid', () => {
  it('refuse de se construire sans clé — aucune valeur de repli (SEC-09)', () => {
    expect(() => createSendgridMailer({ apiKey: '' })).toThrow(/clé API manquante/)
  })

  it('transmet le lien de réinitialisation au fournisseur', async () => {
    let appel = null
    const mailer = createSendgridMailer({
      apiKey: 'SG.cle-de-test',
      from: 'no-reply@hrflow.novatech.io',
      resetUrlBase: 'https://hrflow.novatech.io/reset',
      fetchImpl: async (url, options) => {
        appel = { url, options }
        return { ok: true, status: 202 }
      }
    })

    const resultat = await mailer.sendPasswordReset({ email: 'salarie@novatech.io', token: 'jeton+special' })

    expect(resultat.delivered).toBe(true)
    expect(appel.options.headers.Authorization).toBe('Bearer SG.cle-de-test')
    // Le jeton est encodé pour l'URL : un caractère spécial ne casse pas le lien.
    expect(appel.options.body).toContain('jeton%2Bspecial')
  })

  it('remonte un échec du fournisseur sans exposer le jeton', async () => {
    const mailer = createSendgridMailer({
      apiKey: 'SG.cle-de-test',
      from: 'no-reply@hrflow.novatech.io',
      resetUrlBase: 'https://hrflow.novatech.io/reset',
      fetchImpl: async () => ({ ok: false, status: 503 })
    })

    await expect(mailer.sendPasswordReset({ email: 'salarie@novatech.io', token: 'jeton-secret' })).rejects.toThrow(
      /statut 503/
    )

    await expect(mailer.sendPasswordReset({ email: 'salarie@novatech.io', token: 'jeton-secret' })).rejects.not.toThrow(
      /jeton-secret/
    )
  })
})
