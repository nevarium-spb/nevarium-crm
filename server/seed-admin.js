// Интерактивное создание первого администратора: node server/seed-admin.js
// Пароль запрашивается с консоли и НИКОГДА не живёт в env-файлах.
import readline from 'node:readline/promises'
import { openDb, now } from './db.js'
import { hashPassword } from './auth.js'

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const db = openDb(process.env.DB_FILE || './data/crm.sqlite')

const name = (await rl.question('Имя: ')).trim()
const email = (await rl.question('Email: ')).trim().toLowerCase()
const password = (await rl.question('Пароль (мин. 8 символов): ')).trim()
rl.close()

if (!name || !email.includes('@') || password.length < 8) {
  console.error('Некорректный ввод.')
  process.exit(1)
}

db.prepare('INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)').run(
  name, email, await hashPassword(password), 'admin', now()
)
console.log(`Администратор ${email} создан.`)
