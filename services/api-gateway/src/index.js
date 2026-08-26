'use strict'

const { startService } = require('@hrflow/shared')
const { createGatewayApp } = require('./app')

startService({
  name: 'api-gateway',
  required: ['JWT_SECRET'],
  // La passerelle ne parle pas à la base : elle n'a donc pas besoin de ses identifiants.
  withDatabase: false,
  optional: {
    PORT: '3000',
    AUTH_URL: 'http://auth:3001',
    PAIE_URL: 'http://paie:3002',
    CONGES_URL: 'http://conges:3003',
    RECRUTEMENT_URL: 'http://recrutement:3004',
    RATE_LIMIT_PAR_MINUTE: '120',
    PROXY_TIMEOUT_MS: '10000'
  },
  build: ({ config, logger, metrics }) => createGatewayApp({ config, logger, metrics })
})
