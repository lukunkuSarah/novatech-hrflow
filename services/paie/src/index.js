'use strict'

const { startService } = require('@hrflow/shared')
const { createPaieApp } = require('./app')
const { createStripePayouts } = require('./payouts')

startService({
  name: 'paie',
  required: ['JWT_SECRET', 'STRIPE_SECRET_KEY'],
  optional: { PORT: '3002' },
  build: ({ config, logger, pool }) =>
    createPaieApp({
      pool,
      config,
      logger,
      payouts: createStripePayouts({ apiKey: config.STRIPE_SECRET_KEY })
    })
})
