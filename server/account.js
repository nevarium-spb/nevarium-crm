// Учётная запись сотрудника и настройки администратора (ADR-020):
//   профиль (имя, email с подтверждением, пароль), «выйти везде», история входов,
//   восстановление пароля по почте, настройки (уведомления, сроки напоминаний, срок кабинета Free).
//
// Почта (server/mailer.js) — только служебная и только сотрудникам; клиентских данных в
// письмах нет (152-ФЗ, Gmail — зарубежный канал). Ключи из писем — 32 случайных байта, в
// базе только SHA-256, живут 30 минут и срабатывают один раз (auth_tokens).
import { hashPassword, verifyPassword, verifyOrFake, reserveVerify, loginSucceeded, sleep } from './auth.js'
import { hashToken, newToken } from './entitlements.js'
import { checkNewPassword, MIN_ACCOUNT_PASSWORD_LENGTH } from './password-policy.js'
import { loadSettings, parseSettingsPatch, settingsView, DEFAULTS } from './settings.js'

export const TOKEN_TTL_MINUTES = 30
export const LOGIN_HISTORY_DAYS = 90
export const LOGIN_HISTORY_SHOWN = 20

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const str = (v, max) => String(v ?? '').trim().slice(0, max)

const maskEmail = (e) => { const [l, d] = String(e).split('@'); return `${l.slice(0, 1)}***@${d}` }

// Закрытый набор писем: другого содержимого этот канал отправить не может.
const TEMPLATES = {
  password_reset: ({ link }) => ({
    subject: 'Невариум CRM — восстановление пароля',
    text: `Вы (или кто-то от вашего имени) запросили восстановление пароля в Невариум CRM.\n\nСсылка для нового пароля — действует ${TOKEN_TTL_MINUTES} минут и сработает один раз:\n${link}\n\nЕсли вы ничего не запрашивали — просто проигнорируйте письмо, пароль не изменится.`,
  }),
  password_changed: () => ({
    subject: 'Невариум CRM — пароль изменён',
    text: 'Пароль вашей учётной записи в Невариум CRM изменён, все остальные сессии завершены.\n\nЕсли это были не вы — немедленно восстановите пароль по ссылке «Забыли пароль?» на странице входа и проверьте историю входов в «Настройках».',
  }),
  email_change_confirm: ({ link }) => ({
    subject: 'Невариум CRM — подтвердите новый email',
    text: `Этот адрес указан как новый email для входа в Невариум CRM.\n\nЧтобы подтвердить смену, откройте ссылку (действует ${TOKEN_TTL_MINUTES} минут, сработает один раз):\n${link}\n\nЕсли вы ничего не меняли — проигнорируйте письмо, ничего не произойдёт.`,
  }),
  email_change_notice: ({ masked }) => ({
    subject: 'Невариум CRM — email вашей учётной записи меняется',
    text: `Email вашей учётной записи в Невариум CRM меняется на ${masked}.\n\nСмена вступит в силу только после подтверждения по ссылке из письма на новый адрес (30 минут). Если это были не вы — немедленно смените пароль в «Настройках» и проверьте историю входов.`,
  }),
}

/** Фиксируем вход: дата, браузер, IP. Сбой записи не должен мешать входу. */
export async function recordLogin(db, user, req, now) {
  try {
    await db.prepare('INSERT INTO login_events (user_id, ip, user_agent, created_at) VALUES (?, ?, ?, ?)')
      .run(user.id, str(req.ip, 80), str(req.headers?.['user-agent'], 300), now())
  } catch { /* история — справочная, вход важнее */ }
}

/** Раз в сутки: история входов старше 90 дней и отработанные/просроченные ссылки из писем — убрать. */
export async function purgeAuthHousekeeping(db, { now }) {
  const base = Date.parse(now())
  await db.prepare('DELETE FROM login_events WHERE created_at < ?').run(new Date(base - LOGIN_HISTORY_DAYS * 864e5).toISOString())
  await db.prepare('DELETE FROM auth_tokens WHERE expires_at < ?').run(new Date(base - 864e5).toISOString())
}

export function scheduleAuthHousekeeping(db, { now, log = console, intervalMs = 6 * 3600_000 }) {
  const tick = async () => { try { await purgeAuthHousekeeping(db, { now }) } catch (err) { log.error?.(`auth housekeeping: ${err}`) } }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  tick()
  return { tick, stop: () => clearInterval(timer) }
}

