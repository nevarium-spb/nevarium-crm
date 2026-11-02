// @vitest-environment node
// Вход клиента в кабинет через VK ID (ADR-031; задание сайта 2026-11-02). Живой VK не нужен: fetch подменён.
// Общую механику (сессии, лимиты, отзыв ссылок) проверяет client-auth.test.js на Яндексе — здесь то, что своё у VK и у связки провайдеров.
import pg from 'pg'
import { newDb } from 'pg-mem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { hashPassword, resetThrottle } from './auth.js'
import { now } from './db.js'

const TOKEN = 'test-nvizor-token-0123456789abcdef0123456789'
const SITE = 'https://nevarium-vizor.ru'
const PHONE = '+79215551488'
const VK_USER = 123456789

// TEST_DATABASE_URL — тот же набор на настоящем Postgres, своя схема на тест (как в client-auth.test.js).
const REAL_PG = process.env.TEST_DATABASE_URL || ''
let schemaSeq = 0
let currentPool
async function makePool() {
  if (!REAL_PG) return new (newDb().adapters.createPg()).Pool()
  const schema = `v${process.pid}_${process.env.VITEST_WORKER_ID ?? 0}_${++schemaSeq}`
  const admin = new pg.Pool({ connectionString: REAL_PG, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  await admin.end()
  const pool = new pg.Pool({ connectionString: REAL_PG, options: `-c search_path="${schema}" -c lock_timeout=5000ms`, max: 4 })
  pool.__schema = schema
  return pool
}
async function dropPool(pool) {
  if (!REAL_PG || !pool?.__schema) return
  try { await pool.end() } catch { /* уже закрыт вместе с приложением */ }
  const admin = new pg.Pool({ connectionString: REAL_PG, max: 1 })
  await admin.query(`DROP SCHEMA "${pool.__schema}" CASCADE`)
  await admin.end()
}

let app, cookie
let vk // что «отвечает VK»: { userId, status, echoState, noUserId }
let fetched

async function makeApp({ vkOn = true, yandexOn = false } = {}) {
  resetThrottle()
  if (vkOn) process.env.VK_OAUTH_CLIENT_ID = '54000001'
  else delete process.env.VK_OAUTH_CLIENT_ID
  if (yandexOn) { process.env.YANDEX_OAUTH_CLIENT_ID = 'y-id'; process.env.YANDEX_OAUTH_CLIENT_SECRET = 'y-secret' }
  else { delete process.env.YANDEX_OAUTH_CLIENT_ID; delete process.env.YANDEX_OAUTH_CLIENT_SECRET }
  await dropPool(currentPool)
  const pool = currentPool = await makePool()
  app = await buildApp({ dbConfig: pool, secure: false, nvizorToken: TOKEN, cabinetBaseUrl: SITE, crmBaseUrl: 'https://crm-nevarium.ru' })
  await app.db.prepare('INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)')
    .run('Админ', 'a@a.ru', await hashPassword('password123'), 'admin', now())
  await app.ready()
  cookie = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@a.ru', password: 'password123' } })).headers['set-cookie']
}

beforeEach(async () => {
  vk = { userId: VK_USER, status: 200, echoState: true, noUserId: false }
  fetched = []
  vi.stubGlobal('fetch', async (url, init = {}) => {
    fetched.push({ url: String(url), init })
    if (String(url) === 'https://id.vk.ru/oauth2/auth') {
      if (vk.status !== 200) return new Response('{"error":"invalid_token"}', { status: vk.status })
      const sent = new URLSearchParams(String(init.body))
      const body = { access_token: 'vk-access-token', refresh_token: 'vk-refresh-token', token_type: 'Bearer', expires_in: 3600, ...(vk.noUserId ? {} : { user_id: vk.userId }) }
      if (vk.echoState) body.state = vk.echoState === true ? sent.get('state') : vk.echoState
      return new Response(JSON.stringify(body), { status: 200 })
    }
    throw new Error(`неожиданный запрос ${url}`)
  })
  await makeApp()
})
afterEach(async () => {
  vi.unstubAllGlobals()
  try { await app?.close?.() } finally { await dropPool(currentPool); currentPool = null }
})

const nv = (url, payload) => app.inject({ method: 'POST', url, payload, headers: { authorization: `Bearer ${TOKEN}` } })
const post = (url, payload, origin = SITE) => app.inject({ method: 'POST', url, payload, headers: origin ? { origin } : {} })
const summary = (token) => post('/api/client/summary', { token })

async function vizorClient(name = 'Иван', phone = PHONE) {
  await app.inject({ method: 'POST', url: '/api/leads', payload: { name, contact: phone, task: 'Квартира / ремонт', project: 'nevarium-vizor' } })
  return (await app.db.prepare('SELECT id FROM contacts ORDER BY id DESC LIMIT 1').get()).id
}
const linkKey = async (phone = PHONE) => (await nv('/api/nvizor/client-link', { phone })).json().url.split('/#/c/')[1]

/** start → (VK «вернул» code и device_id) → callback; возвращает параметры редиректа из фрагмента. */
async function viaVk(body, { userId = vk.userId, query = '&device_id=dev-123' } = {}) {
  vk.userId = userId
  const started = await post('/api/client/auth/vk/start', body)
  expect(started.statusCode, started.body).toBe(200)
  const state = new URL(started.json().url).searchParams.get('state')
  const cb = await app.inject({ method: 'GET', url: `/api/client/auth/vk/callback?code=the-code&state=${encodeURIComponent(state)}${query}` })
  expect(cb.statusCode).toBe(302)
  const location = cb.headers.location
  expect(location.startsWith(`${SITE}/#/vk?`)).toBe(true)
  const params = new URLSearchParams(location.split('#/vk?')[1])
  return { state, status: params.get('status'), ticket: params.get('ticket'), location }
}

describe('настройка', () => {
  it('без VK_OAUTH_CLIENT_ID: start — 503, в summary нет auth.vk', async () => {
    await app.close()
    await makeApp({ vkOn: false })
    await vizorClient()
    const token = await linkKey()
    expect((await post('/api/client/auth/vk/start', { intent: 'link', token })).statusCode).toBe(503)
    expect((await post('/api/client/auth/vk/start', { intent: 'login' })).statusCode).toBe(503)
    expect((await post('/api/client/auth/vk/start', { intent: 'login' })).json()).toEqual({ error: 'vk_unavailable' })
    expect((await summary(token)).json()).not.toHaveProperty('auth')
  })

  it('провайдеры независимы: настроен только VK — в summary только auth.vk; оба — оба', async () => {
    await vizorClient()
    const token = await linkKey()
    expect((await summary(token)).json().auth).toEqual({ vk: { linked: false } })
    await app.close()
    await makeApp({ yandexOn: true })
    await vizorClient()
    expect((await summary(await linkKey())).json().auth).toEqual({ yandex: { linked: false }, vk: { linked: false } })
  })
})

describe('start', () => {
  it('отдаёт адрес id.vk.ru: PKCE S256, точный redirect_uri, без scope и без секрета; в базе только хеш state', async () => {
    await vizorClient()
    const res = await post('/api/client/auth/vk/start', { intent: 'link', token: await linkKey() })
    expect(res.statusCode).toBe(200)
    const url = new URL(res.json().url)
    expect(url.origin + url.pathname).toBe('https://id.vk.ru/authorize')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code', client_id: '54000001', redirect_uri: 'https://crm-nevarium.ru/api/client/auth/vk/callback', code_challenge_method: 'S256',
    })
    expect(url.searchParams.has('scope')).toBe(false) // VK: по умолчанию vkid.personal_info, уменьшить нельзя
    expect(url.searchParams.has('client_secret')).toBe(false)
    expect(url.searchParams.get('state').length).toBeGreaterThanOrEqual(32) // требование VK ID
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/)
    const row = await app.db.prepare('SELECT * FROM oauth_states').get()
    expect(row.provider).toBe('vk')
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.hash).not.toBe(url.searchParams.get('state'))
  })

  it('чужой Origin — 403; preflight только для доменов сайта', async () => {
    expect((await post('/api/client/auth/vk/start', { intent: 'login' }, 'https://evil.example')).statusCode).toBe(403)
    expect((await app.inject({ method: 'OPTIONS', url: '/api/client/auth/vk/start', headers: { origin: SITE } })).statusCode).toBe(204)
    expect((await app.inject({ method: 'OPTIONS', url: '/api/client/auth/vk/start', headers: { origin: 'https://evil.example' } })).statusCode).toBe(403)
  })
})

