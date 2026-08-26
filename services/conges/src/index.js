'use strict'

const { startService } = require('@hrflow/shared')
const { createCongesApp } = require('./app')

startService({
  name: 'conges',
  required: ['JWT_SECRET'],
  optional: { PORT: '3003' },
  build: ({ config, logger, pool, metrics }) => createCongesApp({ pool, config, logger, metrics })
})
