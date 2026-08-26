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

const { calculerBulletin, validerPeriode, cleIdempotence } = require('./domain')
const { PayoutError } = require('./payouts')

/**
 * Service paie — version corrigée.
 *
 * Constats traités : SEC-04 (route de migration non authentifiée — supprimée),
 * SEC-08, SEC-09, QUA-01, QUA-02, QUA-03, QUA-04.
 */

const ROLES_PAIE = ['rh', 'admin']

function createPaieApp({ pool, config, logger, payouts, metrics, drapeaux }) {
  const app = createApp({ logger, allowedOrigins: config.ALLOWED_ORIGINS, metrics })

  app.use(
    healthRouter({
      service: 'paie',
      version: config.APP_VERSION,
      dependencies: [{ name: 'postgres', check: pingCheck(pool) }]
    })
  )

  // La jauge est relue en base à chaque collecte, et non incrémentée à la volée.
  // Un compteur en mémoire repartirait de zéro au redémarrage alors que les
  // bulletins impayés, eux, sont toujours là : l'alerte VirementsEnEchec
  // cesserait de se déclencher sans que rien ne le signale — précisément le
  // silence que la correction de QUA-03 visait à supprimer. La requête s'appuie
  // sur l'index partiel idx_bulletins_a_rejouer.
  if (metrics && pool) {
    metrics.bulletinsEnEchec.collect = async function collecterBulletinsEnEchec() {
      try {
        const { rows } = await pool.query(
          `SELECT COUNT(*)::int AS n
             FROM bulletins_paie
            WHERE statut IN ('paiement_a_rejouer', 'paiement_en_echec')`
        )
        this.set(rows[0].n)
      } catch (err) {
        // Une base injoignable est déjà couverte par BaseDeDonneesInjoignable :
        // cette collecte ne doit pas faire échouer l'exposition des autres
        // métriques, sous peine de rendre la panne moins lisible, pas plus.
        logger.warn('jauge des bulletins en échec non rafraîchie', { erreur: err.message })
      }
    }
  }

  const auth = requireAuth({ secret: config.JWT_SECRET })

  // ---------------------------------------------------------------------------
  // Émission d'un bulletin
  // ---------------------------------------------------------------------------
  app.post(
    '/paie/calculer',
    auth,
    requireRole(ROLES_PAIE),
    asyncHandler(async (req, res) => {
      const { employeeId } = validate(req.body, { employeeId: ['id'] })
      const { mois, annee, periode } = validerPeriode(req.body)
      const companyId = companyScope(req)

      const resultat = await withTransaction(pool, async (client) => {
        const { rows: employes } = await client.query(
          `SELECT id, salaire_mensuel_brut, taux_activite
             FROM employees
            WHERE id = $1 AND company_id = $2
            FOR UPDATE`,
          [employeeId, companyId]
        )
        if (employes.length === 0) throw AppError.notFound('Salarié introuvable')
        const employe = employes[0]

        // Idempotence côté application : un bulletin déjà émis pour la période
        // est renvoyé tel quel plutôt que recalculé et repayé (QUA-03).
        const { rows: existants } = await client.query(
          `SELECT id, data, statut FROM bulletins_paie
            WHERE employee_id = $1 AND company_id = $2 AND mois = $3 AND annee = $4`,
          [employeeId, companyId, mois, annee]
        )
        if (existants.length > 0) {
          return { bulletin: existants[0].data, statut: existants[0].statut, deja: true }
        }

        const bulletin = calculerBulletin({
          salaireBrutMensuel: employe.salaire_mensuel_brut,
          tauxActivite: Number(employe.taux_activite ?? 1),
          // Activation progressive par entreprise : le code est déployé pour
          // tous, allumé pour ceux dont le barème a été validé (ADR-005).
          autoriserTempsPartiel: Boolean(drapeaux && drapeaux.actif('paie.temps-partiel', { companyId }))
        })

        const donnees = { employeeId, mois, annee, periode, ...bulletin, generatedAt: new Date().toISOString() }

        // Le bulletin est d'abord enregistré « en attente de paiement ».
        // L'ordre de virement ne peut donc plus réussir sans trace, ni échouer
        // en silence : les deux états sont persistés (QUA-04).
        const { rows } = await client.query(
          `INSERT INTO bulletins_paie
             (employee_id, company_id, mois, annee, periode_reference, data, statut, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'en_attente_paiement', NOW())
           RETURNING id`,
          [employeeId, companyId, mois, annee, periode, JSON.stringify(donnees)]
        )

        return { bulletinId: rows[0].id, bulletin: donnees, deja: false }
      })

      if (resultat.deja) {
        req.log.info('bulletin déjà émis pour la période', { employeeId, periode })
        return res.status(200).json({ ...resultat.bulletin, statut: resultat.statut, idempotent: true })
      }

      // Le virement a lieu hors transaction : un appel réseau ne doit pas
      // maintenir une transaction ouverte sur la base.
      let statut = 'paye'
      let referencePaiement = null
      try {
        const ordre = await payouts.virer({
          montantCentimes: resultat.bulletin.netCentimes,
          idempotencyKey: cleIdempotence({ employeeId, periode }),
          metadata: { employeeId, periode, companyId }
        })
        referencePaiement = ordre.id
      } catch (err) {
        // L'échec n'est plus avalé : il est persisté et remonté à l'appelant.
        statut = err instanceof PayoutError && err.retryable ? 'paiement_a_rejouer' : 'paiement_en_echec'
        req.log.error('ordre de virement en échec', {
          employeeId,
          periode,
          statut,
          providerCode: err.providerCode
        })
      }

      await pool.query(
        `UPDATE bulletins_paie SET statut = $1, reference_paiement = $2, updated_at = NOW() WHERE id = $3`,
        [statut, referencePaiement, resultat.bulletinId]
      )

      const httpStatus = statut === 'paye' ? 201 : 502
      res.status(httpStatus).json({
        ...resultat.bulletin,
        bulletinId: resultat.bulletinId,
        statut,
        referencePaiement
      })
    })
  )

  // ---------------------------------------------------------------------------
  // Consultation d'un bulletin
  // ---------------------------------------------------------------------------
  app.get(
    '/paie/bulletins/:employeeId',
    auth,
    requireSelfOrRole('employeeId', ROLES_PAIE),
    asyncHandler(async (req, res) => {
      const { employeeId } = validate(req.params, { employeeId: ['id'] })
      const companyId = companyScope(req)
      const limit = Math.min(Number(req.query.limit) || 12, 60)

      const { rows } = await pool.query(
        `SELECT id, mois, annee, periode_reference, statut, data, created_at
           FROM bulletins_paie
          WHERE employee_id = $1 AND company_id = $2
          ORDER BY annee DESC, mois DESC
          LIMIT $3`,
        [employeeId, companyId, limit]
      )

      res.json({ items: rows, limit })
    })
  )

  // ---------------------------------------------------------------------------
  // Rejeu d'un virement en échec — remplace l'ancien silence
  // ---------------------------------------------------------------------------
  app.post(
    '/paie/bulletins/:id/rejouer-paiement',
    auth,
    requireRole(ROLES_PAIE),
    asyncHandler(async (req, res) => {
      const { id } = validate(req.params, { id: ['id'] })
      const companyId = companyScope(req)

      const { rows } = await pool.query(
        `SELECT id, employee_id, periode_reference, data, statut
           FROM bulletins_paie
          WHERE id = $1 AND company_id = $2`,
        [id, companyId]
      )
      if (rows.length === 0) throw AppError.notFound('Bulletin introuvable')

      const bulletin = rows[0]
      if (bulletin.statut === 'paye') {
        return res.json({ bulletinId: bulletin.id, statut: 'paye', idempotent: true })
      }

      const ordre = await payouts.virer({
        montantCentimes: bulletin.data.netCentimes,
        // Même clé que la tentative initiale : le prestataire ne paiera pas deux fois.
        idempotencyKey: cleIdempotence({
          employeeId: bulletin.employee_id,
          periode: bulletin.periode_reference
        }),
        metadata: { employeeId: bulletin.employee_id, periode: bulletin.periode_reference, companyId }
      })

      await pool.query(
        `UPDATE bulletins_paie SET statut = 'paye', reference_paiement = $1, updated_at = NOW() WHERE id = $2`,
        [ordre.id, bulletin.id]
      )

      req.log.info('virement rejoué avec succès', { bulletinId: bulletin.id })
      res.json({ bulletinId: bulletin.id, statut: 'paye', referencePaiement: ordre.id })
    })
  )

  // ---------------------------------------------------------------------------
  // SEC-04 — la route POST /paie/migrate a été SUPPRIMÉE.
  //
  // C'est le vecteur exact de l'incident P1 du 14 août 2024 : une migration SQL
  // déclenchable par une requête HTTP anonyme, contenant un UPDATE sans clause
  // WHERE sur toute la table `employees`.
  //
  // Elle n'est pas « sécurisée » mais retirée : une migration de schéma n'est
  // pas une fonctionnalité de l'application. Les migrations sont désormais des
  // fichiers versionnés (db/migrations/), appliqués par une étape dédiée du
  // pipeline, en dehors du processus qui sert le trafic, avec sauvegarde
  // préalable et procédure de retour arrière (voir docs/RUNBOOK.md).
  // ---------------------------------------------------------------------------

  app.use(notFoundHandler)
  app.use(errorHandler(logger))

  return app
}

module.exports = { createPaieApp }
