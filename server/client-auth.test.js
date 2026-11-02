// @vitest-environment node
// Вход клиента в кабинет через Яндекс ID (ADR-029; задание сайта 2026-11-01). Живой Яндекс не нужен: fetch подменён.
import pg from 'pg'
import { newDb } from 'pg-mem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { hashPassword, resetThrottle } from './auth.js'
import { now } from './db.js'

const TOKEN = 'test-nvizor-token-0123456789abcdef0123456789'
const SITE = 'https://nevarium-vizor.ru'
const PHONE = '+79215551488'
const PHONE2 = '+79215552299'
const ACCOUNT_A = '1000000001'
const ACCOUNT_B = '1000000002'

// TEST_DATABASE_URL — тот же набор на настоящем Postgres (внешние ключи, UNIQUE, блокировки FOR UPDATE и схему pg-mem проверяет не до конца),
// своя схема на тест, как в merge.test.js и api.test.js.
const REAL_PG = process.env.TEST_DATABASE_URL || ''
let schemaSeq = 0
let currentPool
async function makePool() {
  if (!REAL_PG) return new (newDb().adapters.createPg()).Pool()
  const schema = `y${process.pid}_${process.env.VITEST_WORKER_ID ?? 0}_${++schemaSeq}`
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
let yandex // что «отвечает Яндекс»: { account, tokenStatus, noId }
let fetched // запросы к Яндексу

async function makeApp({ configured = true } = {}) {
  resetThrottle()
  if (configured) { process.env.YANDEX_OAUTH_CLIENT_ID = 'test-client-id'; process.env.YANDEX_OAUTH_CLIENT_SECRET = 'test-client-secret' }
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
  yandex = { account: ACCOUNT_A, tokenStatus: 200, noId: false }
  fetched = []
  vi.stubGlobal('fetch', async (url, init = {}) => {
    fetched.push({ url: String(url), init })
    if (String(url).startsWith('https://oauth.yandex.ru/token')) {
      return yandex.tokenStatus === 200
        ? new Response(JSON.stringify({ access_token: 'yandex-access-token', token_type: 'bearer' }), { status: 200 })
        : new Response('{"error":"invalid_grant"}', { status: yandex.tokenStatus })
    }
    if (String(url).startsWith('https://login.yandex.ru/info')) {
      return new Response(JSON.stringify(yandex.noId ? { login: 'someone' } : { id: yandex.account }), { status: 200 })
    }
    throw new Error(`неожиданный запрос ${url}`)
  })
  await makeApp()
})
afterEach(async () => {
  vi.unstubAllGlobals()
  try { await app?.close?.() } finally { await dropPool(currentPool); currentPool = null }
})

const crm = (method, url, payload) => app.inject({ method, url, payload, headers: { cookie } })
const nv = (url, payload) => app.inject({ method: 'POST', url, payload, headers: { authorization: `Bearer ${TOKEN}` } })
const post = (url, payload, origin = SITE) => app.inject({ method: 'POST', url, payload, headers: origin ? { origin } : {} })
const summary = (token) => post('/api/client/summary', { token })

async function vizorClient(name = 'Иван', phone = PHONE) {
  await app.inject({ method: 'POST', url: '/api/leads', payload: { name, contact: phone, task: 'Квартира / ремонт', project: 'nevarium-vizor' } })
  return (await app.db.prepare('SELECT id FROM contacts ORDER BY id DESC LIMIT 1').get()).id
}
const linkKey = async (phone = PHONE) => (await nv('/api/nvizor/client-link', { phone })).json().url.split('/#/c/')[1]

