// @vitest-environment node
// Тарифы клиентов (ADR-019, контракт nevarium_vizor/docs/SUBSCRIPTIONS.md).
import { newDb } from 'pg-mem'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, mskToday } from './app.js'
import { hashPassword, resetThrottle } from './auth.js'
import { now } from './db.js'
import { evaluateCheck, computeOffer, runEntitlementReminders, addYearInclusive, workdaysAfter } from './entitlements.js'
import { withTransaction, maintenanceBarrier } from './db-adapter.js'

const TOKEN = 'test-nvizor-token-0123456789abcdef0123456789'
const auth = { authorization: `Bearer ${TOKEN}` }
const PHONE = '+79215551488'

// ---------- правила: чистая функция, без базы ----------

let nextId = 1
const ent = (over = {}) => ({
  id: nextId++, contactId: 1, projectId: 2, plan: 'repair', startsOn: '2026-10-10', expiresOn: '2027-10-09',
  periodDays: null, checksPerPeriod: null, objects: [], stages: ['electrical', 'plumbing', 'waterproofing', 'screed', 'plaster'],
  urgent: false, weekend: false, parentReport: '', paidAmount: 19900, creditedFrom: [], status: 'active', note: '', ...over,
})
const chk = (over = {}) => ({
  id: nextId++, entitlementId: null, contactId: 1, recordId: `r${nextId}`, objectRef: 'obj-1', stageCode: 'screed', kind: 'primary',
  photos: 10, videos: 0, reportNumber: '', parentReportNumber: '', urgent: false, weekend: false, issuedAt: '2026-11-03T09:00:00Z', ...over,
})
const input = (over = {}) => ({ objectRef: 'obj-1', stageCode: 'screed', kind: 'primary', photos: 10, videos: 0, parentReportNumber: '', urgent: false, weekend: false, ...over })
const run = (entitlements, checks, inp, today = '2026-11-10') => evaluateCheck({ entitlements, checks, input: input(inp), today })
const codes = (r) => r.warnings.map((w) => w.code)

