'use strict'

const { startService } = require('@hrflow/shared')
const { createAuthApp } = require('./app')
const { createConsoleMailer, createSendgridMailer } = require('./mailer')

/**
 * Point d'entrée du service d'authentification.
 *
 * Séparé de `app.js` pour que les tests puissent instancier l'application sans
 * ouvrir de port ni de connexion réseau — c'est ce qui rend l'étape « TEST »
 * du pipeline exécutable en intégration continue.
 */
startService({
  name: 'auth',
  // Aucune valeur de repli sur ces variables : le service refuse de démarrer
  // plutôt que de fonctionner avec un secret par défaut (SEC-09).
  required: ['JWT_SECRET'],
  optional: {
    PORT: '3001',
    ACCESS_TOKEN_TTL: '15m',
    SENDGRID_API_KEY: '',
    MAIL_FROM: 'no-reply@hrflow.novatech.io',
    RESET_URL_BASE: 'https://hrflow.novatech.io/reset'
  },
  build({ config, logger, pool }) {
    const mailer = config.SENDGRID_API_KEY
      ? createSendgridMailer({
          apiKey: config.SENDGRID_API_KEY,
          from: config.MAIL_FROM,
          resetUrlBase: config.RESET_URL_BASE
        })
      : createConsoleMailer(logger)

    return createAuthApp({ pool, config, logger, mailer })
  }
})
