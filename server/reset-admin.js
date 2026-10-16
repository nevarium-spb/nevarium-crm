// Запасной путь, когда восстановление по почте недоступно: node server/reset-admin.js
// (или `npm run reset-admin`) в консоли сервера Timeweb. Владелец — единственный админ,
// поэтому «забыл пароль + нет почты» без этого скрипта значило бы потерю доступа к CRM.
//
// Email и новый пароль запрашиваются ИНТЕРАКТИВНО — не аргументами командной строки: иначе
// пароль осядет в истории оболочки и списке процессов. Пароль при вводе не отображается.
// Сбрасывает ВСЕ сессии пользователя и гасит висящие ссылки из писем, пишет в audit_log
// (без пароля). Правила пароля те же, что при смене в профиле (server/password-policy.js).
import { openDb, now } from './db.js'
import { hashPassword } from './auth.js'
import { withTransaction } from './db-adapter.js'
import { checkNewPassword, MIN_ACCOUNT_PASSWORD_LENGTH, PASSWORD_REASON_TEXT } from './password-policy.js'

/** Вынесено ради теста: интерактивный ввод в vitest не запустить, а саму логику — нужно. */
export async function resetPasswordByEmail(db, emailRaw, password) {
  const email = String(emailRaw || '').trim().toLowerCase()
  const user = await db.prepare('SELECT id, name, email, role FROM users WHERE email = ?').get(email)
  if (!user) return { error: 'not_found' }
  const weak = checkNewPassword(password, user)
  if (weak) return { error: 'weak_password', reason: weak }
  const hash = await hashPassword(password)
  const ts = now()
  await withTransaction(db.pool, async (tx) => {
    await tx.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(hash, user.id)
    await tx.prepare('UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(ts, user.id)
    await tx.prepare('INSERT INTO audit_log (user_id, user_email, action, entity, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(null, 'console', 'update', 'users', user.id, 'пароль сброшен командой reset-admin (консоль сервера): все сессии завершены, ссылки из писем погашены', ts)
  })
  return { user }
}

// Ввод строки с терминала: hidden — без эха (пароль). Вне терминала (пайп) читаем строки как есть.
function makeReader() {
  const { stdin, stdout } = process
  if (!stdin.isTTY) {
    let buffered = null
    return async (question) => {
      stdout.write(question)
      buffered ??= await new Promise((resolve) => {
        const chunks = []
        stdin.on('data', (c) => chunks.push(c))
        stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').split(/\r?\n/)))
      })
      stdout.write('\n')
      return buffered.shift() ?? ''
    }
  }
  return (question, { hidden = false } = {}) => new Promise((resolve) => {
    stdout.write(question)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let buf = ''
    const finish = () => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stdout.write('\n') }
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') { finish(); return resolve(buf) }
        if (ch === '\u0003') { finish(); process.exit(130) }
        if (ch === '\u007f' || ch === '\b') {
          if (buf.length && !hidden) stdout.write('\b \b')
          buf = buf.slice(0, -1)
          continue
        }
        buf += ch
        if (!hidden) stdout.write(ch)
      }
    }
    stdin.on('data', onData)
  })
}

// import.meta.main — Node 22+; fallback — как в seed-admin.js (App Platform на Node 20 его не имеет).
const isMain = import.meta.main ?? process.argv[1]?.endsWith('reset-admin.js')

if (isMain) {
  const ask = makeReader()
  const db = await openDb(process.env.DATABASE_URL)
  let code = 0
  try {
    const email = (await ask('Email учётной записи: ')).trim().toLowerCase()
    const password = await ask(`Новый пароль (минимум ${MIN_ACCOUNT_PASSWORD_LENGTH} символов, не отображается): `, { hidden: true })
    const again = await ask('Повторите пароль: ', { hidden: true })
    if (password !== again) {
      console.error('Пароли не совпали — ничего не изменено.')
      code = 1
    } else {
      const res = await resetPasswordByEmail(db, email, password)
      if (res.error === 'not_found') { console.error('Пользователь с таким email не найден — ничего не изменено.'); code = 1 }
      else if (res.error === 'weak_password') { console.error(`Пароль не подходит: ${PASSWORD_REASON_TEXT[res.reason] || res.reason}`); code = 1 }
      else console.log(`Пароль для ${res.user.email} (${res.user.role}) изменён, все сессии завершены. Войдите с новым паролем.`)
    }
  } finally {
    await db.pool?.end?.()
  }
  process.exit(code)
}