describe('привязка и вход', () => {
  it('linked: user_id (число в ответе VK) сохранён строкой; в обмен ушли code_verifier, device_id и state, секрета нет', async () => {
    const id = await vizorClient()
    const token = await linkKey()
    const r = await viaVk({ intent: 'link', token })
    expect(r.status).toBe('linked')
    expect(r.location).toBe(`${SITE}/#/vk?status=linked`)
    expect(await app.db.prepare('SELECT contact_id, provider, subject FROM client_identities').get()).toEqual({ contact_id: id, provider: 'vk', subject: String(VK_USER) })
    expect((await summary(token)).json().auth).toEqual({ vk: { linked: true } })
    const form = new URLSearchParams(String(fetched.find((f) => f.url === 'https://id.vk.ru/oauth2/auth').init.body))
    expect(Object.fromEntries(form)).toMatchObject({
      grant_type: 'authorization_code', code: 'the-code', client_id: '54000001', device_id: 'dev-123', state: r.state,
      redirect_uri: 'https://crm-nevarium.ru/api/client/auth/vk/callback',
    })
    expect(form.get('code_verifier').length).toBeGreaterThanOrEqual(43)
    expect(form.has('client_secret')).toBe(false)
  })

  it('вход: привязанный аккаунт → logged_in + ticket → exchange → сессия открывает кабинет; повтор тикета — 404', async () => {
    await vizorClient()
    const token = await linkKey()
    await viaVk({ intent: 'link', token })
    const r = await viaVk({ intent: 'login' })
    expect(r.status).toBe('logged_in')
    expect(r.ticket).toBeTruthy()
    const session = (await post('/api/client/auth/vk/exchange', { ticket: r.ticket })).json()
    expect((await summary(session.token)).statusCode).toBe(200)
    expect((await post('/api/client/auth/vk/exchange', { ticket: r.ticket })).statusCode).toBe(404)
  })

  it('не привязанный аккаунт при входе — not_linked; чужой аккаунт при привязке — already_linked', async () => {
    const idA = await vizorClient()
    const tokenA = await linkKey()
    await viaVk({ intent: 'link', token: tokenA })
    expect((await viaVk({ intent: 'login' }, { userId: 999 })).status).toBe('not_linked')
    await vizorClient('Пётр', '+79215552299')
    const tokenB = await linkKey('+79215552299')
    expect((await viaVk({ intent: 'link', token: tokenB }, { userId: VK_USER })).status).toBe('already_linked')
    expect((await app.db.prepare('SELECT COUNT(*) AS n FROM client_identities').get()).n).toBe(1)
    expect((await app.db.prepare('SELECT contact_id FROM client_identities').get()).contact_id).toBe(idA)
  })

  it('unlink снимает только VK: привязка Яндекса у того же клиента остаётся', async () => {
    const id = await vizorClient()
    const token = await linkKey()
    await viaVk({ intent: 'link', token })
    await app.db.prepare("INSERT INTO client_identities (contact_id, provider, subject, created_at) VALUES (?, 'yandex', 'y-1', ?)").run(id, now())
    expect((await post('/api/client/auth/vk/unlink', { token })).statusCode).toBe(204)
    expect((await app.db.prepare('SELECT provider FROM client_identities').all()).map((r) => r.provider)).toEqual(['yandex'])
  })
})