describe('правила (раздел 4 контракта) — по тесту на каждое', () => {
  it('ok: действующий пакет, этап из пакета, не проверялся — без предупреждений', () => {
    const r = run([ent()], [], {})
    expect(r.verdict).toBe('ok')
    expect(r.warnings).toEqual([])
    expect(r.match).toMatchObject({ plan: 'repair', title: 'Ремонт под контролем', expiresOn: '2027-10-09' })
    expect(r.match.stages.find((s) => s.code === 'screed')).toEqual({ code: 'screed', title: 'стяжка', checked: false, recheckUsed: false })
  })

  it('no_entitlement: прав нет вовсе (и отменённые не считаются)', () => {
    for (const ents of [[], [ent({ status: 'cancelled' })]]) {
      const r = run(ents, [], {})
      expect(r.verdict).toBe('none')
      expect(r.match).toBeNull()
      expect(r.warnings).toEqual([{ code: 'no_entitlement', text: 'Оплаченного тарифа нет' }])
    }
  })

  it('expired: срок истёк — право всё равно сопоставлено, чтобы текст был конкретным', () => {
    const r = run([ent({ plan: 'monthly', stages: [], periodDays: 30, checksPerPeriod: 4, startsOn: '2026-10-14', expiresOn: '2026-11-12' })], [], {}, '2026-11-20')
    expect(r.verdict).toBe('warning')
    expect(r.warnings[0]).toEqual({ code: 'expired', text: 'Тариф „Объект помесячно“ истёк 12.11.2026' })
  })

  it('expiring_soon: осталось ≤ 3 дней', () => {
    const r = run([ent({ expiresOn: '2026-11-15' })], [], {}, '2026-11-13')
    expect(r.warnings).toContainEqual({ code: 'expiring_soon', text: 'Тариф истекает 15.11.2026 — через 2 дня' })
    expect(codes(run([ent({ expiresOn: '2026-11-17' })], [], {}, '2026-11-13'))).not.toContain('expiring_soon')
  })

  it('period_limit: за период уже 4 проверки (помесячный)', () => {
    const m = ent({ plan: 'monthly', stages: [], periodDays: 30, checksPerPeriod: 4, startsOn: '2026-10-16', expiresOn: '2026-11-14' })
    const checks = [1, 2, 3, 4].map((d) => chk({ entitlementId: m.id, issuedAt: `2026-10-2${d}T09:00:00Z` }))
    const r = run([m], checks, {}, '2026-11-01')
    expect(r.warnings).toContainEqual({ code: 'period_limit', text: 'Лимит периода исчерпан: 4 из 4 (период до 14.11)' })
    expect(r.match.period).toEqual({ used: 4, limit: 4, endsOn: '2026-11-14' })
  })

  it('period_limit у «Компании» — на объект, а не на все объекты сразу', () => {
    const c = ent({ plan: 'company', stages: [], periodDays: 30, checksPerPeriod: 4, objects: ['obj-1', 'obj-2'], startsOn: '2026-10-16', expiresOn: '2026-11-14' })
    const checks = [1, 2, 3, 4].map((d) => chk({ entitlementId: c.id, objectRef: 'obj-1', issuedAt: `2026-10-2${d}T09:00:00Z` }))
    expect(codes(run([c], checks, { objectRef: 'obj-1' }, '2026-11-01'))).toContain('period_limit')
    expect(codes(run([c], checks, { objectRef: 'obj-2' }, '2026-11-01'))).not.toContain('period_limit')
  })

  it('object_not_in_plan: объект не из списка тарифа', () => {
    const m = ent({ plan: 'monthly', stages: [], periodDays: 30, checksPerPeriod: 4, objects: ['obj-1'], startsOn: '2026-11-01', expiresOn: '2026-11-30' })
    const r = run([m], [], { objectRef: 'obj-9' })
    expect(r.warnings).toContainEqual({ code: 'object_not_in_plan', text: 'Объект не входит в тариф' })
  })

  it('stage_not_in_package: этап не из пакета', () => {
    const r = run([ent()], [], { stageCode: 'roof' })
    expect(r.warnings).toContainEqual({ code: 'stage_not_in_package', text: 'Этап „кровля“ не входит в „Ремонт под контролем“' })
  })

  it('stage_already_checked: этап пакета уже проверен', () => {
    const p = ent()
    const r = run([p], [chk({ entitlementId: p.id, stageCode: 'screed', issuedAt: '2026-11-03T09:00:00Z' })], {})
    expect(r.warnings).toContainEqual({ code: 'stage_already_checked', text: 'Этап „стяжка“ уже проверен 03.11 — это повторная?' })
    expect(r.match.stages.find((s) => s.code === 'screed').checked).toBe(true)
  })

  it('recheck_used: повторная по этапу уже была', () => {
    const p = ent()
    const checks = [chk({ entitlementId: p.id, stageCode: 'screed' }), chk({ entitlementId: p.id, stageCode: 'screed', kind: 'recheck' })]
    const r = run([p], checks, { kind: 'recheck', photos: 5 })
    expect(r.warnings).toContainEqual({ code: 'recheck_used', text: 'Повторная по этапу уже использована' })
  })

  it('recheck_window: с исходного отчёта прошло > 3 рабочих дней', () => {
    const p = ent()
    const checks = [chk({ entitlementId: p.id, reportNumber: 'NV-2026-000031', issuedAt: '2026-11-02T09:00:00Z' })]
    // пн 02.11 → пн 09.11: вт, ср, чт, пт, пн = 5 рабочих дней
    const r = run([p], checks, { kind: 'recheck', photos: 5, parentReportNumber: 'NV-2026-000031' }, '2026-11-09')
    expect(r.warnings).toContainEqual({ code: 'recheck_window', text: 'С отчёта NV-2026-000031 прошло 5 рабочих дней (лимит 3)' })
    expect(codes(run([p], checks, { kind: 'recheck', photos: 5, parentReportNumber: 'NV-2026-000031' }, '2026-11-05'))).not.toContain('recheck_window')
  })

  it('photo_limit: 30 у первичной, 10 у повторной', () => {
    expect(run([ent()], [], { photos: 34 }).warnings).toContainEqual({ code: 'photo_limit', text: '34 фото при лимите 30' })
    expect(codes(run([ent()], [], { photos: 30 }))).not.toContain('photo_limit')
    expect(run([ent()], [], { kind: 'recheck', photos: 11 }).warnings).toContainEqual({ code: 'photo_limit', text: '11 фото при лимите 10' })
  })

  it('video_limit: больше 2 видео', () => {
    expect(run([ent()], [], { videos: 3 }).warnings).toContainEqual({ code: 'video_limit', text: '3 видео при лимите 2' })
  })

  it('urgent_not_paid / weekend_not_paid: опция не оплачена; оплаченная — без предупреждения', () => {
    const s = ent({ plan: 'stage', stages: [] })
    const r = run([s], [], { urgent: true, weekend: true })
    expect(r.warnings).toContainEqual({ code: 'urgent_not_paid', text: 'Срочность не оплачена (+2 000 ₽)' })
    expect(codes(r)).toContain('weekend_not_paid')
    expect(codes(run([ent({ plan: 'stage', stages: [], urgent: true, weekend: true })], [], { urgent: true, weekend: true }))).toEqual([])
  })

  it('сопоставление: подходящее действующее право раньше неподходящего', () => {
    const repair = ent()
    const house = ent({ plan: 'house', stages: ['roof'] })
    expect(run([repair, house], [], { stageCode: 'roof' }).match.plan).toBe('house')
    expect(run([repair, house], [], { stageCode: 'screed' }).match.plan).toBe('repair')
  })

  it('засчитанная в пакет разовая: её проверенный этап считается пройденным в пакете', () => {
    const stage = ent({ plan: 'stage', stages: [], status: 'credited' })
    const pkg = ent({ creditedFrom: [stage.id] })
    const r = run([stage, pkg], [chk({ entitlementId: stage.id, stageCode: 'electrical' })], { stageCode: 'electrical' })
    expect(r.match.plan).toBe('repair')
    expect(codes(r)).toContain('stage_already_checked')
  })

  it('даты: год включительно и рабочие дни пн–пт', () => {
    expect(addYearInclusive('2026-10-10')).toBe('2027-10-09')
    expect(workdaysAfter('2026-11-06', '2026-11-09')).toBe(1) // пт → пн: только пн
  })

  it('offer: только разовые без пакета; дом ИЖС → «Дом под контролем»', () => {
    const s = ent({ plan: 'stage', stages: [], paidAmount: 4990 })
    expect(computeOffer([s], '2026-11-01', 'Квартира / ремонт')).toEqual({ plan: 'repair', title: 'Ремонт под контролем', price: 19900, credit: 4990, toPay: 14910 })
    expect(computeOffer([s], '2026-11-01', 'Частный дом (ИЖС)').plan).toBe('house')
    expect(computeOffer([s, ent()], '2026-11-01', '')).toBeNull()
    expect(computeOffer([ent()], '2026-11-01', '')).toBeNull()
  })
})

