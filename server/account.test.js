// @vitest-environment node
// Учётная запись, восстановление пароля, настройки администратора (ADR-020).
import { newDb } from 'pg-mem'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, mskToday } from './app.js'
import { hashPassword, resetThrottle, verifyPassword } from './auth.js'
import { now } from './db.js'
import { startOutboxWorker } from './telegram.js'
import { checkNewPassword, isCommonPassword } from './password-policy.js'
import { purgeAuthHousekeeping } from './account.js'
import { runEntitlementReminders, linkExpiryFor, addDays } from './entitlements.js'
import { resetPasswordByEmail } from './reset-admin.js'
import { withTransaction, maintenanceBarrier } from './db-adapter.js'

const TOKEN = 'test-nvizor-token-0123456789abcdef0123456789'
const GOOD = 'Zebra-Quartz-4471-xyz'
const BASE = 'https://crm.test'

let app, sent, cookie

async function makeApp({ mailConfigured = true } = {}) {
  resetThrottle()
  sent = []
  const mem = newDb()
  const pool = new (mem.adapters.createPg()).Pool()
  const mailer = { configured: mailConfigured, send: async (m) => { sent.push(m) } }
  app = await buildApp({ dbConfig: pool, secure: false, nvizorToken: TOKEN, mailer, forgotDelayMs: 0, crmBaseUrl: BASE })
  await app.db.prepare('INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)')
    .run('Владелец', 'owner@example.ru', await hashPassword('password123'), 'admin', now())
  await app.ready()
  cookie = await loginAs('owner@example.ru', 'password123')
}
beforeEach(() => makeApp())
afterEach(async () => { await app?.flushMail?.(); await app?.close?.() })