/**
 * @param deps.setSession — (reply, user{id, token_version}) выставляет cookie сессии
 * @param deps.clearSession — (reply) убирает cookie
 * @param deps.forgotDelayMs — одинаковая задержка ответа «забыли пароль» (не выдаёт, есть ли адрес)
 */
export function registerAccountRoutes(app, deps) {
  const { db, withMutation, audit, now, mailer, baseUrl, hardRateLimited, setSession, clearSession, log = console, forgotDelayMs = 700 } = deps
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
  const mailAvailable = () => Boolean(mailer?.configured && base)

  // Письма уходят «в фоне»: тесты и закрытие приложения ждут их через app.flushMail().
  const pending = new Set()
  const track = (p) => { pending.add(p); p.finally(() => pending.delete(p)); return p }
  app.decorate('flushMail', async () => { while (pending.size) await Promise.allSettled([...pending]) })

  /** Единственная точка отправки: шаблон из закрытого набора + получатель — сотрудник или подтверждаемый им новый адрес. */
  async function sendStaff(kind, to, vars = {}, { allowAlso = null } = {}) {
    const tpl = TEMPLATES[kind]
    if (!tpl) throw new Error('unknown_mail_kind')
    const addr = String(to).toLowerCase()
    if (addr !== String(allowAlso || '').toLowerCase() && !(await db.prepare('SELECT 1 FROM users WHERE email = ?').get(addr))) {
      throw new Error('recipient_not_staff')
    }
    await mailer.send({ to: addr, ...tpl(vars) })
  }
  const sendQuietly = (kind, to, vars, opts) =>
    track(sendStaff(kind, to, vars, opts).catch((err) => log.warn?.(`mail ${kind}: ${err.message}`)))

  async function createToken(tx, { kind, userId, newEmail = null }) {
    const ts = now()
    await tx.prepare('UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND kind = ? AND used_at IS NULL').run(ts, userId, kind)
    const token = newToken()
    await tx.prepare('INSERT INTO auth_tokens (kind, user_id, token_hash, new_email, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(kind, userId, hashToken(token), newEmail, new Date(Date.now() + TOKEN_TTL_MINUTES * 60_000).toISOString(), ts)
    return token
  }
  async function findToken(runner, kind, token) {
    if (typeof token !== 'string' || !token || token.length > 200) return null
    const row = await runner.prepare('SELECT * FROM auth_tokens WHERE token_hash = ? AND kind = ?').get(hashToken(token), kind)
    return row && !row.used_at && row.expires_at > now() ? row : null
  }
  // Атомарно «потратить» ключ: второй такой же запрос получает 0 изменённых строк.
  async function spendToken(tx, row) {
    const res = await tx.prepare('UPDATE auth_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL').run(now(), row.id)
    return (res?.changes ?? 0) === 1
  }
  const fail = (code, body = {}) => { const e = new Error('account_rejected'); e.accountFail = { code, body }; throw e }
  const failure = (err, reply) => {
    if (err.accountFail) return reply.code(err.accountFail.code).send(err.accountFail.body)
    throw err
  }

  // Проверка ТЕКУЩЕГО пароля на тех же счётчиках, что и вход: подбор пароля через профиль
  // не легче, чем через форму входа. Ответ — 403, не 401: 401 фронт трактует как «сессии нет».
  async function currentPasswordOk(req, user, password) {
    const row = await db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id)
    if (!row || typeof password !== 'string' || !password) return false
    const key = `email:${user.email}`
    const wait = reserveVerify(key, { durable: true })
    if (wait) await sleep(wait)
    const ok = await verifyOrFake(key, req.ip, () => verifyPassword(password, row.password_hash))
    if (ok) loginSucceeded(key, { durable: true })
    return ok
  }

  // ---------- публичные: восстановление пароля, подтверждение email ----------

  // Лимит попыток на АДРЕС — молча (ответ тот же): иначе по реакции видно, что адрес есть.
  const forgotByEmail = new Map()
  function addressLimited(email) {
    const t = Date.now()
    const list = (forgotByEmail.get(email) || []).filter((x) => t - x < 3600_000)
    if (!forgotByEmail.has(email) && forgotByEmail.size >= 5000) forgotByEmail.delete(forgotByEmail.keys().next().value)
    if (list.length >= 3) { forgotByEmail.set(email, list); return true }
    list.push(t)
    forgotByEmail.set(email, list)
    return false
  }

  async function processForgot(email) {
    if (!email || email.length > 200 || addressLimited(email)) return
    const user = await db.prepare('SELECT id, email FROM users WHERE email = ?').get(email)
    if (!user) return
    const token = await withMutation((tx) => createToken(tx, { kind: 'password_reset', userId: user.id }))
    await sendStaff('password_reset', user.email, { link: `${base}/crm/reset#t=${token}` })
  }

  app.post('/api/auth/forgot', { bodyLimit: 2048 }, async (req, reply) => {
    // Недоступность почты — свойство сервера, не адреса: честный ответ ничего не выдаёт.
    if (!mailAvailable()) return reply.code(503).send({ error: 'mail_unavailable' })
    if (hardRateLimited('auth_forgot', req.ip)) return reply.code(429).send({ error: 'throttled' })
    const email = str(req.body?.email, 200).toLowerCase()
    // Работа идёт «в фоне», а ответ — через ФИКСИРОВАННУЮ паузу: время ответа не зависит от
    // того, есть ли адрес (поиск, запись ключа и SMTP остаются за кадром).
    track(processForgot(email).catch((err) => log.warn?.(`forgot: ${err.message}`)))
    await sleep(forgotDelayMs)
    return { ok: true }
  })

  app.post('/api/auth/reset', { bodyLimit: 4096 }, async (req, reply) => {
    if (hardRateLimited('auth_token', req.ip)) return reply.code(429).send({ error: 'throttled' })
    const password = typeof req.body?.password === 'string' ? req.body.password : ''
    const row = await findToken(db, 'password_reset', req.body?.token)
    if (!row) return reply.code(400).send({ error: 'invalid_token' })
    const user = await db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(row.user_id)
    if (!user) return reply.code(400).send({ error: 'invalid_token' })
    // Слабый пароль — отказ ДО траты ключа: человек исправит его по той же ссылке.
    const weak = checkNewPassword(password, user)
    if (weak) return reply.code(400).send({ error: 'weak_password', reason: weak })
    const hash = await hashPassword(password)
    try {
      await withMutation(async (tx) => {
        if (!(await spendToken(tx, row))) fail(400, { error: 'invalid_token' })
        await tx.prepare('UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND kind = ? AND used_at IS NULL').run(now(), user.id, 'password_reset')
        await tx.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(hash, user.id)
        await audit({ user }, 'update', 'users', user.id, 'пароль изменён по ссылке из письма: все сессии сброшены', tx)
      })
    } catch (err) { return failure(err, reply) }
    sendQuietly('password_changed', user.email)
    return { ok: true }
  })

  app.post('/api/auth/confirm-email', { bodyLimit: 2048 }, async (req, reply) => {
    if (hardRateLimited('auth_token', req.ip)) return reply.code(429).send({ error: 'throttled' })
    const row = await findToken(db, 'email_change', req.body?.token)
    if (!row || !row.new_email) return reply.code(400).send({ error: 'invalid_token' })
    try {
      await withMutation(async (tx) => {
        if (!(await spendToken(tx, row))) fail(400, { error: 'invalid_token' })
        const user = await tx.prepare('SELECT id, email FROM users WHERE id = ?').get(row.user_id)
        if (!user) fail(400, { error: 'invalid_token' })
        if (await tx.prepare('SELECT 1 FROM users WHERE email = ? AND id <> ?').get(row.new_email, user.id)) fail(409, { error: 'email_taken' })
        await tx.prepare('UPDATE users SET email = ? WHERE id = ?').run(row.new_email, user.id)
        await audit({ user: { id: user.id, email: row.new_email } }, 'update', 'users', user.id, `email для входа: ${user.email} → ${row.new_email}`, tx)
      })
    } catch (err) { return failure(err, reply) }
    return { ok: true }
  })

  // ---------- профиль (любой вошедший — свой) ----------

  app.get('/api/crm/me', async (req) => ({
    id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role,
    mailAvailable: mailAvailable(), minPasswordLength: MIN_ACCOUNT_PASSWORD_LENGTH,
  }))

  app.patch('/api/crm/me', { bodyLimit: 2048 }, async (req, reply) => {
    const name = str(req.body?.name, 100)
    if (!name) return reply.code(400).send({ error: 'bad_input' })
    await withMutation(async (tx) => {
      await tx.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id)
      await audit(req, 'update', 'users', req.user.id, `имя: ${req.user.name} → ${name}`, tx)
    })
    return { ok: true, name }
  })

  app.post('/api/crm/me/email', { bodyLimit: 4096 }, async (req, reply) => {
    if (!mailAvailable()) return reply.code(503).send({ error: 'mail_unavailable' })
    const newEmail = str(req.body?.newEmail, 200).toLowerCase()
    if (!EMAIL_RE.test(newEmail) || newEmail === req.user.email) return reply.code(400).send({ error: 'bad_input' })
    if (!(await currentPasswordOk(req, req.user, req.body?.currentPassword))) return reply.code(403).send({ error: 'wrong_password' })
    if (await db.prepare('SELECT 1 FROM users WHERE email = ?').get(newEmail)) return reply.code(409).send({ error: 'email_taken' })
    const token = await withMutation(async (tx) => {
      const t = await createToken(tx, { kind: 'email_change', userId: req.user.id, newEmail })
      await audit(req, 'update', 'users', req.user.id, `запрошена смена email: ${req.user.email} → ${newEmail} (ждёт подтверждения)`, tx)
      return t
    })
    try {
      await sendStaff('email_change_confirm', newEmail, { link: `${base}/crm/confirm-email#t=${token}` }, { allowAlso: newEmail })
    } catch (err) {
      await db.prepare('UPDATE auth_tokens SET used_at = ? WHERE token_hash = ?').run(now(), hashToken(token))
      log.warn?.(`mail email_change_confirm: ${err.message}`)
      return reply.code(502).send({ error: 'mail_failed' })
    }
    sendQuietly('email_change_notice', req.user.email, { masked: maskEmail(newEmail) })
    return { ok: true }
  })

  app.post('/api/crm/me/password', { bodyLimit: 4096 }, async (req, reply) => {
    const { currentPassword, newPassword, newPassword2 } = req.body ?? {}
    if (typeof newPassword !== 'string') return reply.code(400).send({ error: 'bad_input' })
    if (newPassword2 !== undefined && newPassword2 !== newPassword) return reply.code(400).send({ error: 'mismatch' })
    const weak = checkNewPassword(newPassword, req.user)
    if (weak) return reply.code(400).send({ error: 'weak_password', reason: weak })
    if (!(await currentPasswordOk(req, req.user, currentPassword))) return reply.code(403).send({ error: 'wrong_password' })
    const hash = await hashPassword(newPassword)
    const version = await withMutation(async (tx) => {
      await tx.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(hash, req.user.id)
      await audit(req, 'update', 'users', req.user.id, 'пароль изменён в профиле: остальные сессии сброшены', tx)
      return (await tx.prepare('SELECT token_version FROM users WHERE id = ?').get(req.user.id)).token_version
    })
    setSession(reply, { id: req.user.id, token_version: version }) // текущая сессия остаётся, остальные — нет
    if (mailAvailable()) sendQuietly('password_changed', req.user.email)
    return { ok: true }
  })

  app.post('/api/crm/me/logout-all', async (req, reply) => {
    await withMutation(async (tx) => {
      await tx.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(req.user.id)
      await audit(req, 'update', 'users', req.user.id, 'выход на всех устройствах', tx)
    })
    clearSession(reply)
    return { ok: true }
  })

  app.get('/api/crm/me/logins', async (req) => ({
    items: await db.prepare('SELECT id, ip, user_agent, created_at FROM login_events WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(req.user.id, LOGIN_HISTORY_SHOWN),
    keepDays: LOGIN_HISTORY_DAYS,
  }))

  // ---------- настройки (только admin) ----------

  app.get('/api/crm/settings', async (req, reply) => {
    if (req.user.role !== 'admin') return reply.code(403).send({ error: 'admin_only' })
    return { ...settingsView(await loadSettings(db)), defaults: settingsView(DEFAULTS), mailAvailable: mailAvailable() }
  })

  app.patch('/api/crm/settings', { bodyLimit: 4096 }, async (req, reply) => {
    if (req.user.role !== 'admin') return reply.code(403).send({ error: 'admin_only' })
    const parsed = parseSettingsPatch(req.body)
    if (parsed.error) return reply.code(400).send({ error: parsed.error })
    await withMutation(async (tx) => {
      const before = await loadSettings(tx)
      const ts = now()
      const diffs = []
      for (const [key, value] of Object.entries(parsed.changes)) {
        if (before[key] === value) continue
        await tx.prepare('DELETE FROM settings WHERE key = ?').run(key)
        await tx.prepare('INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)').run(key, JSON.stringify(value), ts, req.user.id)
        diffs.push(`${key}: ${before[key]} → ${value}`)
      }
      if (diffs.length) await audit(req, 'update', 'settings', null, diffs.join('; '), tx)
    })
    return { ok: true, ...settingsView(await loadSettings(db)) }
  })
}