// ---------- API и CRM ----------

let app, cookie

async function makeApp() {
  resetThrottle()
  const mem = newDb()
  const pool = new (mem.adapters.createPg()).Pool()
  app = await buildApp({ dbConfig: pool, secure: false, nvizorToken: TOKEN, cabinetBaseUrl: 'https://nevarium-vizor.ru' })
  await app.db.prepare('INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)')
    .run('Админ', 'a@a.ru', await hashPassword('password123'), 'admin', now())
  await app.ready()
  cookie = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@a.ru', password: 'password123' } })).headers['set-cookie']
}
beforeEach(makeApp)
afterEach(async () => { await app?.close?.() })

const crm = (method, url, payload) => app.inject({ method, url, payload, headers: { cookie } })
const nv = (url, payload) => app.inject({ method: 'POST', url, payload, headers: auth })
async function vizorClient(name = 'Иван', task = 'Квартира / ремонт') {
  await app.inject({ method: 'POST', url: '/api/leads', payload: { name, contact: PHONE, task, project: 'nevarium-vizor' } })
  return (await app.db.prepare('SELECT id FROM contacts ORDER BY id DESC LIMIT 1').get()).id
}

describe('NVizor → CRM (5.1)', () => {
  it('новые роуты закрыты ключом приложения', async () => {
    for (const url of ['/api/nvizor/entitlements/evaluate', '/api/nvizor/entitlements/usage', '/api/nvizor/client-link']) {
      expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode, url).toBe(401)
    }
  })

  it('evaluate: назначили «Ремонт под контролем» в CRM → ok с остатком этапов; без тарифа — none', async () => {
    const id = await vizorClient()
    expect((await nv('/api/nvizor/entitlements/evaluate', { phone: PHONE, stageCode: 'screed' })).json()).toMatchObject({ verdict: 'none', client: { name: 'Иван' } })
    expect((await crm('POST', '/api/crm/entitlements', { contact_id: id, plan: 'repair', starts_on: '2026-10-10' })).statusCode).toBe(200)
    // другой формат того же номера находит клиента
    const res = (await nv('/api/nvizor/entitlements/evaluate', { phone: '8 (921) 555-14-88', objectRef: 'obj-1', stageCode: 'screed', kind: 'primary', photos: 28, videos: 1 })).json()
    expect(res.client).toEqual({ name: 'Иван' })
    expect(res.match).toMatchObject({ plan: 'repair', title: 'Ремонт под контролем', expiresOn: '2027-10-09', period: null })
    expect(res.match.stages).toHaveLength(5)
    expect(['ok', 'warning']).toContain(res.verdict)
    expect(res.warnings.every((w) => typeof w.code === 'string' && typeof w.text === 'string')).toBe(true)
  })

  it('usage: идемпотентно по recordId; этап становится проверенным; «вне тарифа» тоже сохраняется', async () => {
    const id = await vizorClient()
    const entId = (await crm('POST', '/api/crm/entitlements', { contact_id: id, plan: 'repair' })).json().id
    const body = { recordId: 'rec-1', entitlementId: entId, phone: PHONE, objectRef: 'obj-1', stageCode: 'screed', kind: 'primary',
      photos: 28, videos: 1, reportNumber: 'NV-2026-000031', parentReportNumber: null, urgent: false, weekend: false, issuedAt: '2026-10-10T14:05:00Z' }
    expect((await nv('/api/nvizor/entitlements/usage', body)).statusCode).toBe(201)
    expect((await nv('/api/nvizor/entitlements/usage', body)).statusCode).toBe(201)
    expect((await nv('/api/nvizor/entitlements/usage', { ...body, recordId: 'rec-2', entitlementId: null, stageCode: '' })).statusCode).toBe(201)
    expect(Number((await app.db.prepare('SELECT COUNT(*) c FROM entitlement_checks').get()).c)).toBe(2)
    const ev = (await nv('/api/nvizor/entitlements/evaluate', { phone: PHONE, stageCode: 'screed' })).json()
    expect(ev.warnings.map((w) => w.code)).toContain('stage_already_checked')
    const state = (await crm('GET', `/api/crm/contacts/${id}/entitlements`)).json()
    expect(state.checks.map((c) => c.entitlementId)).toEqual(expect.arrayContaining([entId, null]))
  })

  it('client-link: новая ссылка на каждый вызов; неизвестный телефон — 404', async () => {
    await vizorClient()
    const a = (await nv('/api/nvizor/client-link', { phone: PHONE })).json().url
    const b = (await nv('/api/nvizor/client-link', { phone: PHONE })).json().url
    expect(a).toMatch(/^https:\/\/nevarium-vizor\.ru\/#\/c\/[A-Za-z0-9_-]{43}$/)
    expect(a).not.toBe(b)
    expect((await nv('/api/nvizor/client-link', { phone: '+79990000000' })).statusCode).toBe(404)
    // в базе — только хеш, не сам ключ
    const rows = await app.db.prepare('SELECT token_hash FROM client_links').all()
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash) && !a.includes(r.token_hash))).toBe(true)
  })
})