async function loginAs(email, password) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, headers: { 'user-agent': 'TestBrowser/1.0' } })
  expect(res.statusCode).toBe(200)
  return res.headers['set-cookie']
}
const crm = (method, url, payload, c = cookie) => app.inject({ method, url, payload, headers: { cookie: c } })
const cookieOf = (res) => res.headers['set-cookie']
const tokenFrom = (mail) => mail.text.match(/#t=([A-Za-z0-9_-]+)/)[1]

async function addMember() {
  await app.db.prepare('INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)')
    .run('Сотрудник', 'staff@example.ru', await hashPassword('password123'), 'member', now())
  return loginAs('staff@example.ru', 'password123')
}

describe('политика паролей: от 12 символов + локальный список частых', () => {
  it('отклоняет короткие, однообразные, частые, личные; принимает нормальный', () => {
    const u = { email: 'owner@example.ru', name: 'Владелец' }
    expect(checkNewPassword('Short-1', u)).toBe('too_short')
    expect(checkNewPassword('a'.repeat(11), u)).toBe('too_short')
    expect(checkNewPassword('ab'.repeat(8), u)).toBe('repetitive')
    expect(checkNewPassword('qwertyuiop12', u)).toBe('common')
    expect(checkNewPassword('Password2026!', u)).toBe('common') // «password» + хвост из цифр и знака
    expect(checkNewPassword('owner-Zebra-Quartz-44', u)).toBe('personal')
    expect(checkNewPassword(GOOD, u)).toBeNull()
    expect(isCommonPassword('ПАРОЛЬ123456')).toBe(true)
  })

  it('граница ровно 12: 11 — отказ, 12 — принимается (если не из списка)', () => {
    expect(checkNewPassword('Xk9#mQ2vLp4', { email: 'a@b.ru' })).toBe('too_short')
    expect(checkNewPassword('Xk9#mQ2vLp4z', { email: 'a@b.ru' })).toBeNull()
  })
})

describe('профиль', () => {
  it('смена имени — в журнал «было → стало»', async () => {
    expect((await crm('PATCH', '/api/crm/me', { name: 'Александр' })).statusCode).toBe(200)
    expect((await crm('PATCH', '/api/crm/me', { name: '  ' })).statusCode).toBe(400)
    const me = (await crm('GET', '/api/crm/me')).json()
    expect(me).toMatchObject({ name: 'Александр', email: 'owner@example.ru', mailAvailable: true })
    const log = await app.db.prepare("SELECT detail FROM audit_log WHERE entity = 'users'").all()
    expect(log[0].detail).toBe('имя: Владелец → Александр')
  })

  it('смена пароля: нужен текущий; слабый и несовпадающий отклоняются; остальные сессии сбрасываются, текущая живёт', async () => {
    const other = await loginAs('owner@example.ru', 'password123') // «второе устройство»
    expect((await crm('GET', '/api/crm/me', undefined, other)).statusCode).toBe(200)

    expect((await crm('POST', '/api/crm/me/password', { currentPassword: 'password123', newPassword: 'qwertyuiop12' })).json())
      .toMatchObject({ error: 'weak_password', reason: 'common' })
    expect((await crm('POST', '/api/crm/me/password', { currentPassword: 'password123', newPassword: GOOD, newPassword2: GOOD + 'x' })).json().error).toBe('mismatch')
    const wrong = await crm('POST', '/api/crm/me/password', { currentPassword: 'нетакой', newPassword: GOOD })
    expect(wrong.statusCode).toBe(403) // не 401: фронт принял бы за «сессии нет»
    expect(wrong.json().error).toBe('wrong_password')

    const ok = await crm('POST', '/api/crm/me/password', { currentPassword: 'password123', newPassword: GOOD, newPassword2: GOOD })
    expect(ok.statusCode).toBe(200)
    const fresh = cookieOf(ok)
    expect((await crm('GET', '/api/crm/me', undefined, fresh)).statusCode).toBe(200) // текущая — жива
    expect((await crm('GET', '/api/crm/me', undefined, other)).statusCode).toBe(401) // другая — сброшена
    expect((await crm('GET', '/api/crm/me', undefined, cookie)).statusCode).toBe(401) // старая кука тоже
    const row = await app.db.prepare('SELECT password_hash FROM users WHERE id = 1').get()
    expect(await verifyPassword(GOOD, row.password_hash)).toBe(true)
    await app.flushMail()
    expect(sent.map((m) => m.subject)).toContain('Невариум CRM — пароль изменён') // уведомление на почту
    expect(sent.every((m) => m.to === 'owner@example.ru')).toBe(true)
  })

  it('«выйти на всех устройствах» гасит все сессии, включая текущую', async () => {
    const other = await loginAs('owner@example.ru', 'password123')
    expect((await crm('POST', '/api/crm/me/logout-all')).statusCode).toBe(200)
    expect((await crm('GET', '/api/crm/me', undefined, cookie)).statusCode).toBe(401)
    expect((await crm('GET', '/api/crm/me', undefined, other)).statusCode).toBe(401)
  })

  it('история входов: дата, браузер, IP; не больше 20; старше 90 дней удаляется', async () => {
    for (let i = 0; i < 22; i++) await loginAs('owner@example.ru', 'password123')
    const { items, keepDays } = (await crm('GET', '/api/crm/me/logins')).json()
    expect(keepDays).toBe(90)
    expect(items).toHaveLength(20)
    expect(items[0]).toMatchObject({ user_agent: 'TestBrowser/1.0' })
    expect(items[0].created_at).toBeTruthy()
    await app.db.prepare('UPDATE login_events SET created_at = ? WHERE id = 1').run(new Date(Date.now() - 91 * 864e5).toISOString())
    await purgeAuthHousekeeping(app.db, { now })
    expect(Number((await app.db.prepare('SELECT COUNT(*) c FROM login_events WHERE id = 1').get()).c)).toBe(0)
  })
})

describe('смена email с подтверждением', () => {
  it('до подтверждения email прежний; письмо на НОВЫЙ со ссылкой, уведомление на СТАРЫЙ; ссылка одноразовая', async () => {
    const res = await crm('POST', '/api/crm/me/email', { currentPassword: 'password123', newEmail: 'New@Example.ru' })
    expect(res.statusCode).toBe(200)
    await app.flushMail()
    const confirm = sent.find((m) => m.to === 'new@example.ru')
    const notice = sent.find((m) => m.to === 'owner@example.ru')
    expect(confirm.text).toContain(`${BASE}/crm/confirm-email#t=`)
    expect(notice.subject).toContain('меняется')
    expect(notice.text).not.toContain('new@example.ru') // новый адрес в уведомлении замаскирован
    expect((await crm('GET', '/api/crm/me')).json().email).toBe('owner@example.ru')

    const token = tokenFrom(confirm)
    expect((await app.inject({ method: 'POST', url: '/api/auth/confirm-email', payload: { token } })).statusCode).toBe(200)
    expect((await crm('GET', '/api/crm/me')).json().email).toBe('new@example.ru')
    expect((await app.inject({ method: 'POST', url: '/api/auth/confirm-email', payload: { token } })).json().error).toBe('invalid_token')
    // в базе только хеш, не сам ключ
    const rows = await app.db.prepare('SELECT token_hash FROM auth_tokens').all()
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash) && r.token_hash !== token)).toBe(true)
  })

  it('без верного текущего пароля — отказ; занятый email — отказ; просроченная ссылка не срабатывает', async () => {
    expect((await crm('POST', '/api/crm/me/email', { currentPassword: 'нет', newEmail: 'x@example.ru' })).statusCode).toBe(403)
    await addMember()
    expect((await crm('POST', '/api/crm/me/email', { currentPassword: 'password123', newEmail: 'staff@example.ru' })).statusCode).toBe(409)
    await crm('POST', '/api/crm/me/email', { currentPassword: 'password123', newEmail: 'late@example.ru' })
    await app.flushMail()
    const token = tokenFrom(sent.find((m) => m.to === 'late@example.ru'))
    await app.db.prepare('UPDATE auth_tokens SET expires_at = ?').run(new Date(Date.now() - 60_000).toISOString())
    expect((await app.inject({ method: 'POST', url: '/api/auth/confirm-email', payload: { token } })).json().error).toBe('invalid_token')
    expect((await crm('GET', '/api/crm/me')).json().email).toBe('owner@example.ru')
  })

  it('почта не настроена — честное «недоступно», email не меняется', async () => {
    await app.close(); await makeApp({ mailConfigured: false })
    const res = await crm('POST', '/api/crm/me/email', { currentPassword: 'password123', newEmail: 'x@example.ru' })
    expect(res.statusCode).toBe(503)
    expect(res.json().error).toBe('mail_unavailable')
  })
})

