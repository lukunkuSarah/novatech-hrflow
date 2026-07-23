const express = require('express')
const multer = require('multer')
const { Pool } = require('pg')
const path = require('path')

const app = express()
app.use(express.json())

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

// Upload CV — pas de validation du type de fichier (vulnérabilité upload)
const storage = multer.diskStorage({
  destination: '/tmp/uploads/', // stockage local temporaire — perdu au redémarrage
  filename: (req, file, cb) => {
    cb(null, file.originalname) // nom de fichier original non sanitisé — path traversal possible
  }
})
const upload = multer({ storage }) // pas de limite de taille, pas de validation MIME

app.post('/recrutement/candidat', upload.single('cv'), async (req, res) => {
  const { nom, prenom, email, poste } = req.body

  const result = await pool.query(
    'INSERT INTO candidats (nom, prenom, email, poste, cv_path, created_at) VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *',
    [nom, prenom, email, poste, req.file?.path]
  )

  res.json(result.rows[0])
})

app.get('/recrutement/candidats', async (req, res) => {
  // Pas de pagination — retourne TOUS les candidats (des milliers potentiellement)
  const result = await pool.query('SELECT * FROM candidats ORDER BY created_at DESC')
  res.json(result.rows)
})

// Endpoint de mise à jour du statut — pas de vérification de rôle
app.patch('/recrutement/candidat/:id/statut', async (req, res) => {
  const { id } = req.params
  const { statut } = req.body
  // N'importe qui peut changer le statut d'un candidat — pas d'auth vérifiée
  await pool.query('UPDATE candidats SET statut = $1 WHERE id = $2', [statut, id])
  res.json({ success: true })
})

app.listen(3004, () => console.log('Recrutement service running on :3004'))
