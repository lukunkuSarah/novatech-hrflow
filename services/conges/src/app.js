'use strict'

const {
  createApp,
  healthRouter,
  asyncHandler,
  AppError,
  validate,
  requireAuth,
  requireRole,
  requireSelfOrRole,
  companyScope,
  notFoundHandler,
  errorHandler,
  withTransaction,
  pingCheck
} = require('@hrflow/shared')

const { calculerJoursOuvres, calculerSolde } = require('./domain')

/**
 * Service congés — version corrigée.
 *
 * Constats traités : SEC-05 (endpoint de debug exposant toutes les données),
 * SEC-08 (absence de cloisonnement), QUA-01, QUA-05 (règles métier),
 * QUA-12 (requêtes non optimisées).
 */

const ROLES_RH = ['rh', 'manager', 'admin']

function createCongesApp({ pool, config, logger, metrics }) {
  const app = createApp({ logger, allowedOrigins: config.ALLOWED_ORIGINS, metrics })

  app.use(
    healthRouter({
      service: 'conges',
      version: config.APP_VERSION,
      dependencies: [{ name: 'postgres', check: pingCheck(pool) }]
    })
  )

  // Toutes les routes métier exigent une authentification. Déclarer la garde
  // avant les routes évite l'oubli sur une route ajoutée plus tard.
  const auth = requireAuth({ secret: config.JWT_SECRET })

  // ---------------------------------------------------------------------------
  // Solde
  // ---------------------------------------------------------------------------
  app.get(
    '/conges/solde/:employeeId',
    auth,
    requireSelfOrRole('employeeId', ROLES_RH),
    asyncHandler(async (req, res) => {
      const { employeeId } = validate(req.params, { employeeId: ['id'] })
      const companyId = companyScope(req)

      // Trois requêtes remplacées par une agrégation (QUA-12). Le filtrage par
      // entreprise est dans la clause WHERE, pas dans le code appelant (SEC-08).
      const { rows } = await pool.query(
        `SELECT e.jours_conges_acquis AS jours_acquis,
                COALESCE(SUM(c.nombre_jours) FILTER (WHERE c.statut = 'approuve'), 0)   AS jours_pris,
                COALESCE(SUM(c.nombre_jours) FILTER (WHERE c.statut = 'en_attente'), 0) AS jours_en_attente
           FROM employees e
           LEFT JOIN conges c
                  ON c.employee_id = e.id
                 AND c.company_id = e.company_id
          WHERE e.id = $1
            AND e.company_id = $2
          GROUP BY e.jours_conges_acquis`,
        [employeeId, companyId]
      )

      if (rows.length === 0) throw AppError.notFound('Salarié introuvable')

      res.json({
        employeeId,
        ...calculerSolde({
          joursAcquis: rows[0].jours_acquis,
          joursPris: rows[0].jours_pris,
          joursEnAttente: rows[0].jours_en_attente
        })
      })
    })
  )

  // ---------------------------------------------------------------------------
  // Demande de congé
  // ---------------------------------------------------------------------------
  app.post(
    '/conges/demande',
    auth,
    asyncHandler(async (req, res) => {
      const { dateDebut, dateFin, motif } = validate(req.body, {
        dateDebut: ['isoDate'],
        dateFin: ['isoDate'],
        motif: ['string', { min: 0, max: 500 }]
      })

      const companyId = companyScope(req)
      // L'identifiant du demandeur vient du jeton, jamais du corps de requête :
      // sans cela, un salarié pose des congés au nom d'un autre.
      const employeeId = req.user.employeeId
      if (!employeeId) throw AppError.forbidden('Compte non rattaché à un salarié')

      const nombreJours = calculerJoursOuvres(dateDebut, dateFin)

      const demande = await withTransaction(pool, async (client) => {
        // Verrou sur la ligne du salarié : deux demandes simultanées ne peuvent
        // pas consommer deux fois le même solde.
        const { rows: employeeRows } = await client.query(
          `SELECT jours_conges_acquis FROM employees
            WHERE id = $1 AND company_id = $2 FOR UPDATE`,
          [employeeId, companyId]
        )
        if (employeeRows.length === 0) throw AppError.notFound('Salarié introuvable')

        // Contrôle de chevauchement, absent de la version d'origine.
        const { rows: conflits } = await client.query(
          `SELECT id, date_debut, date_fin FROM conges
            WHERE employee_id = $1
              AND company_id = $2
              AND statut IN ('en_attente', 'approuve')
              AND date_debut <= $4::date
              AND date_fin   >= $3::date
            LIMIT 1`,
          [employeeId, companyId, dateDebut, dateFin]
        )
        if (conflits.length > 0) {
          throw AppError.conflict('Une demande existe déjà sur cette période', { conflit: conflits[0] })
        }

        const { rows: compteurs } = await client.query(
          `SELECT COALESCE(SUM(nombre_jours) FILTER (WHERE statut = 'approuve'), 0)   AS pris,
                  COALESCE(SUM(nombre_jours) FILTER (WHERE statut = 'en_attente'), 0) AS attente
             FROM conges WHERE employee_id = $1 AND company_id = $2`,
          [employeeId, companyId]
        )

        const solde = calculerSolde({
          joursAcquis: employeeRows[0].jours_conges_acquis,
          joursPris: compteurs[0].pris,
          joursEnAttente: compteurs[0].attente
        })

        // Contrôle du solde disponible, absent de la version d'origine.
        if (nombreJours > solde.soldeDisponible) {
          throw AppError.conflict('Solde de congés insuffisant', {
            demande: nombreJours,
            disponible: solde.soldeDisponible
          })
        }

        const { rows } = await client.query(
          `INSERT INTO conges (employee_id, company_id, date_debut, date_fin, nombre_jours, motif, statut, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'en_attente', NOW())
           RETURNING id, employee_id, date_debut, date_fin, nombre_jours, motif, statut, created_at`,
          [employeeId, companyId, dateDebut, dateFin, nombreJours, motif]
        )
        return rows[0]
      })

      req.log.info('demande de congé enregistrée', {
        congeId: demande.id,
        employeeId,
        nombreJours
      })

      res.status(201).json(demande)
    })
  )

  // ---------------------------------------------------------------------------
  // Décision sur une demande
  // ---------------------------------------------------------------------------
  app.patch(
    '/conges/:id/decision',
    auth,
    requireRole(ROLES_RH),
    asyncHandler(async (req, res) => {
      const { id } = validate(req.params, { id: ['id'] })
      const { decision } = validate(req.body, { decision: ['enum', ['approuve', 'refuse']] })
      const companyId = companyScope(req)

      const { rows } = await pool.query(
        `UPDATE conges
            SET statut = $1, decided_by = $2, decided_at = NOW()
          WHERE id = $3
            AND company_id = $4
            AND statut = 'en_attente'
          RETURNING id, employee_id, statut, nombre_jours`,
        [decision, req.user.userId, id, companyId]
      )

      if (rows.length === 0) {
        throw AppError.notFound('Demande introuvable ou déjà traitée')
      }

      req.log.info('décision de congé', { congeId: id, decision, decidedBy: req.user.userId })
      res.json(rows[0])
    })
  )

  // ---------------------------------------------------------------------------
  // Liste des demandes d'une entreprise (paginée)
  // ---------------------------------------------------------------------------
  app.get(
    '/conges',
    auth,
    requireRole(ROLES_RH),
    asyncHandler(async (req, res) => {
      const companyId = companyScope(req)
      const limit = Math.min(Number(req.query.limit) || 50, 200)
      const offset = Math.max(Number(req.query.offset) || 0, 0)

      const { rows } = await pool.query(
        `SELECT id, employee_id, date_debut, date_fin, nombre_jours, statut, created_at
           FROM conges
          WHERE company_id = $1
          ORDER BY created_at DESC
          LIMIT $2 OFFSET $3`,
        [companyId, limit, offset]
      )

      res.json({ items: rows, limit, offset })
    })
  )

  // ---------------------------------------------------------------------------
  // SEC-05 — l'ancienne route GET /conges/debug/all a été SUPPRIMÉE.
  //
  // Elle retournait la jointure complète congés × salariés de tous les clients
  // sans authentification. Elle n'est pas remplacée par une version protégée :
  // le besoin de diagnostic est couvert par la journalisation structurée et par
  // l'accès direct à la base en environnement contrôlé. Une route de debug en
  // production est une porte dérobée, quel que soit son niveau de protection.
  // ---------------------------------------------------------------------------

  app.use(notFoundHandler)
  app.use(errorHandler(logger))

  return app
}

module.exports = { createCongesApp }