describe('восстановление пароля', () => {
  const forgot = (email) => app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email } })

  it('ответ одинаковый для существующего и несуществующего адреса; письмо уходит только настоящему сотруднику', async () => {
    const known = await forgot('owner@example.ru')
    const unknown = await forgot('nobody@example.ru')
    expect(known.statusCode).toBe(200)
    expect(unknown.statusCode).toBe(known.statusCode)
    expect(unknown.body).toBe(known.body)
    await app.flushMail()
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe('owner@example.ru')
    expect(sent[0].text).toContain(`${BASE}/crm/reset#t=`)
  })

  it('время ответа не зависит от того, есть ли адрес (фиксированная пауза)', async () => {
    await app.close()
    resetThrottle(); sent = []
    const mem = newDb(); const pool = new (mem.adapters.createPg()).Pool()
    app = await buildApp({ dbConfig: pool, secure: false, mailer: { configured: true, send: async (m) => { sent.push(m) } }, forgotDelayMs: 150, crmBaseUrl: BASE })
    await app.db.prepare('INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)').run('В', 'owner@example.ru', await hashPassword('password123'), 'admin', now())
    await app.ready()
    for (const email of ['owner@example.ru', 'nobody@example.ru']) {
      const t0 = Date.now()
      await forgot(email)
      expect(Date.now() - t0).toBeGreaterThanOrEqual(140)
    }
  })

  it('сброс по ссылке: слабый пароль не тратит ключ; верный — меняет пароль, гасит ВСЕ сессии, ключ одноразовый', async () => {
    await forgot('owner@example.ru'); await app.flushMail()
    const token = tokenFrom(sent[0])
    const weak = await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token, password: 'qwertyuiop12' } })
    expect(weak.json()).toMatchObject({ error: 'weak_password', reason: 'common' })
    const ok = await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token, password: GOOD } })
    expect(ok.statusCode).toBe(200)
    expect((await crm('GET', '/api/crm/me')).statusCode).toBe(401) // старая сессия сброшена
    expect(await verifyPassword(GOOD, (await app.db.prepare('SELECT password_hash FROM users WHERE id = 1').get()).password_hash)).toBe(true)
    expect((await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token, password: GOOD + '!' } })).json().error).toBe('invalid_token')
    await app.flushMail()
    expect(sent.map((m) => m.subject)).toContain('Невариум CRM — пароль изменён')
    const log = await app.db.prepare("SELECT user_email, detail FROM audit_log WHERE entity = 'users'").all()
    expect(log[0].detail).toContain('по ссылке из письма')
    expect(log.map((l) => l.detail).join(' ')).not.toContain(GOOD)
  })

  it('новая ссылка гасит прежнюю; просроченная и чужая — invalid_token', async () => {
    await forgot('owner@example.ru'); await app.flushMail()
    const first = tokenFrom(sent[0])
    // второй запрос того же адреса (в пределах лимита 3/час) выпускает новый ключ
    await forgot('owner@example.ru'); await app.flushMail()
    const second = tokenFrom(sent[1])
    expect((await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token: first, password: GOOD } })).json().error).toBe('invalid_token')
    await app.db.prepare('UPDATE auth_tokens SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString())
    expect((await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token: second, password: GOOD } })).json().error).toBe('invalid_token')
    expect((await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token: 'x'.repeat(43), password: GOOD } })).json().error).toBe('invalid_token')
  })

  it('лимит на адрес: после 3 запросов в час письма не уходят, а ответ прежний', async () => {
    for (let i = 0; i < 5; i++) expect((await forgot('owner@example.ru')).statusCode).toBe(200)
    await app.flushMail()
    expect(sent).toHaveLength(3)
  })

  it('почта не настроена — форма честно отвечает «недоступно», ничего не пишет в базу', async () => {
    await app.close(); await makeApp({ mailConfigured: false })
    const res = await forgot('owner@example.ru')
    expect(res.statusCode).toBe(503)
    expect(res.json().error).toBe('mail_unavailable')
    expect(Number((await app.db.prepare('SELECT COUNT(*) c FROM auth_tokens').get()).c)).toBe(0)
  })

  it('письма — только сотрудникам, закрытым набором: в тексте нет данных клиентов', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Клиент Секретный', contact: '+79215551488', task: 'Квартира', project: 'nevarium-vizor' } })
    await forgot('owner@example.ru')
    await crm('POST', '/api/crm/me/email', { currentPassword: 'password123', newEmail: 'n@example.ru' })
    await app.flushMail()
    expect(sent.length).toBeGreaterThanOrEqual(3)
    expect(sent.every((m) => !/Секретный|921|555/.test(m.subject + m.text))).toBe(true)
    expect(sent.every((m) => ['owner@example.ru', 'n@example.ru'].includes(m.to))).toBe(true)
  })
})

