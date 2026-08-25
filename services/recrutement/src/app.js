'use strict'

const multer = require('multer')
const {
  createApp,
  healthRouter,
  asyncHandler,
  AppError,
  validate,
  requireAuth,
  requireRole,
  companyScope,
  notFoundHandler,
  errorHandler,
  pingCheck
} = require('@hrflow/shared')

const { createUploadMiddleware, enregistrerCv } = require('./uploads')

/**
 * Service recrutement — version corrigée.
 *
 * Constats traités : SEC-07 (téléversement non contrôlé), SEC-08 (absence
 * d'autorisation et de cloisonnement), QUA-01, QUA-11 (absence de pagination).
 */

const ROLES_RECRUTEMENT = ['rh', 'recruteur', 'admin']
const STATUTS = ['recu', 'en_cours', 'entretien', 'accepte', 'refuse']

function createRecrutementApp({ pool, config, logger, metrics }) {
  const app = createApp({ logger, allowedOrigins: config.ALLOWED_ORIGINS, metrics })

  app.use(
    healthRouter({
      service: 'recrutement',
      version: config.APP_VERSION,
      dependencies: [{ name: 'postgres', check: pingCheck(pool) }]
    })
  )

  const auth = requireAuth({ secret: config.JWT_SECRET })
  const upload = createUploadMiddleware()

  /**
   * Traduit les erreurs de Multer en erreurs applicatives.
   * Sans cela, un dépassement de taille remonte en erreur 500 et fait fuiter
   * la configuration interne dans le message.
   */
  function uploadCv(req, res, next) {
    upload(req, res, (err) => {
      if (!err) return next()
      if (err instanceof multer.MulterError) {
        const message =
          err.code === 'LIMIT_FILE_SIZE' ? 'CV trop volumineux (5 Mo maximum)' : `Téléversement refusé : ${err.code}`
        return next(AppError.badRequest(message))
      }
      return next(err)
    })
  }

  // ---------------------------------------------------------------------------
  // Dépôt de candidature
  // ---------------------------------------------------------------------------
  app.post(
    '/recrutement/candidat',
    auth,
    requireRole(ROLES_RECRUTEMENT),
    uploadCv,
    asyncHandler(async (req, res) => {
      const { nom, prenom, email, poste } = validate(req.body, {
        nom: ['string', { min: 1, max: 100 }],
        prenom: ['string', { min: 1, max: 100 }],
        email: ['email'],
        poste: ['string', { min: 1, max: 150 }]
      })
      const companyId = companyScope(req)

      if (!req.file) throw AppError.badRequest('CV manquant')

      const fichier = await enregistrerCv({
        buffer: req.file.buffer,
        mimetype: req.file.mimetype,
        repertoire: config.UPLOAD_DIR
      })

      const { rows } = await pool.query(
        `INSERT INTO candidats
           (company_id, nom, prenom, email, poste, cv_nom_stocke, cv_nom_origine, cv_taille, statut, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'recu', NOW())
         RETURNING id, nom, prenom, email, poste, statut, created_at`,
        [
          companyId,
          nom,
          prenom,
          email,
          poste,
          fichier.nomStocke,
          // Le nom d'origine est conservé comme libellé, jamais comme chemin.
          String(req.file.originalname || '').slice(0, 255),
          fichier.taille
        ]
      )

      req.log.info('candidature enregistrée', { candidatId: rows[0].id, tailleCv: fichier.taille })
      res.status(201).json(rows[0])
    })
  )

  // ---------------------------------------------------------------------------
  // Liste des candidatures — paginée et cloisonnée
  // ---------------------------------------------------------------------------
  app.get(
    '/recrutement/candidats',
    auth,
    requireRole(ROLES_RECRUTEMENT),
    asyncHandler(async (req, res) => {
      const companyId = companyScope(req)
      // Corrige QUA-11 : la version d'origine sérialisait toute la table.
      const limit = Math.min(Number(req.query.limit) || 25, 100)
      const offset = Math.max(Number(req.query.offset) || 0, 0)
      const statut = req.query.statut ? validate(req.query, { statut: ['enum', STATUTS] }).statut : null

      const { rows } = await pool.query(
        `SELECT id, nom, prenom, email, poste, statut, created_at,
                COUNT(*) OVER() AS total
           FROM candidats
          WHERE company_id = $1
            AND ($2::text IS NULL OR statut = $2)
          ORDER BY created_at DESC
          LIMIT $3 OFFSET $4`,
        [companyId, statut, limit, offset]
      )

      res.json({
        items: rows.map(({ total: _total, ...candidat }) => candidat),
        total: rows.length > 0 ? Number(rows[0].total) : 0,
        limit,
        offset
      })
    })
  )

  // ---------------------------------------------------------------------------
  // Changement de statut — réservé aux rôles habilités
  // ---------------------------------------------------------------------------
  app.patch(
    '/recrutement/candidat/:id/statut',
    auth,
    requireRole(ROLES_RECRUTEMENT),
    asyncHandler(async (req, res) => {
      const { id } = validate(req.params, { id: ['id'] })
      const { statut } = validate(req.body, { statut: ['enum', STATUTS] })
      const companyId = companyScope(req)

      const { rows } = await pool.query(
        `UPDATE candidats
            SET statut = $1, updated_at = NOW(), updated_by = $2
          WHERE id = $3 AND company_id = $4
          RETURNING id, statut`,
        [statut, req.user.userId, id, companyId]
      )

      if (rows.length === 0) throw AppError.notFound('Candidature introuvable')

      req.log.info('statut de candidature modifié', { candidatId: id, statut, par: req.user.userId })
      res.json(rows[0])
    })
  )

  app.use(notFoundHandler)
  app.use(errorHandler(logger))

  return app
}

module.exports = { createRecrutementApp }
