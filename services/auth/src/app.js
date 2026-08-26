'use strict'

const crypto = require('crypto')
const bcrypt = require('bcryptjs')
const rateLimit = require('express-rate-limit')
const {
  createApp,
  healthRouter,
  asyncHandler,
  AppError,
  validate,
  signAccessToken,
  verifyToken,
  requireAuth,
  pingCheck,
  notFoundHandler,
  errorHandler
} = require('@hrflow/shared')

/**
 * Service d'authentification — version corrigée.
 *
 * Constats traités : SEC-02 (injection SQL), SEC-03 (prise de contrôle de
 * compte), SEC-09 (secrets codés en dur), SEC-13 (force brute), SEC-19
 * (algorithme non contraint), SEC-20 (données personnelles journalisées),
 * SEC-21 (absence de révocation), QUA-01 (rejets non gérés).
 */

/**
 * Empreinte bcrypt factice, comparée lorsque le compte n'existe pas.
 * Sans elle, une réponse instantanée pour un e-mail inconnu et une réponse
 * lente pour un e-mail connu permettent d'énumérer les comptes au chronomètre.
 */
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'

const MAX_FAILED_ATTEMPTS = 5
const LOCK_DURATION_MINUTES = 15
const RESET_TOKEN_TTL_MINUTES = 30

function hashToken(token) {
  // Le jeton de réinitialisation est stocké haché : une fuite de la table ne
  // permet pas de réinitialiser les mots de passe.
  return crypto.createHash('sha256').update(token).digest('hex')
}