/** start → (Яндекс «вернул» code) → callback; возвращает параметры редиректа из фрагмента. */
async function viaYandex(body, { account = yandex.account, query = '' } = {}) {
  yandex.account = account
  const started = await post('/api/client/auth/yandex/start', body)
  expect(started.statusCode, started.body).toBe(200)
  const state = new URL(started.json().url).searchParams.get('state')
  const cb = await app.inject({ method: 'GET', url: `/api/client/auth/yandex/callback?code=the-code&state=${encodeURIComponent(state)}${query}` })
  expect(cb.statusCode).toBe(302)
  const location = cb.headers.location
  expect(location.startsWith(`${SITE}/#/yandex?`)).toBe(true)
  const params = new URLSearchParams(location.split('#/yandex?')[1])
  return { state, status: params.get('status'), ticket: params.get('ticket'), location, cb }
}
const link = (token, account) => viaYandex({ intent: 'link', token }, { account })
const login = (account) => viaYandex({ intent: 'login' }, { account })
const exchange = (ticket) => post('/api/client/auth/yandex/exchange', { ticket })
async function sessionFor(account = ACCOUNT_A) {
  const r = await login(account)
  expect(r.status).toBe('logged_in')
  return (await exchange(r.ticket)).json()
}

describe('не настроено', () => {
  it('start — 503, summary без поля auth (выкатка CRM не зависит от выкатки сайта)', async () => {
    await app.close()
    await makeApp({ configured: false })
    await vizorClient()
    const token = await linkKey()
    expect((await post('/api/client/auth/yandex/start', { intent: 'link', token })).statusCode).toBe(503)
    expect((await post('/api/client/auth/yandex/start', { intent: 'login' })).statusCode).toBe(503)
    expect((await summary(token)).json()).not.toHaveProperty('auth')
  })
})

describe('start', () => {
  it('отдаёт адрес Яндекса: PKCE S256, точный redirect_uri, scope только login:avatar; в базе только хеш state', async () => {
    await vizorClient()
    const res = await post('/api/client/auth/yandex/start', { intent: 'link', token: await linkKey() })
    expect(res.statusCode).toBe(200)
    const url = new URL(res.json().url)
    expect(url.origin + url.pathname).toBe('https://oauth.yandex.ru/authorize')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code', client_id: 'test-client-id', redirect_uri: 'https://crm-nevarium.ru/api/client/auth/yandex/callback', code_challenge_method: 'S256',
    })
    expect(url.searchParams.get('scope')).toBe('login:avatar')
    expect(url.searchParams.get('state').length).toBeGreaterThanOrEqual(43) // ≥ 128 бит
    const row = await app.db.prepare('SELECT * FROM oauth_states').get()
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.hash).not.toBe(url.searchParams.get('state'))
    expect(row.return_origin).toBe(SITE)
  })

  it('чужой Origin и его отсутствие — 403, адрес возврата из тела запроса не принимается', async () => {
    await vizorClient()
    const token = await linkKey()
    expect((await post('/api/client/auth/yandex/start', { intent: 'link', token }, 'https://evil.example')).statusCode).toBe(403)
    expect((await post('/api/client/auth/yandex/start', { intent: 'link', token }, null)).statusCode).toBe(403)
    await post('/api/client/auth/yandex/start', { intent: 'login', returnTo: 'https://evil.example', origin: 'https://evil.example' })
    expect((await app.db.prepare('SELECT return_origin FROM oauth_states').get()).return_origin).toBe(SITE)
  })

  it('неверный, отозванный ключ — одинаковый 404; плохое намерение — 400', async () => {
    const id = await vizorClient()
    const token = await linkKey()
    const wrong = await post('/api/client/auth/yandex/start', { intent: 'link', token: 'x'.repeat(43) })
    await crm('POST', `/api/crm/contacts/${id}/client-links/revoke-all`)
    const revoked = await post('/api/client/auth/yandex/start', { intent: 'link', token })
    expect(wrong.statusCode).toBe(404)
    expect(revoked.statusCode).toBe(404)
    expect(revoked.body).toBe(wrong.body)
    expect((await post('/api/client/auth/yandex/start', { intent: 'hack' })).statusCode).toBe(400)
  })

  it('CORS: preflight для доменов сайта', async () => {
    const ok = await app.inject({ method: 'OPTIONS', url: '/api/client/auth/yandex/start', headers: { origin: SITE } })
    expect(ok.statusCode).toBe(204)
    expect(ok.headers['access-control-allow-origin']).toBe(SITE)
    const bad = await app.inject({ method: 'OPTIONS', url: '/api/client/auth/yandex/start', headers: { origin: 'https://evil.example' } })
    expect(bad.statusCode).toBe(403)
  })
})