describe('кабинет на сайте (5.2)', () => {
  const summary = (token, headers = {}) => app.inject({ method: 'POST', url: '/api/client/summary', payload: { token }, headers })

  it('по ключу — тариф и остаток, без телефона, почты, адреса и внутренних id; offer после разовой', async () => {
    const id = await vizorClient('Иван', 'Частный дом (ИЖС)')
    await crm('POST', '/api/crm/entitlements', { contact_id: id, plan: 'stage', starts_on: '2026-10-10' })
    const token = (await nv('/api/nvizor/client-link', { phone: PHONE })).json().url.split('/#/c/')[1]
    const res = await summary(token)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.client).toEqual({ name: 'Иван' })
    expect(body.entitlements[0]).toMatchObject({ plan: 'stage', title: 'Проверка этапа', status: 'active', startsOn: '2026-10-10', expiresOn: '2027-10-09' })
    expect(body.offer).toEqual({ plan: 'house', title: 'Дом под контролем', price: 29900, credit: 4990, toPay: 24910 })
    expect(res.body).not.toMatch(/921|555|Частный дом|"id"|contact_id|contactId/)
    expect((await app.db.prepare('SELECT last_used_at FROM client_links').get()).last_used_at).toBeTruthy()
  })

  it('неверный и отозванный ключ — одинаковый 404', async () => {
    const id = await vizorClient()
    const token = (await nv('/api/nvizor/client-link', { phone: PHONE })).json().url.split('/#/c/')[1]
    const wrong = await summary('x'.repeat(43))
    await crm('POST', `/api/crm/contacts/${id}/client-links/revoke-all`)
    const revoked = await summary(token)
    expect(wrong.statusCode).toBe(404)
    expect(revoked.statusCode).toBe(404)
    expect(revoked.body).toBe(wrong.body)
  })

  it('CORS — только домены сайтов из projects.origins', async () => {
    const ok = await app.inject({ method: 'OPTIONS', url: '/api/client/summary', headers: { origin: 'https://nevarium-vizor.ru' } })
    expect(ok.statusCode).toBe(204)
    expect(ok.headers['access-control-allow-origin']).toBe('https://nevarium-vizor.ru')
    const bad = await app.inject({ method: 'OPTIONS', url: '/api/client/summary', headers: { origin: 'https://evil.example' } })
    expect(bad.statusCode).toBe(403)
  })

  it('лимит по IP, как у /api/pd-requests: сверх него — 429', async () => {
    let last
    for (let i = 0; i < 31; i++) last = await summary('nope')
    expect(last.statusCode).toBe(429)
  })
})

