'use strict'

const { startService } = require('@hrflow/shared')
const { createRecrutementApp } = require('./app')

startService({
  name: 'recrutement',
  required: ['JWT_SECRET'],
  optional: {
    PORT: '3004',
    // Volume persistant, hors arborescence servie par le serveur web (SEC-07).
    UPLOAD_DIR: '/var/lib/hrflow/cv'
  },
  build: ({ config, logger, pool }) => createRecrutementApp({ pool, config, logger })
})