describe('привязка из кабинета', () => {
  it('linked: аккаунт запомнен, summary показывает auth.yandex.linked, в Яндекс ушли код, секрет и code_verifier', async () => {
    const id = await vizorClient()
    const token = await linkKey()
    expect((await summary(token)).json().auth).toEqual({ yandex: { linked: false } })
    const r = await link(token)
    expect(r.status).toBe('linked')
    expect(r.ticket).toBeNull()
    expect(r.location).toBe(`${SITE}/#/yandex?status=linked`) // никаких других параметров
    expect(await app.db.prepare('SELECT contact_id, provider, subject FROM client_identities').get()).toEqual({ contact_id: id, provider: 'yandex', subject: ACCOUNT_A })
    expect((await summary(token)).json().auth).toEqual({ yandex: { linked: true } })
    const exchangeCall = fetched.find((f) => f.url.startsWith('https://oauth.yandex.ru/token'))
    const form = new URLSearchParams(String(exchangeCall.init.body))
    expect(Object.fromEntries(form)).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', client_id: 'test-client-id', client_secret: 'test-client-secret' })
    expect(form.get('code_verifier').length).toBeGreaterThanOrEqual(43)
  })

  it('state одноразовый: повтор той же ссылки возврата — error', async () => {
    await vizorClient()
    const r = await link(await linkKey())
    const again = await app.inject({ method: 'GET', url: `/api/client/auth/yandex/callback?code=the-code&state=${encodeURIComponent(r.state)}` })
    expect(again.headers.location).toBe(`${SITE}/#/yandex?status=error`)
  })

  it('чужой или выдуманный state, просроченный state и callback без параметров — error, ничего не привязано', async () => {
    await vizorClient()
    const token = await linkKey()
    for (const url of ['/api/client/auth/yandex/callback', '/api/client/auth/yandex/callback?code=c&state=nope']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.headers.location).toBe(`${SITE}/#/yandex?status=error`)
    }
    const started = await post('/api/client/auth/yandex/start', { intent: 'link', token })
    const state = new URL(started.json().url).searchParams.get('state')
    await app.db.prepare('UPDATE oauth_states SET expires_at = ?').run('2000-01-01T00:00:00.000Z')
    const res = await app.inject({ method: 'GET', url: `/api/client/auth/yandex/callback?code=c&state=${state}` })
    expect(new URLSearchParams(res.headers.location.split('#/yandex?')[1]).get('status')).toBe('error')
    expect(Number((await app.db.prepare('SELECT COUNT(*) c FROM client_identities').get()).c)).toBe(0)
  })

  it('отказ в Яндексе — denied; сбой обмена кода и ответ без id — error', async () => {
    await vizorClient()
    const token = await linkKey()
    expect((await viaYandex({ intent: 'link', token }, { query: '&error=access_denied' })).status).toBe('denied')
    expect((await viaYandex({ intent: 'link', token }, { query: '&error=server_error' })).status).toBe('error')
    yandex.tokenStatus = 400
    expect((await link(token)).status).toBe('error')
    yandex.tokenStatus = 200
    yandex.noId = true
    expect((await link(token)).status).toBe('error')
    expect(Number((await app.db.prepare('SELECT COUNT(*) c FROM client_identities').get()).c)).toBe(0)
  })

  it('already_linked: этот аккаунт уже у другого клиента — первый не затронут', async () => {
    const first = await vizorClient('Первый', PHONE)
    const t1 = await linkKey(PHONE)
    await vizorClient('Второй', PHONE2)
    const t2 = await linkKey(PHONE2)
    expect((await link(t1, ACCOUNT_A)).status).toBe('linked')
    expect((await link(t2, ACCOUNT_A)).status).toBe('already_linked')
    expect(await app.db.prepare('SELECT contact_id FROM client_identities').all()).toEqual([{ contact_id: first }])
  })

  it('повтор той же пары — linked; другой аккаунт того же клиента заменяет прежний', async () => {
    await vizorClient()
    const token = await linkKey()
    expect((await link(token, ACCOUNT_A)).status).toBe('linked')
    expect((await link(token, ACCOUNT_A)).status).toBe('linked')
    expect((await link(token, ACCOUNT_B)).status).toBe('linked')
    expect(await app.db.prepare('SELECT subject FROM client_identities').all()).toEqual([{ subject: ACCOUNT_B }])
    expect((await login(ACCOUNT_A)).status).toBe('not_linked')
    expect((await login(ACCOUNT_B)).status).toBe('logged_in')
  })
})