describe('CRM: блок «Тариф»', () => {
  it('назначить «Ремонт под контролем» тестовому клиенту и увидеть остаток этапов; всё — в журнал', async () => {
    const id = await vizorClient()
    const r = await crm('POST', '/api/crm/entitlements', { contact_id: id, plan: 'repair', starts_on: '2026-10-10' })
    expect(r.statusCode).toBe(200)
    const state = (await crm('GET', `/api/crm/contacts/${id}/entitlements`)).json()
    expect(state.entitlements[0]).toMatchObject({ plan: 'repair', title: 'Ремонт под контролем', expiresOn: '2027-10-09', paidAmount: 19900 })
    expect(state.entitlements[0].stages.map((s) => s.code)).toEqual(['electrical', 'plumbing', 'waterproofing', 'screed', 'plaster'])
    const entId = state.entitlements[0].id
    await crm('PATCH', `/api/crm/entitlements/${entId}`, { expires_on: '2027-12-31', note: 'доплатил' })
    await crm('POST', `/api/crm/entitlements/${entId}/cancel`)
    const log = await app.db.prepare("SELECT detail FROM audit_log WHERE entity = 'entitlements' ORDER BY id").all()
    expect(log.map((l) => l.detail)).toEqual([
      expect.stringContaining('назначен: — → repair 2026-10-10…2027-10-09 active'),
      expect.stringMatching(/изменён: .*2027-10-09.* → .*2027-12-31/),
      expect.stringMatching(/отменён: .*active.* → .*cancelled/),
    ])
    const badges = (await crm('GET', '/api/crm/entitlements/badges')).json().items
    expect(badges[id]).toBeUndefined() // отменённый тариф значка не даёт
  })

  it('перевести в пакет: разовая засчитана деньгами и этапом, доплата 14 910 ₽', async () => {
    const id = await vizorClient()
    const stageId = (await crm('POST', '/api/crm/entitlements', { contact_id: id, plan: 'stage', starts_on: '2026-10-01' })).json().id
    await nv('/api/nvizor/entitlements/usage', { recordId: 'r-1', entitlementId: stageId, phone: PHONE, stageCode: 'electrical', kind: 'primary', issuedAt: '2026-10-02T10:00:00Z' })
    const conv = (await crm('POST', `/api/crm/contacts/${id}/entitlements/convert`, { plan: 'repair', starts_on: '2026-10-10' })).json()
    expect(conv).toMatchObject({ ok: true, credit: 4990, toPay: 14910 })
    const state = (await crm('GET', `/api/crm/contacts/${id}/entitlements`)).json()
    const pkg = state.entitlements.find((e) => e.plan === 'repair')
    expect(pkg).toMatchObject({ paidAmount: 14910, creditedFrom: [stageId], expiresOn: '2027-10-09' })
    expect(pkg.stages.find((s) => s.code === 'electrical').checked).toBe(true)
    expect(state.entitlements.find((e) => e.plan === 'stage').status).toBe('credited')
  })

  it('продлить помесячный — следующие 30 дней', async () => {
    const id = await vizorClient()
    const entId = (await crm('POST', '/api/crm/entitlements', { contact_id: id, plan: 'monthly', starts_on: mskToday(), objects: ['obj-1'] })).json().id
    const before = await app.db.prepare('SELECT expires_on FROM entitlements WHERE id = ?').get(entId)
    await crm('POST', `/api/crm/entitlements/${entId}/renew`)
    const after = await app.db.prepare('SELECT expires_on FROM entitlements WHERE id = ?').get(entId)
    expect(Date.parse(after.expires_on) - Date.parse(before.expires_on)).toBe(30 * 86400000)
  })

  it('значок в списке: действующий тариф даёт значок с предупреждениями состояния', async () => {
    const id = await vizorClient()
    await crm('POST', '/api/crm/entitlements', { contact_id: id, plan: 'monthly', starts_on: '2026-01-01', expires_on: '2026-01-30' })
    const badge = (await crm('GET', '/api/crm/entitlements/badges')).json().items[id]
    expect(badge).toMatchObject({ plan: 'monthly', title: 'Объект помесячно' })
    expect(badge.warnings.map((w) => w.code)).toContain('expired')
  })

  it('выпуск ссылки из CRM — в журнал без самого ключа', async () => {
    const id = await vizorClient()
    const url = (await crm('POST', `/api/crm/contacts/${id}/client-links`)).json().url
    const key = url.split('/#/c/')[1]
    const log = await app.db.prepare("SELECT detail FROM audit_log WHERE entity = 'client_links'").all()
    expect(log).toHaveLength(1)
    expect(log[0].detail).not.toContain(key)
  })
})