describe('сбои VK', () => {
  it('нет device_id, нет user_id, чужой state в ответе, HTTP-ошибка обмена — error, ничего не привязано', async () => {
    await vizorClient()
    const token = await linkKey()
    expect((await viaVk({ intent: 'link', token }, { query: '' })).status).toBe('error') // без device_id
    vk.noUserId = true
    expect((await viaVk({ intent: 'link', token })).status).toBe('error')
    vk.noUserId = false
    vk.echoState = 'someone-elses-state-0123456789abcdef'
    expect((await viaVk({ intent: 'link', token })).status).toBe('error') // ответ подменён
    vk.echoState = true
    vk.status = 400
    expect((await viaVk({ intent: 'link', token })).status).toBe('error')
    expect((await app.db.prepare('SELECT COUNT(*) AS n FROM client_identities').get()).n).toBe(0)
  })

  it('отказ пользователя (error=access_denied в адресе возврата) — denied; повтор state — error', async () => {
    await vizorClient()
    const started = await post('/api/client/auth/vk/start', { intent: 'link', token: await linkKey() })
    const state = new URL(started.json().url).searchParams.get('state')
    const url = `/api/client/auth/vk/callback?error=access_denied&state=${encodeURIComponent(state)}`
    expect((await app.inject({ method: 'GET', url })).headers.location).toBe(`${SITE}/#/vk?status=denied`)
    expect((await app.inject({ method: 'GET', url })).headers.location).toBe(`${SITE}/#/vk?status=error`)
  })

  it('ни code, ни state, ни device_id, ни токены VK не попадают в журнал действий', async () => {
    await vizorClient()
    await viaVk({ intent: 'link', token: await linkKey() })
    const text = JSON.stringify(await app.db.prepare('SELECT * FROM audit_log').all())
    for (const secret of ['the-code', 'dev-123', 'vk-access-token', 'vk-refresh-token', String(VK_USER)]) expect(text).not.toContain(secret)
  })
})

describe('изоляция провайдеров', () => {
  it('state из потока Яндекса не принимается на возврате VK (и наоборот), но гасится', async () => {
    await app.close()
    await makeApp({ yandexOn: true })
    await vizorClient()
    const token = await linkKey()
    const started = await post('/api/client/auth/yandex/start', { intent: 'link', token })
    const state = new URL(started.json().url).searchParams.get('state')
    const wrong = await app.inject({ method: 'GET', url: `/api/client/auth/vk/callback?code=c&state=${encodeURIComponent(state)}&device_id=d` })
    expect(wrong.headers.location).toBe(`${SITE}/#/vk?status=error`) // у state чужой провайдер
    expect(fetched.length).toBe(0) // в VK не ходили
    expect((await app.db.prepare('SELECT COUNT(*) AS n FROM oauth_states').get()).n).toBe(0) // и state погашен
  })

  it('тикет VK не обменивается на маршруте Яндекса', async () => {
    await app.close()
    await makeApp({ yandexOn: true })
    await vizorClient()
    await viaVk({ intent: 'link', token: await linkKey() })
    const r = await viaVk({ intent: 'login' })
    expect(r.ticket).toBeTruthy()
    expect((await post('/api/client/auth/yandex/exchange', { ticket: r.ticket })).statusCode).toBe(404)
  })
})