describe('reset-admin (запасной путь из консоли сервера)', () => {
  it('меняет пароль, сбрасывает сессии и ссылки из писем, пишет в журнал без пароля; слабый — отказ', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'owner@example.ru' } }); await app.flushMail()
    expect(await resetPasswordByEmail(app.db, 'nobody@example.ru', GOOD)).toEqual({ error: 'not_found' })
    expect(await resetPasswordByEmail(app.db, 'owner@example.ru', 'qwertyuiop12')).toMatchObject({ error: 'weak_password' })
    const res = await resetPasswordByEmail(app.db, ' Owner@Example.ru ', GOOD)
    expect(res.user.email).toBe('owner@example.ru')
    expect((await crm('GET', '/api/crm/me')).statusCode).toBe(401)
    expect(await verifyPassword(GOOD, (await app.db.prepare('SELECT password_hash FROM users WHERE id = 1').get()).password_hash)).toBe(true)
    expect(Number((await app.db.prepare('SELECT COUNT(*) c FROM auth_tokens WHERE used_at IS NULL').get()).c)).toBe(0)
    const log = await app.db.prepare("SELECT user_email, detail FROM audit_log WHERE user_email = 'console'").all()
    expect(log).toHaveLength(1)
    expect(log[0].detail).not.toContain(GOOD)
  })
})

