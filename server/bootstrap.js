// Первый администратор без интерактивного ввода — нужен там, где нет shell-доступа
// в контейнер (App Platform может не давать консоль; seed-admin.js остаётся рабочим
// вариантом там, где доступ по SSH/exec есть).
//
// Срабатывает только если пользователей ещё нет вообще — не может создать второго
// админа поверх существующих и не может быть вызван повторно по ошибке.
import { hashPassword, MIN_ADMIN_PASSWORD_LENGTH } from './auth.js'
import { now } from './db.js'

export async function bootstrapAdmin(db, { log = console, env = process.env } = {}) {
  const { BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_PASSWORD: password, BOOTSTRAP_ADMIN_NAME: name } = env
  if (!email || !password) return false

  const existing = db.prepare('SELECT COUNT(*) c FROM users').get().c
  if (existing > 0) {
    log.warn?.('BOOTSTRAP_ADMIN_* заданы, но пользователи уже есть — пропускаю (снимите переменные из настроек)')
    return false
  }
  if (password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    log.error?.(`BOOTSTRAP_ADMIN_PASSWORD короче ${MIN_ADMIN_PASSWORD_LENGTH} символов — администратор не создан`)
    return false
  }

  db.prepare('INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)').run(
    (name || 'Админ').trim(),
    email.trim().toLowerCase(),
    await hashPassword(password),
    'admin',
    now()
  )
  log.info?.(`Администратор ${email} создан из BOOTSTRAP_ADMIN_*. Снимите эти переменные из настроек — пароль в них больше не нужен.`)
  return true
}
