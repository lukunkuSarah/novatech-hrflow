module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  collectCoverageFrom: ['src/**/*.js', '!src/index.js'],
  coverageThreshold: {
    global: { statements: 80, branches: 70, functions: 80, lines: 80 }
  },
  coverageReporters: ['text-summary', 'lcov'],
  clearMocks: true
}