describe('настройки администратора', () => {
  it('по умолчанию равны прежним константам; менять может только admin; всё — в журнал', async () => {
    const s = (await crm('GET', '/api/crm/settings')).json()
    expect(s).toMatchObject({
      notify: { telegram: true, max: true },
      reminderDays: { stage: 30, repair: 30, house: 30, monthly: 7, company: 7 },
      freeLinkDays: 7,
    })
    const member = await addMember()
    expect((await crm('GET', '/api/crm/settings', undefined, member)).statusCode).toBe(403)
    expect((await crm('PATCH', '/api/crm/settings', { freeLinkDays: 3 }, member)).statusCode).toBe(403)
    const res = await crm('PATCH', '/api/crm/settings', { notify: { max: false }, reminderDays: { monthly: 10 }, freeLinkDays: 14 })
    expect(res.json()).toMatchObject({ notify: { telegram: true, max: false }, reminderDays: { monthly: 10 }, freeLinkDays: 14 })
    const log = await app.db.prepare("SELECT detail FROM audit_log WHERE entity = 'settings'").all()
    expect(log[0].detail).toContain('notify.max: true → false')
    expect(log[0].detail).toContain('reminder_days.monthly: 7 → 10')
    expect(log[0].detail).toContain('free_link_days: 7 → 14')
  })

  it('недопустимые значения отклоняются целиком, ничего не записывается', async () => {
    for (const bad of [{ freeLinkDays: 0 }, { freeLinkDays: 500 }, { freeLinkDays: 'x' }, { reminderDays: { monthly: -1 } },
      { reminderDays: { recheck: 5 } }, { notify: { telegram: 'yes' } }, { notify: { sms: true } }]) {
      expect((await crm('PATCH', '/api/crm/settings', { freeLinkDays: 5, ...bad })).statusCode, JSON.stringify(bad)).toBe(400)
    }
    expect((await crm('PATCH', '/api/crm/settings', {})).json().error).toBe('nothing_to_update') // пустое тело — тоже отказ
    expect(Number((await app.db.prepare('SELECT COUNT(*) c FROM settings').get()).c)).toBe(0)
  })

  it('переключатель канала: выключенный не получает уведомления и не копит очередь', async () => {
    await crm('PATCH', '/api/crm/settings', { notify: { max: false } })
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Клиент', contact: '+79215551488', task: 'x', project: 'nevarium-vizor' } })
    const calls = { tg: 0, max: 0 }
    const worker = startOutboxWorker(app.db, { senders: { tg: async () => { calls.tg++ }, max: async () => { calls.max++ } }, log: { warn() {} }, autoStart: false })
    worker.stop(); await worker.tick()
    expect(calls).toEqual({ tg: 1, max: 0 })
    // включили обратно — старое не высыпается
    await crm('PATCH', '/api/crm/settings', { notify: { max: true } })
    await worker.tick()
    expect(calls.max).toBe(0)
    const row = await app.db.prepare('SELECT max_sent_at, max_last_error FROM outbox').get()
    expect(row.max_sent_at).toBeTruthy()
    expect(row.max_last_error).toContain('отключён')
  })

  it('срок ссылки Free и дни напоминаний берутся из настроек', async () => {
    await crm('PATCH', '/api/crm/settings', { freeLinkDays: 3, reminderDays: { monthly: 2 } })
    expect(await linkExpiryFor(app.db, [], mskToday())).toBe(addDays(mskToday(), 2))
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'К', contact: '+79215551488', task: 'x', project: 'nevarium-vizor' } })
    await crm('POST', '/api/crm/entitlements', { contact_id: 1, plan: 'monthly', starts_on: '2026-10-10' }) // до 2026-11-08
    const opts = { now, enqueue: async () => {}, withMutation: (fn) => withTransaction(app.db.pool, async (tx) => { await maintenanceBarrier(tx); return fn(tx) }) }
    expect(await runEntitlementReminders(app.db, { ...opts, today: '2026-11-01' })).toBe(0) // 7 дней по умолчанию уже не действуют: теперь 2
    expect(await runEntitlementReminders(app.db, { ...opts, today: '2026-11-06' })).toBe(1)
  })

  it('настройки входят в дамп; дамп без них текущие не стирает', async () => {
    await crm('PATCH', '/api/crm/settings', { freeLinkDays: 21 })
    const dump = (await crm('GET', '/api/crm/export')).json()
    expect(dump.version).toBe(7)
    expect(dump.settings).toEqual([expect.objectContaining({ key: 'free_link_days', value: '21' })])
    const imported = await crm('POST', '/api/crm/import', dump)
    expect(imported.statusCode, imported.body).toBe(200)
    expect((await crm('GET', '/api/crm/settings')).json().freeLinkDays).toBe(21)
    const old = { ...dump, version: 6 }; delete old.settings
    const importedOld = await crm('POST', '/api/crm/import', old)
    expect(importedOld.statusCode, importedOld.body).toBe(200)
    expect((await crm('GET', '/api/crm/settings')).json().freeLinkDays).toBe(21)
  })
})

