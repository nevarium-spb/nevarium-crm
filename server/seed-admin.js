// Интерактивное создание первого администратора: node server/seed-admin.js
// Пароль запрашивается с консоли и НИКОГДА не живёт в env-файлах.
import readline from 'node:readline/promises'
import { openDb, now } from './db.js'
import { hashPassword, MIN_ADMIN_PASSWORD_LENGTH } from './auth.js'

// Вынесено отдельно ради теста: интерактивный readline не запустить в vitest,
// а проверку — можно и нужно. Этот путь создаёт ТОЛЬКО admin (роль ниже
// захардкожена) — порог тот же, что у bootstrap.js и POST /api/crm/users
// с role=admin. Раньше здесь было 8 — независимый аудит поймал, что это давало
// обойти общий минимум для админа через единственный путь создания первого
// пользователя, где нет shell-проверки формы.
export function validSeedInput(name, email, password) {
  return Boolean(name) && email.includes('@') && password.length >= MIN_ADMIN_PASSWORD_LENGTH
}

// import.meta.main — Node 22+; на более старых сработает fallback ниже (Node 20
// на App Platform его не имеет, а именно там этот скрипт и запускают вручную).
const isMain = import.meta.main ?? process.argv[1]?.endsWith('seed-admin.js')

if (isMain) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const db = openDb(process.env.DB_FILE || './data/crm.sqlite')

  const name = (await rl.question('Имя: ')).trim()
  const email = (await rl.question('Email: ')).trim().toLowerCase()
  const password = (await rl.question(`Пароль (мин. ${MIN_ADMIN_PASSWORD_LENGTH} символов — это учётка admin): `)).trim()
  rl.close()

  if (!validSeedInput(name, email, password)) {
    console.error('Некорректный ввод.')
    process.exit(1)
  }

  db.prepare('INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)').run(
    name, email, await hashPassword(password), 'admin', now()
  )
  console.log(`Администратор ${email} создан.`)
}