describe('вход и сессия', () => {
  it('login → ticket → exchange → сессия открывает кабинет, как ключ ссылки; ссылка не меняется', async () => {
    await vizorClient()
    const token = await linkKey()
    await link(token)
    const r = await login(ACCOUNT_A)
    expect(r.status).toBe('logged_in')
    expect(r.ticket.length).toBeGreaterThanOrEqual(43)
    const ex = await exchange(r.ticket)
    expect(ex.statusCode).toBe(200)
    const { token: session, expiresAt } = ex.json()
    expect(session).not.toBe(token)
    const hours = (Date.parse(expiresAt) - Date.now()) / 3_600_000
    expect(hours).toBeGreaterThan(11.9)
    expect(hours).toBeLessThanOrEqual(12)
    const viaSession = await summary(session)
    expect(viaSession.statusCode).toBe(200)
    expect(viaSession.json().client).toEqual({ name: 'Иван' })
    expect(viaSession.json().auth).toEqual({ yandex: { linked: true } })
    expect((await summary(token)).statusCode).toBe(200) // ключ из выданного PDF/QR жив
    // в базе — только хеши, тикет не хранится
    const hashes = (await app.db.prepare('SELECT token_hash FROM client_links').all()).map((x) => x.token_hash)
    expect(hashes.every((h) => /^[0-9a-f]{64}$/.test(h) && h !== session)).toBe(true)
  })

  it('ticket одноразовый и живёт 60 секунд; просроченный и выдуманный — 404', async () => {
    await vizorClient()
    await link(await linkKey())
    const r = await login(ACCOUNT_A)
    expect((await exchange(r.ticket)).statusCode).toBe(200)
    expect((await exchange(r.ticket)).statusCode).toBe(404)
    const late = await login(ACCOUNT_A)
    await app.db.prepare("UPDATE oauth_states SET expires_at = ? WHERE kind = 'ticket'").run('2000-01-01T00:00:00.000Z')
    expect((await exchange(late.ticket)).statusCode).toBe(404)
    expect((await exchange('x'.repeat(43))).statusCode).toBe(404)
    expect((await post('/api/client/auth/yandex/exchange', {})).statusCode).toBe(404)
  })

  it('not_linked: аккаунт никуда не привязан — кабинет чужого не откроется', async () => {
    await vizorClient()
    const r = await login('9999999999')
    expect(r.status).toBe('not_linked')
    expect(r.ticket).toBeNull()
  })

  it('сессия умирает через 12 часов', async () => {
    await vizorClient()
    await link(await linkKey())
    const { token } = await sessionFor()
    expect((await summary(token)).statusCode).toBe(200)
    await app.db.prepare("UPDATE client_links SET expires_at = ? WHERE kind = 'session'").run('2000-01-01T00:00:00.000Z')
    expect((await summary(token)).statusCode).toBe(404)
  })

  it('сессия принимается и загрузками (тот же разбор ключа), а в карточке сотрудника не считается ссылкой', async () => {
    const id = await vizorClient()
    await link(await linkKey())
    const { token } = await sessionFor()
    // отчёты кабинета: без отчёта — 404 «нет такого», но не 5xx (ключ разобран тем же кодом, что и у ссылки)
    const withSession = await post('/api/client/report', { token, id: 1 })
    const withJunk = await post('/api/client/report', { token: 'x'.repeat(43), id: 1 })
    expect(withSession.statusCode).toBe(withJunk.statusCode)
    const state = (await crm('GET', `/api/crm/contacts/${id}/entitlements`)).json()
    expect(state.links.active).toBe(1) // одна личная ссылка, сессия не в счёт
  })

  it('«Отозвать все ссылки» гасит сессии и снимает привязку — по Яндексу заново не войти', async () => {
    const id = await vizorClient()
    await link(await linkKey())
    const { token } = await sessionFor()
    expect((await crm('POST', `/api/crm/contacts/${id}/client-links/revoke-all`)).statusCode).toBe(200)
    expect((await summary(token)).statusCode).toBe(404)
    expect(Number((await app.db.prepare('SELECT COUNT(*) c FROM client_identities').get()).c)).toBe(0)
    expect((await login(ACCOUNT_A)).status).toBe('not_linked')
  })
})

