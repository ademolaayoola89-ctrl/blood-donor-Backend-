// setup.js — Run once before starting the server
// node setup.js            (check only)
// node setup.js --sample   (add test donors)

const needed  = ['express','sqlite3','dotenv','jsonwebtoken','nodemailer','cors']
const missing = needed.filter(p => { try { require.resolve(p); return false } catch { return true } })

if (missing.length > 0) {
  console.log('\n❌  Please run  npm install  first!\n')
  console.log('   Missing packages:', missing.join(', '))
  console.log('\n   Type this in your terminal:')
  console.log('       npm install\n')
  process.exit(1)
}

require('dotenv').config()
const sqlite3 = require('sqlite3').verbose()
const fs      = require('fs')
const path    = require('path')

const DATA_DIR = path.join(__dirname, 'data')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR)

const db = new sqlite3.Database(path.join(DATA_DIR, 'donors.db'))

function getAge(dob) {
  return Math.floor((Date.now() - new Date(dob)) / (365.25 * 24 * 3600 * 1000))
}
function getNextDate(donDate) {
  const d = new Date(donDate); d.setMonth(d.getMonth() + 3)
  return d.toISOString().split('T')[0]
}
function dbRun(sql, params=[]) {
  return new Promise((res, rej) => db.run(sql, params, function(err) { err ? rej(err) : res({ lastID: this.lastID, changes: this.changes }) }))
}

db.serialize(async () => {
  db.run(`CREATE TABLE IF NOT EXISTS donors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL, last_name TEXT NOT NULL, sex TEXT NOT NULL,
    date_of_birth TEXT NOT NULL, age INTEGER NOT NULL, phone TEXT NOT NULL UNIQUE,
    email TEXT, donation_type TEXT NOT NULL, don_date TEXT NOT NULL, next_date TEXT NOT NULL,
    created_at TEXT DEFAULT (date('now')), updated_at TEXT DEFAULT (date('now'))
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS sent_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, donor_id INTEGER NOT NULL,
    channel TEXT NOT NULL, status TEXT NOT NULL, sent_at TEXT DEFAULT (datetime('now'))
  )`)

  setTimeout(async () => {
    console.log('\n🩸  Blood Donor Tracker — Setup')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('✅  Database ready  (data/donors.db)')
    console.log('\n📋  Settings:')
    console.log(`    Staff PIN : ${process.env.STAFF_PIN || '1234 (default)'}`)
    console.log(`    Port      : ${process.env.PORT || '3000 (default)'}`)
    console.log(`    Email     : ${process.env.EMAIL_USER || '(not configured — edit .env)'}`)

    if (process.argv.includes('--sample')) {
      console.log('\n📥  Adding sample donors...')
      const today   = new Date().toISOString().split('T')[0]
      const samples = [
        { fn:'Amaka',    ln:'Obi',     sex:'Female', dob:'1990-03-15', ph:'08012345678', em:'amaka@email.com',   type:'voluntary', date:'2024-12-10' },
        { fn:'Chukwudi', ln:'Eze',     sex:'Male',   dob:'1985-07-22', ph:'08023456789', em:'chuk@email.com',    type:'family',    date:'2025-01-05' },
        { fn:'Ngozi',    ln:'Adeyemi', sex:'Female', dob:'1995-11-30', ph:'08034567890', em:'ngozi@email.com',   type:'voluntary', date:'2025-03-01' },
        { fn:'Emeka',    ln:'Nwosu',   sex:'Male',   dob:'1988-06-18', ph:'08045678901', em:null,                type:'voluntary', date:'2025-02-20' },
        { fn:'Fatima',   ln:'Bello',   sex:'Female', dob:'1992-09-05', ph:'08056789012', em:'fatima@email.com',  type:'family',    date:'2025-05-01' },
        { fn:'Tunde',    ln:'Afolabi', sex:'Male',   dob:'1983-12-10', ph:'08067890123', em:'tunde@email.com',   type:'voluntary', date: today },
      ]
      let added = 0
      for (const s of samples) {
        try {
          const r = await dbRun(
            `INSERT OR IGNORE INTO donors (first_name,last_name,sex,date_of_birth,age,phone,email,donation_type,don_date,next_date) VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [s.fn, s.ln, s.sex, s.dob, getAge(s.dob), s.ph, s.em, s.type, s.date, getNextDate(s.date)]
          )
          if (r.changes > 0) { added++; console.log(`    ✅  ${s.fn} ${s.ln}`) }
          else console.log(`    ⏭   ${s.fn} ${s.ln} — already exists`)
        } catch (e) { console.log(`    ⚠️   ${s.fn} ${s.ln} — ${e.message}`) }
      }
      console.log(`\n    ${added} donor(s) added.`)
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('✅  Setup complete!\n')
    console.log('▶   Now start the server:')
    console.log('        node server.js\n')
    console.log(`🌐  Then open: http://localhost:${process.env.PORT || 3000}`)
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
    db.close()
    process.exit(0)
  }, 500)
})
