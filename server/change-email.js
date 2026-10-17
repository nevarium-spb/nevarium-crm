// Запасной путь смены email входа, когда письмо подтверждения отправить нельзя:
// node server/change-email.js (или `npm run change-email`) в консоли сервера Timeweb.
// Доступ к консоли хостинга — само по себе подтверждение владения (как у reset-admin).
//
// Адреса запрашиваются интерактивно. Пароль не нужен и не меняется. Завершает ВСЕ сессии
// пользователя и гасит висящие ссылки из писем (иначе ссылка, отправленная на старый адрес,
// осталась бы рабочей), пишет в audit_log.
import readline from 'node:readline/promises'
import { openDb, now } from './db.js'
import { withTransaction } from './db-adapter.js'

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/** Вынесено ради теста: интерактивный ввод в vitest не запустить, а саму логику — нужно. */
export async function changeEmail(db, oldRaw, newRaw) {
  const oldEmail = String(oldRaw || '').trim().toLowerCase()
  const newEmail = String(newRaw || '').trim().toLowerCase()
  if (!EMAIL_RE.test(newEmail) || newEmail.length > 200) return { error: 'bad_input' }
  const user = await db.prepare('SELECT id, name, email, role FROM users WHERE email = ?').get(oldEmail)
  if (!user) return { error: 'not_found' }
  if (newEmail === user.email) return { error: 'bad_input' }
  if (await db.prepare('SELECT 1 FROM users WHERE email = ?').get(newEmail)) return { error: 'email_taken' }
  const ts = now()
  await withTransaction(db.pool, async (tx) => {
    await tx.prepare('UPDATE users SET email = ?, token_version = token_version + 1 WHERE id = ?').run(newEmail, user.id)
    await tx.prepare('UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(ts, user.id)
    await tx.prepare('INSERT INTO audit_log (user_id, user_email, action, entity, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(null, 'console', 'update', 'users', user.id, `email входа изменён командой change-email (консоль сервера): ${user.email} → ${newEmail}; все сессии завершены, ссылки из писем погашены`, ts)
  })
  return { user, newEmail }
}

// import.meta.main — Node 22+; fallback — как в reset-admin.js (App Platform на Node 20 его не имеет).
const isMain = import.meta.main ?? process.argv[1]?.endsWith('change-email.js')

if (isMain) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const db = await openDb(process.env.DATABASE_URL)
  let code = 0
  try {
    const oldEmail = (await rl.question('Текущий email учётной записи: ')).trim().toLowerCase()
    const newEmail = (await rl.question('Новый email: ')).trim().toLowerCase()
    const res = await changeEmail(db, oldEmail, newEmail)
    if (res.error === 'not_found') { console.error('Пользователь с таким email не найден — ничего не изменено.'); code = 1 }
    else if (res.error === 'email_taken') { console.error('Новый email уже занят другой учётной записью — ничего не изменено.'); code = 1 }
    else if (res.error) { console.error('Новый адрес некорректен или совпадает с текущим — ничего не изменено.'); code = 1 }
    else console.log(`Email для «${res.user.name}» (${res.user.role}) изменён: ${res.user.email} → ${res.newEmail}. Все сессии завершены — войдите заново с прежним паролем.`)
  } finally {
    rl.close()
    await db.pool?.end?.()
  }
  process.exit(code)
}