describe('срок доступа', () => {
  it('Free: сессия не живёт дольше ссылки (expires_on переносится); истёкшая ссылка — not_linked', async () => {
    await vizorClient()
    await link(await linkKey())
    const linkRow = await app.db.prepare("SELECT expires_on FROM client_links WHERE kind = 'link'").get()
    expect(linkRow.expires_on).toBeTruthy()
    await sessionFor()
    expect((await app.db.prepare("SELECT expires_on FROM client_links WHERE kind = 'session'").get()).expires_on).toBe(linkRow.expires_on)
    await app.db.prepare("UPDATE client_links SET expires_on = '2000-01-01' WHERE kind = 'link'").run()
    expect((await login(ACCOUNT_A)).status).toBe('not_linked')
  })

  it('действующий тариф: у сессии нет срока по дню (живёт только 12 часов)', async () => {
    const id = await vizorClient()
    await link(await linkKey())
    await crm('POST', '/api/crm/entitlements', { contact_id: id, plan: 'repair' })
    await sessionFor()
    expect((await app.db.prepare("SELECT expires_on FROM client_links WHERE kind = 'session'").get()).expires_on).toBeNull()
  })

  it('ticket, выданный до истечения доступа, не обменивается после него', async () => {
    await vizorClient()
    await link(await linkKey())
    const r = await login(ACCOUNT_A)
    await app.db.prepare("UPDATE client_links SET expires_on = '2000-01-01' WHERE kind = 'link'").run()
    expect((await exchange(r.ticket)).statusCode).toBe(404)
  })
})

describe('отвязка', () => {
  it('любым действующим ключом (ссылки или сессии); повтор — 204; неверный ключ — 404', async () => {
    await vizorClient()
    const token = await linkKey()
    await link(token)
    const { token: session } = await sessionFor()
    expect((await post('/api/client/auth/yandex/unlink', { token: session })).statusCode).toBe(204)
    expect((await post('/api/client/auth/yandex/unlink', { token })).statusCode).toBe(204)
    expect((await post('/api/client/auth/yandex/unlink', { token: 'x'.repeat(43) })).statusCode).toBe(404)
    expect((await summary(token)).json().auth).toEqual({ yandex: { linked: false } })
    expect((await login(ACCOUNT_A)).status).toBe('not_linked')
    expect((await summary(token)).statusCode).toBe(200) // личная ссылка осталась рабочей
  })
})

describe('152-ФЗ: идентификатор аккаунта — ПДн', () => {
  it('удаление контакта и обезличивание стирают привязку и незавершённые входы', async () => {
    const a = await vizorClient('Первый', PHONE)
    const ta = await linkKey(PHONE)
    await link(ta)
    const b = await vizorClient('Второй', PHONE2)
    await link(await linkKey(PHONE2), ACCOUNT_B)
    await post('/api/client/auth/yandex/start', { intent: 'link', token: ta })
    expect((await crm('POST', `/api/crm/contacts/${a}/anonymize`)).statusCode).toBe(200)
    expect(await app.db.prepare('SELECT contact_id FROM client_identities').all()).toEqual([{ contact_id: b }])
    expect(Number((await app.db.prepare('SELECT COUNT(*) c FROM oauth_states WHERE contact_id = ?').get(a)).c)).toBe(0)
    // контакт с открытой сделкой удалить нельзя (правило CRM) — сначала сделка
    for (const d of await app.db.prepare('SELECT id FROM deals WHERE contact_id = ?').all(b)) expect((await crm('DELETE', `/api/crm/deals/${d.id}`)).statusCode).toBe(200)
    const del = await crm('DELETE', `/api/crm/contacts/${b}`)
    expect(del.statusCode, del.body).toBe(200)
    expect(Number((await app.db.prepare('SELECT COUNT(*) c FROM client_identities').get()).c)).toBe(0)
  })

  it('журнал не содержит идентификатор аккаунта, state, ticket и токены', async () => {
    await vizorClient()
    const token = await linkKey()
    const r = await link(token)
    const l = await login(ACCOUNT_A)
    const { token: session } = (await exchange(l.ticket)).json()
    const journal = JSON.stringify(await app.db.prepare('SELECT detail FROM audit_log').all())
    for (const secret of [ACCOUNT_A, r.state, l.ticket, session, 'yandex-access-token', 'the-code']) expect(journal).not.toContain(secret)
  })
})