describe('тарифы клиентов — только admin; история проверок в кабинете', () => {
  it('участник читает, но не меняет; админ меняет', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'К', contact: '+79215551488', task: 'x', project: 'nevarium-vizor' } })
    const member = await addMember()
    for (const [method, url, payload] of [
      ['POST', '/api/crm/entitlements', { contact_id: 1, plan: 'stage' }],
      ['PATCH', '/api/crm/entitlements/1', { note: 'x' }],
      ['POST', '/api/crm/entitlements/1/renew', {}],
      ['POST', '/api/crm/entitlements/1/cancel', {}],
      ['POST', '/api/crm/contacts/1/entitlements/convert', { plan: 'repair' }],
      ['POST', '/api/crm/contacts/1/client-links', {}],
      ['POST', '/api/crm/contacts/1/client-links/revoke-all', {}],
    ]) {
      const res = await crm(method, url, payload, member)
      expect(res.statusCode, `${method} ${url}`).toBe(403)
      expect(res.json().error).toBe('admin_only')
    }
    expect((await crm('GET', '/api/crm/contacts/1/entitlements', undefined, member)).statusCode).toBe(200)
    expect((await crm('GET', '/api/crm/entitlements/badges', undefined, member)).statusCode).toBe(200)
    expect((await crm('POST', '/api/crm/entitlements', { contact_id: 1, plan: 'stage' })).statusCode).toBe(200)
    expect(Number((await app.db.prepare('SELECT COUNT(*) c FROM entitlements').get()).c)).toBe(1)
  })

  it('summary отдаёт checks: до 50, новые сверху, без фото, объекта и внутренних id', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Иван', contact: '+79215551488', task: 'x', project: 'nevarium-vizor' } })
    const entId = (await crm('POST', '/api/crm/entitlements', { contact_id: 1, plan: 'repair', starts_on: '2026-10-10' })).json().id
    const usage = (recordId, over) => app.inject({ method: 'POST', url: '/api/nvizor/entitlements/usage', headers: { authorization: `Bearer ${TOKEN}` },
      payload: { recordId, entitlementId: entId, phone: '+79215551488', objectRef: 'SECRET-OBJ', kind: 'primary', photos: 28, videos: 1, ...over } })
    await usage('r1', { stageCode: 'electrical', reportNumber: 'NV-2026-000001', issuedAt: '2026-10-11T09:00:00Z' })
    await usage('r2', { stageCode: 'screed', reportNumber: 'NV-2026-000002', issuedAt: '2026-10-12T09:00:00Z' })
    await usage('r3', { stageCode: 'screed', kind: 'recheck', reportNumber: 'NV-2026-000003', issuedAt: '2026-10-13T21:30:00Z' }) // 14.10 по МСК
    const link = (await app.inject({ method: 'POST', url: '/api/nvizor/client-link', headers: { authorization: `Bearer ${TOKEN}` }, payload: { phone: '+79215551488' } })).json().url
    const res = await app.inject({ method: 'POST', url: '/api/client/summary', payload: { token: link.split('/#/c/')[1] } })
    const { checks } = res.json()
    expect(checks).toEqual([
      { issuedOn: '2026-10-14', stageTitle: 'стяжка', kind: 'recheck', reportNumber: 'NV-2026-000003' },
      { issuedOn: '2026-10-12', stageTitle: 'стяжка', kind: 'primary', reportNumber: 'NV-2026-000002' },
      { issuedOn: '2026-10-11', stageTitle: 'электрика', kind: 'primary', reportNumber: 'NV-2026-000001' },
    ])
    expect(res.body).not.toMatch(/SECRET-OBJ|photos|"id"|objectRef|entitlementId/)
  })

  it('checks не больше 50', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Иван', contact: '+79215551488', task: 'x', project: 'nevarium-vizor' } })
    const entId = (await crm('POST', '/api/crm/entitlements', { contact_id: 1, plan: 'monthly', starts_on: '2026-10-10' })).json().id
    for (let i = 0; i < 55; i++) {
      await app.inject({ method: 'POST', url: '/api/nvizor/entitlements/usage', headers: { authorization: `Bearer ${TOKEN}` },
        payload: { recordId: `m${i}`, entitlementId: entId, phone: '+79215551488', kind: 'primary', reportNumber: `NV-${i}`, issuedAt: '2026-10-12T09:00:00Z' } })
    }
    const link = (await app.inject({ method: 'POST', url: '/api/nvizor/client-link', headers: { authorization: `Bearer ${TOKEN}` }, payload: { phone: '+79215551488' } })).json().url
    const { checks } = (await app.inject({ method: 'POST', url: '/api/client/summary', payload: { token: link.split('/#/c/')[1] } })).json()
    expect(checks).toHaveLength(50)
  })
})

describe('цены и лимиты — из общего файла server/shared/plans.js', () => {
  it('entitlements.js отдаёт те же цифры, что общий файл', async () => {
    const shared = await import('./shared/plans.js')
    const mine = await import('./entitlements.js')
    expect(mine.PLANS).toBe(shared.PLANS)
    expect(mine.LIMITS).toBe(shared.LIMITS)
    expect(mine.STAGES).toBe(shared.STAGES)
    expect(shared.PLANS.repair.price).toBe(19900)
  })
})