describe('152-ФЗ, дамп, напоминания', () => {
  async function seeded() {
    const id = await vizorClient()
    const entId = (await crm('POST', '/api/crm/entitlements', { contact_id: id, plan: 'repair' })).json().id
    await nv('/api/nvizor/entitlements/usage', { recordId: 'r-1', entitlementId: entId, phone: PHONE, stageCode: 'screed', issuedAt: '2026-10-10T10:00:00Z' })
    await nv('/api/nvizor/client-link', { phone: PHONE })
    return id
  }
  const counts = async () => Object.fromEntries(await Promise.all(['entitlements', 'entitlement_checks', 'client_links']
    .map(async (t) => [t, Number((await app.db.prepare(`SELECT COUNT(*) c FROM ${t}`).get()).c)])))
  const mutation = (fn) => withTransaction(app.db.pool, async (tx) => { await maintenanceBarrier(tx); return fn(tx) })

  it('обезличивание контакта удаляет тарифы, проверки и ссылки', async () => {
    const id = await seeded()
    expect(await counts()).toEqual({ entitlements: 1, entitlement_checks: 1, client_links: 1 })
    expect((await crm('POST', `/api/crm/contacts/${id}/anonymize`)).statusCode).toBe(200)
    expect(await counts()).toEqual({ entitlements: 0, entitlement_checks: 0, client_links: 0 })
  })

  it('удаление контакта (без сделок) удаляет их тоже — без ошибки внешнего ключа', async () => {
    const id = (await crm('POST', '/api/crm/contacts', { name: 'Ручной', phone: PHONE, project_id: 2 })).json().item.id
    await crm('POST', '/api/crm/entitlements', { contact_id: id, plan: 'stage' })
    await nv('/api/nvizor/client-link', { phone: PHONE })
    expect((await crm('DELETE', `/api/crm/contacts/${id}`)).statusCode).toBe(200)
    expect(await counts()).toEqual({ entitlements: 0, entitlement_checks: 0, client_links: 0 })
  })

  it('экспорт → импорт сохраняет тарифы; старый дамп без них их чистит и не падает на FK', async () => {
    await seeded()
    const dump = (await crm('GET', '/api/crm/export')).json()
    expect(dump.version).toBe(6)
    expect((await crm('POST', '/api/crm/import', dump)).statusCode).toBe(200)
    expect(await counts()).toEqual({ entitlements: 1, entitlement_checks: 1, client_links: 1 })
    const old = { ...dump, version: 5 }
    delete old.entitlements; delete old.entitlement_checks; delete old.client_links
    expect((await crm('POST', '/api/crm/import', old)).statusCode).toBe(200)
    expect(await counts()).toEqual({ entitlements: 0, entitlement_checks: 0, client_links: 0 })
  })

  it('напоминание: задача за 7 дней у помесячного, один раз; уведомление без ПДн', async () => {
    const id = await vizorClient()
    await crm('POST', '/api/crm/entitlements', { contact_id: id, plan: 'monthly', starts_on: '2026-10-10' }) // до 2026-11-08
    const queued = []
    const opts = { now, withMutation: mutation, baseUrl: 'https://crm.example', enqueue: async (_tx, kind, payload) => queued.push({ kind, payload }) }
    expect(await runEntitlementReminders(app.db, { ...opts, today: '2026-10-31' })).toBe(0) // 8 дней — рано
    expect(await runEntitlementReminders(app.db, { ...opts, today: '2026-11-01' })).toBe(1)
    expect(await runEntitlementReminders(app.db, { ...opts, today: '2026-11-02' })).toBe(0) // второй раз не напоминает
    const task = await app.db.prepare('SELECT title, contact_id FROM tasks').get()
    expect(task).toMatchObject({ contact_id: id })
    expect(task.title).toContain('Объект помесячно')
    expect(queued).toHaveLength(1)
    expect(queued[0].payload.text).not.toMatch(/Иван|921|555/)
    expect(queued[0].payload.text).toContain(`/crm/contacts/${id}`)
  })

  it('напоминание у пакета — за 30 дней', async () => {
    const id = await vizorClient()
    await crm('POST', '/api/crm/entitlements', { contact_id: id, plan: 'repair', starts_on: '2026-10-10' }) // до 2027-10-09
    const opts = { now, withMutation: mutation, enqueue: async () => {} }
    expect(await runEntitlementReminders(app.db, { ...opts, today: '2027-09-08' })).toBe(0)
    expect(await runEntitlementReminders(app.db, { ...opts, today: '2027-09-09' })).toBe(1)
  })
})
