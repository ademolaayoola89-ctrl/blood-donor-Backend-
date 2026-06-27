// ============================================================
//  Blood Donor Tracker - LASUTH Blood Donor Clinic
//  SINGLE FILE SERVER - everything in one file, no subfolders
//  
//  HOW TO RUN:
//    1. npm install
//    2. node server.js
//    3. Open http://localhost:3000
// ============================================================

require('dotenv').config()

const express    = require('express')
const cors       = require('cors')
const path       = require('path')
const jwt        = require('jsonwebtoken')
const nodemailer = require('nodemailer')
const sqlite3    = require('sqlite3').verbose()
const fs         = require('fs')

const app  = express()
const PORT = process.env.PORT || 3000
const PIN  = process.env.STAFF_PIN || '1234'
const SECRET = process.env.JWT_SECRET || 'lasuth-blood-donor-secret'

// ── Middleware ────────────────────────────────────────────────
app.use(cors({ origin: '*' }))
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.use(express.static(path.join(__dirname)))

// ── Database Setup ────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR)

const db = new sqlite3.Database(path.join(DATA_DIR, 'donors.db'), err => {
  if (err) { console.error('DB error:', err.message); process.exit(1) }
  console.log('Database connected.')
})

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS donors (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name    TEXT NOT NULL,
    last_name     TEXT NOT NULL,
    sex           TEXT NOT NULL,
    date_of_birth TEXT NOT NULL,
    age           INTEGER NOT NULL,
    phone         TEXT NOT NULL UNIQUE,
    email         TEXT,
    donation_type TEXT NOT NULL,
    don_date      TEXT NOT NULL,
    next_date     TEXT NOT NULL,
    created_at    TEXT DEFAULT (date('now')),
    updated_at    TEXT DEFAULT (date('now'))
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS sent_messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    donor_id  INTEGER NOT NULL,
    channel   TEXT NOT NULL,
    status    TEXT NOT NULL,
    sent_at   TEXT DEFAULT (datetime('now'))
  )`)

  db.run(`CREATE INDEX IF NOT EXISTS idx_phone    ON donors(phone)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_don_date ON donors(don_date)`)
})

// ── DB Helper Functions ───────────────────────────────────────
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row))
  })
}
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []))
  })
}
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      err ? reject(err) : resolve({ lastID: this.lastID, changes: this.changes })
    })
  })
}

// ── Utility Functions ─────────────────────────────────────────
function getAge(dob) {
  return Math.floor((Date.now() - new Date(dob)) / (365.25 * 24 * 3600 * 1000))
}

function getNextDate(donDate) {
  const d = new Date(donDate)
  d.setMonth(d.getMonth() + 3)
  return d.toISOString().split('T')[0]
}

function isEligible(nextDate) {
  const today = new Date(); today.setHours(0,0,0,0)
  const nd    = new Date(nextDate); nd.setHours(0,0,0,0)
  return nd <= today
}

function daysUntil(nextDate) {
  const today = new Date(); today.setHours(0,0,0,0)
  const nd    = new Date(nextDate); nd.setHours(0,0,0,0)
  return Math.ceil((nd - today) / (24 * 3600 * 1000))
}

function countdown(nextDate) {
  const days = daysUntil(nextDate)
  if (days <= 0) return 'Ready to donate now'
  const m = Math.floor(days / 30), d = days % 30
  if (m > 0 && d > 0) return `${m}mo ${d}d remaining`
  if (m > 0) return `${m} month${m > 1 ? 's' : ''} remaining`
  return `${days} day${days !== 1 ? 's' : ''} remaining`
}

function niceDate(d) {
  return new Date(d).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })
}

function formatDonor(d) {
  return {
    ...d,
    is_eligible: isEligible(d.next_date),
    eligibility: isEligible(d.next_date) ? 'YES' : 'NOT YET',
    days_until:  daysUntil(d.next_date),
    countdown:   countdown(d.next_date),
  }
}

function makeToken() {
  return jwt.sign({ role: 'staff' }, SECRET, { expiresIn: '12h' })
}

function staffOnly(req, res, next) {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim()
  if (!token) return res.status(401).json({ ok: false, message: 'Staff login required.' })
  try {
    req.staff = jwt.verify(token, SECRET)
    next()
  } catch {
    res.status(401).json({ ok: false, message: 'Session expired. Please log in again.' })
  }
}

// ── AUTH ROUTES ───────────────────────────────────────────────

// POST /api/auth/login  — donor login by name or phone
app.post('/api/auth/login', async (req, res) => {
  try {
    const { identifier } = req.body
    if (!identifier || !identifier.trim()) {
      return res.status(400).json({ ok: false, message: 'Please enter your name or phone number.' })
    }
    const val   = identifier.trim()
    const donor = await dbGet(
      `SELECT * FROM donors WHERE phone=? OR lower(first_name||' '||last_name)=lower(?) LIMIT 1`,
      [val, val]
    )
    if (!donor) {
      return res.json({ ok: true, found: false, is_staff: false, message: 'Donor not found. Please register.' })
    }
    const today  = new Date(); today.setHours(0,0,0,0)
    const nextDt = new Date(donor.next_date); nextDt.setHours(0,0,0,0)
    const flagged = nextDt > today
    return res.json({
      ok: true, found: true, is_staff: false, flagged,
      donor: {
        id: donor.id,
        name: `${donor.first_name} ${donor.last_name}`,
        phone: donor.phone,
        donation_type: donor.donation_type,
        don_date: donor.don_date,
        next_date: donor.next_date,
        is_eligible: !flagged,
      }
    })
  } catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

// POST /api/auth/staff  — staff PIN login
app.post('/api/auth/staff', (req, res) => {
  const { pin } = req.body
  if (!pin) return res.status(400).json({ ok: false, message: 'PIN is required.' })
  if (pin.toString() !== PIN.toString()) {
    return res.status(401).json({ ok: false, message: 'Incorrect PIN. Please try again.' })
  }
  return res.json({ ok: true, is_staff: true, token: makeToken() })
})

// GET /api/auth/verify
app.get('/api/auth/verify', (req, res) => {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim()
  if (!token) return res.json({ ok: true, is_staff: false })
  try {
    jwt.verify(token, SECRET)
    return res.json({ ok: true, is_staff: true })
  } catch {
    return res.json({ ok: true, is_staff: false })
  }
})

// ── DONOR ROUTES ──────────────────────────────────────────────

// GET /api/donors/stats
app.get('/api/donors/stats', async (req, res) => {
  try {
    const today     = new Date().toISOString().split('T')[0]
    const total     = (await dbGet('SELECT COUNT(*) AS n FROM donors')).n
    const voluntary = (await dbGet("SELECT COUNT(*) AS n FROM donors WHERE donation_type='voluntary'")).n
    const family    = (await dbGet("SELECT COUNT(*) AS n FROM donors WHERE donation_type='family'")).n
    const todayDon  = (await dbGet('SELECT COUNT(*) AS n FROM donors WHERE don_date=?', [today])).n
    res.json({ ok: true, stats: { total_donors: total, total_donated: total, voluntary_donors: voluntary, family_replacement: family, donated_today: todayDon } })
  } catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

// GET /api/donors/grouped
app.get('/api/donors/grouped', async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM donors ORDER BY don_date DESC, created_at DESC')
    const map  = {}
    for (const d of rows) {
      if (!map[d.don_date]) map[d.don_date] = []
      map[d.don_date].push(formatDonor(d))
    }
    const groups = Object.keys(map).sort((a,b) => b.localeCompare(a)).map(date => ({
      date, count: map[date].length, donors: map[date]
    }))
    res.json({ ok: true, groups })
  } catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

// GET /api/donors/search?q=...
app.get('/api/donors/search', async (req, res) => {
  try {
    const q    = (req.query.q || '').trim()
    if (!q) return res.status(400).json({ ok: false, message: 'Provide ?q=search term' })
    const like = `%${q}%`
    const rows = await dbAll(
      `SELECT * FROM donors WHERE (first_name||' '||last_name) LIKE ? OR phone LIKE ? OR don_date LIKE ? ORDER BY don_date DESC`,
      [like, like, like]
    )
    res.json({ ok: true, count: rows.length, donors: rows.map(formatDonor) })
  } catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

// GET /api/donors
app.get('/api/donors', async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM donors ORDER BY don_date DESC, created_at DESC')
    res.json({ ok: true, count: rows.length, donors: rows.map(formatDonor) })
  } catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

// GET /api/donors/:id
app.get('/api/donors/:id', async (req, res) => {
  try {
    const donor = await dbGet('SELECT * FROM donors WHERE id=?', [req.params.id])
    if (!donor) return res.status(404).json({ ok: false, message: 'Donor not found.' })
    res.json({ ok: true, donor: formatDonor(donor) })
  } catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

// POST /api/donors — add new donor
app.post('/api/donors', async (req, res) => {
  try {
    const { first_name, last_name, sex, date_of_birth, phone, email, donation_type, don_date } = req.body
    if (!first_name || !last_name || !sex || !date_of_birth || !phone || !donation_type || !don_date) {
      return res.status(400).json({ ok: false, message: 'All fields are required except email.' })
    }
    const existing = await dbGet('SELECT id FROM donors WHERE phone=?', [phone.trim()])
    if (existing) return res.status(409).json({ ok: false, message: 'A donor with this phone number already exists.', id: existing.id })

    const age       = getAge(date_of_birth)
    const next_date = getNextDate(don_date)
    const flagged   = !isEligible(next_date)

    const result = await dbRun(
      `INSERT INTO donors (first_name,last_name,sex,date_of_birth,age,phone,email,donation_type,don_date,next_date) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [first_name.trim(), last_name.trim(), sex, date_of_birth, age, phone.trim(), email||null, donation_type, don_date, next_date]
    )
    const newDonor = await dbGet('SELECT * FROM donors WHERE id=?', [result.lastID])
    res.status(201).json({ ok: true, message: 'Donor registered successfully.', flagged, donor: formatDonor(newDonor) })
  } catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

