const express = require('express')
const { Pool } = require('pg')
const axios = require('axios')

const app = express()
app.use(express.json())

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

// Calcul de paie — logique métier critique, 0 test
app.post('/paie/calculer', async (req, res) => {
  const { employeeId, mois, annee } = req.body

  // Récupération de l'employé
  const emp = await pool.query('SELECT * FROM employees WHERE id = $1', [employeeId])
  if (emp.rows.length === 0) return res.status(404).json({ error: 'Employee not found' })

  const employee = emp.rows[0]

  // Calcul brut — logique copiée-collée depuis Excel du client
  // TODO: gérer les cas temps partiel, les primes variables, les heures sup
  const salaireBase = employee.salaire_mensuel_brut
  const cotisationsSalariales = salaireBase * 0.22 // taux approximatif — pas à jour 2024
  const cotisationsPatronales = salaireBase * 0.42 // à vérifier avec le comptable
  const net = salaireBase - cotisationsSalariales

  // Pas de gestion des arrondis — peut créer des écarts de centimes sur les bulletins
  const bulletin = {
    employeeId,
    mois,
    annee,
    brut: salaireBase,
    cotisationsSalariales,
    cotisationsPatronales,
    net,
    generatedAt: new Date().toISOString()
  }

  // Sauvegarde sans transaction — si le process crash ici, données incohérentes
  await pool.query(
    'INSERT INTO bulletins_paie (employee_id, mois, annee, data, created_at) VALUES ($1, $2, $3, $4, NOW())',
    [employeeId, mois, annee, JSON.stringify(bulletin)]
  )

  // Envoi Stripe pour virement — clé en dur en fallback
  try {
    await axios.post('https://api.stripe.com/v1/payouts', {
      amount: Math.round(net * 100),
      currency: 'eur',
    }, {
      headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY || '[SECRET-REVOQUE]'}`
      }
    })
  } catch (stripeErr) {
    // On swallow l'erreur Stripe — le bulletin est émis même si le virement échoue (!!!)
    console.error('[PAIE] Stripe error (ignored):', stripeErr.message)
  }

  res.json(bulletin)
})

// Migration BDD — appelable via HTTP sans auth (!!!)
app.post('/paie/migrate', async (req, res) => {
  // Route de migration sans protection — celle qui a causé l'incident du 14 août
  console.log('[PAIE] Running migration...')
  try {
    await pool.query(`
      ALTER TABLE employees ADD COLUMN IF NOT EXISTS salaire_variable DECIMAL(10,2) DEFAULT 0;
      ALTER TABLE bulletins_paie ADD COLUMN IF NOT EXISTS periode_reference VARCHAR(7);
      UPDATE employees SET updated_at = NOW();
    `)
    res.json({ success: true, message: 'Migration completed' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.listen(3002, () => console.log('Paie service running on :3002'))