describe('слияние дублей', () => {
  const contact = async (name, phone, extra = {}) => {
    const pid = (await app.db.prepare("SELECT id FROM projects WHERE slug = 'nevarium-vizor'").get()).id
    return (await crm('POST', '/api/crm/contacts', { name, phone, project_id: pid, ...extra })).json().item
  }
  const identity = (contactId, subject) =>
    app.db.prepare('INSERT INTO client_identities (contact_id, provider, subject, created_at) VALUES (?,?,?,?)').run(contactId, 'yandex', subject, now())

  it('привязка присоединяемой карточки переезжает, если у основной её нет', async () => {
    const keep = await contact('Основной', '+7 900 111-22-33')
    const drop = await contact('Лишний', '89001112233')
    await identity(drop.id, ACCOUNT_A)
    const res = await crm('POST', `/api/crm/contacts/${keep.id}/merge`, { from_id: drop.id })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().moved.client_identities).toBe(1)
    expect(await app.db.prepare('SELECT contact_id FROM client_identities').all()).toEqual([{ contact_id: keep.id }])
  })

  it('если привязка есть у обеих — остаётся основной, слияние не блокируется', async () => {
    const keep = await contact('Основной', '+7 900 111-22-33')
    const drop = await contact('Лишний', '89001112233')
    await identity(keep.id, ACCOUNT_A)
    await identity(drop.id, ACCOUNT_B)
    const res = await crm('POST', `/api/crm/contacts/${keep.id}/merge`, { from_id: drop.id })
    expect(res.statusCode, res.body).toBe(200)
    expect(await app.db.prepare('SELECT contact_id, subject FROM client_identities').all()).toEqual([{ contact_id: keep.id, subject: ACCOUNT_A }])
  })
})

describe('дамп (v12)', () => {
  it('экспорт → импорт сохраняет привязки; незавершённые входы стираются', async () => {
    const id = await vizorClient()
    await link(await linkKey())
    await post('/api/client/auth/yandex/start', { intent: 'login' })
    const dump = (await crm('GET', '/api/crm/export')).json()
    expect(dump.version).toBe(12)
    expect(dump.client_identities).toHaveLength(1)
    expect(dump).not.toHaveProperty('oauth_states')
    expect((await crm('POST', '/api/crm/import', dump)).statusCode).toBe(200)
    expect(await app.db.prepare('SELECT contact_id, subject FROM client_identities').all()).toEqual([{ contact_id: id, subject: ACCOUNT_A }])
    expect(Number((await app.db.prepare('SELECT COUNT(*) c FROM oauth_states').get()).c)).toBe(0)
  })

  it('старый дамп (v11, без client_identities) восстанавливается и чистит привязки — без падения на внешнем ключе', async () => {
    await vizorClient()
    await link(await linkKey())
    const dump = (await crm('GET', '/api/crm/export')).json()
    delete dump.client_identities
    for (const l of dump.client_links) { delete l.kind; delete l.expires_at }
    dump.version = 11
    const res = await crm('POST', '/api/crm/import', dump)
    expect(res.statusCode, res.body).toBe(200)
    expect(Number((await app.db.prepare('SELECT COUNT(*) c FROM client_identities').get()).c)).toBe(0)
    expect((await app.db.prepare('SELECT kind FROM client_links').get()).kind).toBe('link')
  })
})