// PUT /api/donors/:id — edit (staff only)
app.put('/api/donors/:id', staffOnly, async (req, res) => {
  try {
    const existing = await dbGet('SELECT * FROM donors WHERE id=?', [req.params.id])
    if (!existing) return res.status(404).json({ ok: false, message: 'Donor not found.' })

    const fn  = (req.body.first_name  || existing.first_name).trim()
    const ln  = (req.body.last_name   || existing.last_name).trim()
    const sx  = req.body.sex           || existing.sex
    const dob = req.body.date_of_birth || existing.date_of_birth
    const ph  = (req.body.phone        || existing.phone).trim()
    const em  = req.body.email !== undefined ? (req.body.email || null) : existing.email
    const dt  = req.body.donation_type || existing.donation_type
    const dd  = req.body.don_date      || existing.don_date

    const age       = getAge(dob)
    const next_date = getNextDate(dd)

    await dbRun(
      `UPDATE donors SET first_name=?,last_name=?,sex=?,date_of_birth=?,age=?,phone=?,email=?,donation_type=?,don_date=?,next_date=?,updated_at=date('now') WHERE id=?`,
      [fn, ln, sx, dob, age, ph, em, dt, dd, next_date, req.params.id]
    )
    const updated = await dbGet('SELECT * FROM donors WHERE id=?', [req.params.id])
    res.json({ ok: true, message: 'Donor updated.', donor: formatDonor(updated) })
  } catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

// DELETE /api/donors/:id (staff only)
app.delete('/api/donors/:id', staffOnly, async (req, res) => {
  try {
    const donor = await dbGet('SELECT first_name,last_name FROM donors WHERE id=?', [req.params.id])
    if (!donor) return res.status(404).json({ ok: false, message: 'Donor not found.' })
    await dbRun('DELETE FROM donors WHERE id=?', [req.params.id])
    res.json({ ok: true, message: `${donor.first_name} ${donor.last_name} deleted.` })
  } catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

// ── NOTIFICATION ROUTES ───────────────────────────────────────

// GET /api/notifications?filter=all|due|notyet
app.get('/api/notifications', async (req, res) => {
  try {
    const filter = req.query.filter || 'all'
    const today  = new Date().toISOString().split('T')[0]
    let rows
    if      (filter === 'due')    rows = await dbAll(`SELECT * FROM donors WHERE next_date<=? ORDER BY next_date ASC`, [today])
    else if (filter === 'notyet') rows = await dbAll(`SELECT * FROM donors WHERE next_date>?  ORDER BY next_date ASC`, [today])
    else                          rows = await dbAll(`SELECT * FROM donors ORDER BY next_date ASC`)

    const dueCount = (await dbGet(`SELECT COUNT(*) AS n FROM donors WHERE next_date<=?`, [today])).n

    const donors = rows.map(d => ({
      id: d.id, name: `${d.first_name} ${d.last_name}`,
      first_name: d.first_name, last_name: d.last_name,
      phone: d.phone, email: d.email,
      donation_type: d.donation_type, don_date: d.don_date, next_date: d.next_date,
      eligibility: isEligible(d.next_date) ? 'YES' : 'NOT YET',
      is_due:      isEligible(d.next_date),
      days_until:  daysUntil(d.next_date),
      countdown:   countdown(d.next_date),
    }))
    res.json({ ok: true, due_count: dueCount, total: donors.length, donors })
  } catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

// ── MESSAGE ROUTES (staff only) ───────────────────────────────

function buildEmail(donor, isDue) {
  const name     = `${donor.first_name} ${donor.last_name}`
  const lastDate = niceDate(donor.don_date)
  const nextDate = niceDate(donor.next_date)
  const subject  = 'Blood Donation Reminder — LASUTH Blood Donor Clinic'
  const text = isDue
    ? `Dear ${name},\n\nYou are now eligible to donate blood again!\nLast donation: ${lastDate}\n\nPlease visit LASUTH Blood Donor Clinic soon.\n\nThank you,\nLASUTH Blood Donor Clinic`
    : `Dear ${name},\n\nThank you for donating on ${lastDate}.\nYou can donate again from ${nextDate}.\n\nThank you,\nLASUTH Blood Donor Clinic`
  return { subject, text }
}

function getMailer() {
  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: 587, secure: false,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
  })
}

// POST /api/messages/email/:id
app.post('/api/messages/email/:id', staffOnly, async (req, res) => {
  try {
    const donor = await dbGet('SELECT * FROM donors WHERE id=?', [req.params.id])
    if (!donor)       return res.status(404).json({ ok: false, message: 'Donor not found.' })
    if (!donor.email) return res.status(400).json({ ok: false, message: 'No email saved for this donor.' })
    const isDue = isEligible(donor.next_date)
    const { subject, text } = buildEmail(donor, isDue)
    await getMailer().sendMail({ from: process.env.EMAIL_FROM || process.env.EMAIL_USER, to: donor.email, subject, text })
    await dbRun(`INSERT INTO sent_messages (donor_id,channel,status) VALUES (?,?,?)`, [donor.id, 'email', 'sent'])
    res.json({ ok: true, message: `Email sent to ${donor.email}` })
  } catch (err) { res.status(500).json({ ok: false, message: `Email failed: ${err.message}` }) }
})

// POST /api/messages/sms/:id
app.post('/api/messages/sms/:id', staffOnly, async (req, res) => {
  try {
    const donor = await dbGet('SELECT * FROM donors WHERE id=?', [req.params.id])
    if (!donor) return res.status(404).json({ ok: false, message: 'Donor not found.' })
    const isDue = isEligible(donor.next_date)
    let phone = donor.phone.trim().replace(/\s+/g,'')
    if (phone.startsWith('0')) phone = '+234' + phone.slice(1)
    const msg = isDue
      ? `Dear ${donor.first_name}, you are eligible to donate blood again at LASUTH. Please visit us. Thank you!`
      : `Dear ${donor.first_name}, thank you for donating on ${niceDate(donor.don_date)}. You can donate again from ${niceDate(donor.next_date)}. LASUTH.`
    const AT = require('africastalking')
    const at = AT({ username: process.env.AT_USERNAME || 'sandbox', apiKey: process.env.AT_API_KEY || '' })
    await at.SMS.send({ to: [phone], message: msg, from: 'LASUTH' })
    await dbRun(`INSERT INTO sent_messages (donor_id,channel,status) VALUES (?,?,?)`, [donor.id, 'sms', 'sent'])
    res.json({ ok: true, message: `SMS sent to ${phone}` })
  } catch (err) { res.status(500).json({ ok: false, message: `SMS failed: ${err.message}` }) }
})

// GET /api/messages/log/:id
app.get('/api/messages/log/:id', staffOnly, async (req, res) => {
  try {
    const logs = await dbAll(`SELECT * FROM sent_messages WHERE donor_id=? ORDER BY sent_at DESC`, [req.params.id])
    res.json({ ok: true, count: logs.length, logs })
  } catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

// ── STATS & HEALTH ────────────────────────────────────────────

app.get('/api/stats', async (req, res) => {
  try {
    const today     = new Date().toISOString().split('T')[0]
    const total     = (await dbGet('SELECT COUNT(*) AS n FROM donors')).n
    const voluntary = (await dbGet("SELECT COUNT(*) AS n FROM donors WHERE donation_type='voluntary'")).n
    const family    = (await dbGet("SELECT COUNT(*) AS n FROM donors WHERE donation_type='family'")).n
    const dueNow    = (await dbGet(`SELECT COUNT(*) AS n FROM donors WHERE next_date<=?`, [today])).n
    const todayDon  = (await dbGet(`SELECT COUNT(*) AS n FROM donors WHERE don_date=?`, [today])).n
    res.json({ ok: true, stats: { total_donors: total, total_donated: total, voluntary_donors: voluntary, family_replacement: family, due_for_donation: dueNow, donated_today: todayDon } })
  } catch (err) { res.status(500).json({ ok: false, message: err.message }) }
})

app.get('/api/health', async (req, res) => {
  const count = (await dbGet('SELECT COUNT(*) AS n FROM donors').catch(() => ({ n: 0 }))).n
  res.json({ ok: true, status: 'running', app: 'Blood Donor Tracker — LASUTH', donors: count, time: new Date().toISOString() })
})

// ── 404 & Error handlers ──────────────────────────────────────
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, message: `Route not found: ${req.method} ${req.path}` })
})

app.use((err, req, res, next) => {
  console.error('Error:', err.message)
  res.status(500).json({ ok: false, message: err.message })
})

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('')
  console.log('🩸  Blood Donor Tracker — LASUTH')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`    App  →  http://localhost:${PORT}`)
  console.log(`    API  →  http://localhost:${PORT}/api/health`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('')
})
