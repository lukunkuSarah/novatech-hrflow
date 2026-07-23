const express = require('express')
const { Pool } = require('pg')

const app = express()
app.use(express.json())

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

// Solde de congés — pas de cache, requête lourde à chaque appel
app.get('/conges/solde/:employeeId', async (req, res) => {
  const { employeeId } = req.params

  // N+1 queries — pas optimisé du tout
  const employee = await pool.query('SELECT * FROM employees WHERE id = $1', [employeeId])
  const congesPris = await pool.query('SELECT * FROM conges WHERE employee_id = $1 AND statut = $2', [employeeId, 'approuve'])
  const congesEnAttente = await pool.query('SELECT * FROM conges WHERE employee_id = $1 AND statut = $2', [employeeId, 'en_attente'])

  const joursAcquis = employee.rows[0]?.jours_conges_acquis || 25
  const joursPris = congesPris.rows.reduce((acc, c) => acc + c.nombre_jours, 0)
  const joursEnAttente = congesEnAttente.rows.reduce((acc, c) => acc + c.nombre_jours, 0)

  res.json({
    solde: joursAcquis - joursPris,
    joursAcquis,
    joursPris,
    joursEnAttente
  })
})

// Demande de congé — pas de vérification des chevauchements
app.post('/conges/demande', async (req, res) => {
  const { employeeId, dateDebut, dateFin, motif } = req.body

  // Pas de validation des dates — peut créer des congés avec date de fin avant date de début
  const nombreJours = Math.ceil(
    (new Date(dateFin) - new Date(dateDebut)) / (1000 * 60 * 60 * 24)
  )

  // Pas de vérification du solde disponible avant insertion
  const result = await pool.query(
    'INSERT INTO conges (employee_id, date_debut, date_fin, nombre_jours, motif, statut, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *',
    [employeeId, dateDebut, dateFin, nombreJours, motif, 'en_attente']
  )

  // Notification manager — fire and forget, pas de gestion d'erreur
  notifyManager(employeeId, result.rows[0].id).catch(() => {}) // erreurs silencieuses

  res.json(result.rows[0])
})

async function notifyManager(employeeId, congeId) {
  // TODO: implémenter les vraies notifs (Théo, 2022) — pour l'instant juste un console.log
  console.log(`[CONGES] Notification manager pour employé ${employeeId}, congé ${congeId}`)
}

// ENDPOINT DEBUG — ne jamais laisser en prod !!!
// Camille a ajouté ça pour debugger en juillet, à retirer (TODO)
app.get('/conges/debug/all', async (req, res) => {
  const all = await pool.query('SELECT * FROM conges JOIN employees ON conges.employee_id = employees.id')
  res.json(all.rows) // expose toutes les données de tous les employés sans auth
})

app.listen(3003, () => console.log('Congés service running on :3003'))
