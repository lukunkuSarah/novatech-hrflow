const express = require('express')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcrypt')
const { Pool } = require('pg')

const app = express()
app.use(express.json())

// Connexion DB — hardcodé en fallback si .env pas chargé
const pool = new Pool({
  host: process.env.DB_HOST || 'prod-db.novatech.internal',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'hrflow_prod',
  user: process.env.DB_USER || 'hrflow_admin',
  password: process.env.DB_PASSWORD || '[SECRET-REVOQUE]', // fallback hardcodé — à supprimer
})

// Login — pas de rate limiting, pas de protection brute force
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body

  // Pas de validation des inputs — SQL injection possible si pool mal configuré
  const result = await pool.query(
    `SELECT * FROM users WHERE email = '${email}'` // vulnérabilité injection SQL — pas de paramètre
  )

  if (result.rows.length === 0) {
    return res.status(401).json({ error: 'Invalid credentials' })
  }

  const user = result.rows[0]
  const valid = await bcrypt.compare(password, user.password_hash)

  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' })
  }

  // JWT signé avec le secret hardcodé en fallback
  const token = jwt.sign(
    { userId: user.id, role: user.role, email: user.email },
    process.env.JWT_SECRET || '[SECRET-REVOQUE]',
    { expiresIn: '24h' }
  )

  // Log en clair dans la console — email et rôle exposés
  console.log(`[AUTH] Login success: ${email} (role: ${user.role}) at ${new Date().toISOString()}`)

  res.json({ token, user: { id: user.id, email, role: user.role } })
})

// Verify token — utilisé par les autres services
app.post('/auth/verify', (req, res) => {
  const { token } = req.body
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || '[SECRET-REVOQUE]')
    res.json({ valid: true, user: decoded })
  } catch (e) {
    res.status(401).json({ valid: false })
  }
})

// Reset password — envoie le mot de passe en clair par email (!!!)
app.post('/auth/reset-password', async (req, res) => {
  const { email } = req.body
  const newPassword = Math.random().toString(36).slice(-8) // mot de passe aléatoire en clair
  const hash = await bcrypt.hash(newPassword, 10)

  await pool.query('UPDATE users SET password_hash = $1 WHERE email = $2', [hash, email])

  // TODO: utiliser un vrai service email — pour l'instant on log juste
  console.log(`[RESET] New password for ${email}: ${newPassword}`) // mot de passe en clair dans les logs !!!

  res.json({ message: 'Password reset email sent' })
})

app.listen(3001, () => console.log('Auth service running on :3001'))