function createAuthApp({ pool, config, logger, mailer, limits = {}, metrics }) {
  const app = createApp({ logger, allowedOrigins: config.ALLOWED_ORIGINS, metrics })

  app.use(
    healthRouter({
      service: 'auth',
      version: config.APP_VERSION,
      dependencies: [{ name: 'postgres', check: pingCheck(pool) }]
    })
  )

  /**
   * Limitation de débit (SEC-13).
   * Deux niveaux : par adresse IP pour freiner l'attaque distribuée, et
   * verrouillage par compte en base pour freiner l'attaque ciblée.
   */
  const loginLimiter = rateLimit({
    windowMs: limits.windowMs ?? 15 * 60 * 1000,
    max: limits.loginMax ?? 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next) => next(AppError.tooManyRequests('Trop de tentatives de connexion'))
  })

  const resetLimiter = rateLimit({
    windowMs: limits.windowMs ?? 15 * 60 * 1000,
    max: limits.resetMax ?? 5,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next) => next(AppError.tooManyRequests('Trop de demandes de réinitialisation'))
  })

  // ---------------------------------------------------------------------------
  // Connexion
  // ---------------------------------------------------------------------------
  app.post(
    '/auth/login',
    loginLimiter,
    asyncHandler(async (req, res) => {
      const { email, password } = validate(req.body, {
        email: ['email'],
        password: ['string', { min: 1, max: 128 }]
      })

      // Requête paramétrée (SEC-02). La valeur n'est jamais interpolée dans le SQL.
      const { rows } = await pool.query(
        `SELECT id, email, password_hash, role, company_id, employee_id,
                failed_attempts, locked_until
           FROM users
          WHERE email = $1`,
        [email]
      )

      const user = rows[0]
      const now = new Date()

      if (user && user.locked_until && new Date(user.locked_until) > now) {
        req.log.warn('tentative sur compte verrouillé', { userId: user.id })
        if (metrics) metrics.connexionsEchouees.inc({ motif: 'compte-verrouille' })
        throw AppError.tooManyRequests('Compte temporairement verrouillé')
      }

      // La comparaison a lieu même sans compte correspondant, pour un temps de
      // réponse constant.
      const valid = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH)

      if (!user || !valid) {
        if (user) {
          const attempts = (user.failed_attempts || 0) + 1
          const lockedUntil =
            attempts >= MAX_FAILED_ATTEMPTS ? new Date(now.getTime() + LOCK_DURATION_MINUTES * 60 * 1000) : null
          await pool.query('UPDATE users SET failed_attempts = $1, locked_until = $2 WHERE id = $3', [
            attempts,
            lockedUntil,
            user.id
          ])
        }
        if (metrics) {
          metrics.connexionsEchouees.inc({ motif: user ? 'mot-de-passe-invalide' : 'compte-inconnu' })
        }
        // Message identique dans les deux cas : pas d'énumération de comptes.
        throw AppError.unauthorized('Identifiants invalides')
      }

      await pool.query(
        'UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE id = $1',
        [user.id]
      )

      const claims = {
        sub: String(user.id),
        employeeId: user.employee_id,
        companyId: user.company_id,
        role: user.role
      }

      // Jeton d'accès court (SEC-21) : un jeton volé n'est exploitable que 15 minutes.
      const accessToken = signAccessToken(claims, config.JWT_SECRET, { expiresIn: config.ACCESS_TOKEN_TTL })
      const refreshToken = crypto.randomBytes(32).toString('hex')

      await pool.query(
        `INSERT INTO refresh_tokens (token_hash, user_id, expires_at, created_at)
         VALUES ($1, $2, NOW() + INTERVAL '7 days', NOW())`,
        [hashToken(refreshToken), user.id]
      )

      // Journalisation sans donnée personnelle en clair (SEC-20) : identifiant
      // technique seulement. L'expurgation du journaliseur masque l'e-mail.
      req.log.info('connexion réussie', { userId: user.id, role: user.role })

      res.json({
        accessToken,
        refreshToken,
        expiresIn: config.ACCESS_TOKEN_TTL,
        user: { id: user.id, role: user.role, companyId: user.company_id, employeeId: user.employee_id }
      })
    })
  )

  // ---------------------------------------------------------------------------
  // Renouvellement de jeton
  // ---------------------------------------------------------------------------
  app.post(
    '/auth/refresh',
    asyncHandler(async (req, res) => {
      const { refreshToken } = validate(req.body, { refreshToken: ['string', { min: 32, max: 128 }] })

      const { rows } = await pool.query(
        `SELECT rt.user_id, rt.revoked_at, rt.expires_at,
                u.role, u.company_id, u.employee_id
           FROM refresh_tokens rt
           JOIN users u ON u.id = rt.user_id
          WHERE rt.token_hash = $1`,
        [hashToken(refreshToken)]
      )

      const record = rows[0]
      if (!record || record.revoked_at || new Date(record.expires_at) <= new Date()) {
        throw AppError.unauthorized('Jeton de renouvellement invalide')
      }

      const accessToken = signAccessToken(
        {
          sub: String(record.user_id),
          employeeId: record.employee_id,
          companyId: record.company_id,
          role: record.role
        },
        config.JWT_SECRET,
        { expiresIn: config.ACCESS_TOKEN_TTL }
      )

      res.json({ accessToken, expiresIn: config.ACCESS_TOKEN_TTL })
    })
  )

  // ---------------------------------------------------------------------------
  // Déconnexion — révocation effective (SEC-21)
  // ---------------------------------------------------------------------------
  app.post(
    '/auth/logout',
    requireAuth({ secret: config.JWT_SECRET }),
    asyncHandler(async (req, res) => {
      await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [
        req.user.userId
      ])
      req.log.info('déconnexion', { userId: req.user.userId })
      res.status(204).end()
    })
  )

  // ---------------------------------------------------------------------------
  // Vérification de jeton — appelée par les autres services
  // ---------------------------------------------------------------------------
  app.post(
    '/auth/verify',
    asyncHandler(async (req, res) => {
      const { token } = validate(req.body, { token: ['string', { min: 10, max: 4096 }] })
      try {
        const claims = verifyToken(token, config.JWT_SECRET)
        res.json({ valid: true, user: claims })
      } catch {
        // Réponse volontairement pauvre : la raison de l'échec n'apprend rien à l'appelant.
        res.status(401).json({ valid: false })
      }
    })
  )

  // ---------------------------------------------------------------------------
  // Réinitialisation de mot de passe — réécriture complète (SEC-03)
  //
  // Ancien comportement : la route réinitialisait le mot de passe de n'importe
  // quelle adresse fournie, sans vérification, et le journalisait en clair.
  // Nouveau comportement : demande → jeton à usage unique envoyé au titulaire
  // de l'adresse → confirmation. Aucun changement d'état sans preuve de
  // possession de la boîte e-mail.
  // ---------------------------------------------------------------------------
  app.post(
    '/auth/password-reset/request',
    resetLimiter,
    asyncHandler(async (req, res) => {
      const { email } = validate(req.body, { email: ['email'] })

      const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email])
      const user = rows[0]

      if (user) {
        const token = crypto.randomBytes(32).toString('hex')
        await pool.query(
          `INSERT INTO password_resets (token_hash, user_id, expires_at, created_at)
           VALUES ($1, $2, NOW() + ($3 || ' minutes')::INTERVAL, NOW())`,
          [hashToken(token), user.id, String(RESET_TOKEN_TTL_MINUTES)]
        )
        // Le jeton part par courriel et n'est jamais journalisé.
        await mailer.sendPasswordReset({ email, token })
        req.log.info('demande de réinitialisation acceptée', { userId: user.id })
      } else {
        req.log.info('demande de réinitialisation pour compte inconnu')
      }

      // Réponse identique dans les deux cas : pas d'énumération de comptes.
      res.json({ message: 'Si un compte existe pour cette adresse, un e-mail a été envoyé.' })
    })
  )

  app.post(
    '/auth/password-reset/confirm',
    resetLimiter,
    asyncHandler(async (req, res) => {
      const { token, newPassword } = validate(req.body, {
        token: ['string', { min: 32, max: 128 }],
        newPassword: ['password']
      })

      const { rows } = await pool.query(
        `SELECT user_id, expires_at, used_at
           FROM password_resets
          WHERE token_hash = $1`,
        [hashToken(token)]
      )

      const record = rows[0]
      if (!record || record.used_at || new Date(record.expires_at) <= new Date()) {
        throw AppError.badRequest('Jeton de réinitialisation invalide ou expiré')
      }

      const hash = await bcrypt.hash(newPassword, 12)

      await pool.query('UPDATE users SET password_hash = $1, failed_attempts = 0, locked_until = NULL WHERE id = $2', [
        hash,
        record.user_id
      ])
      await pool.query('UPDATE password_resets SET used_at = NOW() WHERE token_hash = $1', [hashToken(token)])
      // Un changement de mot de passe invalide les sessions existantes.
      await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [
        record.user_id
      ])

      req.log.info('mot de passe réinitialisé', { userId: record.user_id })
      res.json({ message: 'Mot de passe mis à jour.' })
    })
  )

  // Toujours en dernier : 404 puis gestionnaire d'erreurs terminal.
  app.use(notFoundHandler)
  app.use(errorHandler(logger))

  return app
}

module.exports = { createAuthApp, hashToken, DUMMY_HASH, MAX_FAILED_ATTEMPTS, LOCK_DURATION_MINUTES }
