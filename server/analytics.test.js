// @vitest-environment node
// Свой счётчик посещений, маршруты заходов и источник заявки (ADR-027): без cookie и IP, только суммы за день.
import vm from 'node:vm'
import pg from 'pg'
import { newDb } from 'pg-mem'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { hashPassword, resetThrottle } from './auth.js'
import { now } from './db.js'
import { COUNTER_JS, MAX_ROWS_PER_DAY, OTHER_PATH, cleanRoute, recordVisit, routeReport } from './analytics.js'
import { channelOf, cleanHost, cleanPath, cleanTag, normalizeAttribution } from '../src/shared/attribution.js'

const LAB = 'https://nevarium-lab.ru' // есть в projects.origins по умолчанию
let app, cookie, pool
const REAL_PG = process.env.TEST_DATABASE_URL || ''
let schemaSeq = 0
// TEST_DATABASE_URL — тот же набор на настоящем Postgres, своя схема на тест (как в uploads.test.js).
async function makePool() {
  if (!REAL_PG) return new (newDb().adapters.createPg()).Pool()
  const schema = `a${process.pid}_${process.env.VITEST_WORKER_ID ?? 0}_${++schemaSeq}`
  const admin = new pg.Pool({ connectionString: REAL_PG, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  await admin.end()
  const pool = new pg.Pool({ connectionString: REAL_PG, options: `-c search_path="${schema}" -c lock_timeout=5000ms`, max: 4 })
  pool.__schema = schema
  return pool
}
async function dropPool(pool) {
  if (!REAL_PG || !pool?.__schema) return
  await pool.end()
  const admin = new pg.Pool({ connectionString: REAL_PG, max: 1 })
  await admin.query(`DROP SCHEMA "${pool.__schema}" CASCADE`)
  await admin.end()
}

async function build(opts = {}) {
  resetThrottle()
  pool = await makePool()
  app = await buildApp({ dbConfig: pool, secure: false, ...opts })
  await app.db.prepare('INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)')
    .run('Владелец', 'owner@example.ru', await hashPassword('password123'), 'admin', now())
  await app.ready()
  cookie = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.ru', password: 'password123' } })).headers['set-cookie']
}
afterEach(async () => { try { await app?.close?.() } finally { await dropPool(pool); app = null; pool = null } })

// Так шлёт скрипт: text/plain, без cookie.
const collect = (body, { origin = LAB, ua = 'Mozilla/5.0' } = {}) => app.inject({
  method: 'POST', url: '/api/collect', payload: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { 'content-type': 'text/plain', 'user-agent': ua, ...(origin ? { origin } : {}) },
})
const visits = () => app.db.prepare('SELECT path, channel, ref_host, utm_source, utm_campaign, views, visits FROM site_visits ORDER BY path').all()
const crm = (method, url, payload) => app.inject({ method, url, payload, headers: { cookie } })
const TG = { utm_source: 'telegram', utm_medium: 'social', utm_campaign: 'Осень 2026!', ref_host: 't.me', landing: '/' }

describe('источник: нормализация (общая для сервера и интерфейса)', () => {
  it('каналы, домены, страницы, метки', () => {
    expect(channelOf({ utm_source: 'yandex', utm_medium: 'cpc' })).toBe('ads')
    expect(channelOf({ utm_source: 'tg' })).toBe('telegram')
    expect(channelOf({ utm_source: 'betgame' })).toBe('other') // «tg» внутри слова — не Telegram
    expect(channelOf({ ref_host: 'yandex.ru' })).toBe('search')
    expect(channelOf({ ref_host: 'avito.ru' })).toBe('avito')
    expect(channelOf({ ref_host: 'example.org' })).toBe('referral')
    expect(channelOf({})).toBe('direct')
    expect(cleanHost('https://www.T.me/some/path?x=1')).toBe('t.me')
    expect(cleanHost('not a host')).toBe('')
    expect(cleanPath('/tariffs?phone=79001234567#x')).toBe('/tariffs#x')
    // Ключ личной ссылки кабинета не оседает нигде.
    expect(cleanPath('/#/c/SECRETKEY123')).toBe('/#/c')
    expect(cleanPath('https://evil')).toBe('')
    expect(cleanTag('  Осень <script>2026! ')).toBe('осень script2026')
    expect(normalizeAttribution(undefined).channel).toBe('')
    expect(normalizeAttribution(TG)).toEqual({ channel: 'telegram', utm_source: 'telegram', utm_medium: 'social', utm_campaign: 'осень 2026', ref_host: 't.me', landing: '/' })
  })
})

describe('счётчик посещений: /nv.js и /api/collect', () => {
  it('скрипт отдаётся как JavaScript и разбирается без ошибок', async () => {
    await build()
    const res = await app.inject({ method: 'GET', url: '/nv.js' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('javascript')
    expect(() => new vm.Script(res.body)).not.toThrow()
    expect(res.body).toBe(COUNTER_JS)
  })

  it('заход и просмотры складываются в суммы дня; в базе нет ни IP, ни времени захода', async () => {
    await build()
    expect((await collect({ path: '/', attribution: TG, first: true })).statusCode).toBe(204)
    await collect({ path: '/', attribution: TG, first: false })
    await collect({ path: '/tariffs?utm_source=x', attribution: TG })
    expect(await visits()).toEqual([
      { path: '/', channel: 'telegram', ref_host: 't.me', utm_source: 'telegram', utm_campaign: 'осень 2026', views: 2, visits: 1 },
      { path: '/tariffs', channel: 'telegram', ref_host: 't.me', utm_source: 'telegram', utm_campaign: 'осень 2026', views: 1, visits: 0 },
    ])
    const cols = (await app.db.prepare("SELECT column_name FROM information_schema.columns WHERE table_name = 'site_visits'").all()).map((r) => r.column_name)
    expect(cols.some((c) => /ip|addr|agent|time|created/.test(c))).toBe(false)
  })

  it('чужой домен, без Origin, бот, мусор — молча не считаем (всегда 204)', async () => {
    await build()
    for (const res of [
      await collect({ path: '/' }, { origin: 'https://evil.example' }),
      await collect({ path: '/' }, { origin: null }),
      await collect({ path: '/' }, { ua: 'Mozilla/5.0 (compatible; YandexBot/3.0)' }),
      await collect('not json'),
      await collect({ path: 'https://evil/' }),
    ]) expect(res.statusCode).toBe(204)
    expect(await visits()).toEqual([])
  })

  it('режим «приём закрыт» счётчик не трогает: данных людей в нём нет', async () => {
    await build({ intakeMode: 'closed', intakeAllowedOrigins: '' })
    await collect({ path: '/', attribution: TG, first: true })
    expect((await visits()).length).toBe(1)
  })

  it('сверх потолка строк за день новые сочетания складываются в «(прочее)»', async () => {
    await build()
    const day = '2026-10-23'
    const ins = app.db.prepare("INSERT INTO site_visits (project_id, day, path, channel, ref_host, utm_source, utm_campaign, views, visits) VALUES (1, ?, ?, 'direct', '', '', '', 1, 0)")
    for (let i = 0; i < MAX_ROWS_PER_DAY; i++) await ins.run(day, `/p${i}`)
    await recordVisit(app.db, { projectId: 1, day, path: '/new', attribution: normalizeAttribution(TG), first: true })
    await recordVisit(app.db, { projectId: 1, day, path: '/p5', attribution: { channel: 'direct', ref_host: '', utm_source: '', utm_campaign: '' }, first: false })
    const other = await app.db.prepare('SELECT path, utm_campaign, views, visits FROM site_visits WHERE path = ?').get(OTHER_PATH)
    expect(other).toEqual({ path: OTHER_PATH, utm_campaign: '', views: 1, visits: 1 })
    expect(Number((await app.db.prepare("SELECT views FROM site_visits WHERE path = '/p5'").get()).views)).toBe(2) // существующая строка растёт
  }, 60_000)
})

describe('маршруты заходов', () => {
  it('каждый шаг удлиняет маршрут; отчёт — маршруты целиком, переходы, входы и выходы', async () => {
    await build()
    // Заход А: главная → тарифы → заявка. Заход Б: главная → демо. Заход В: только главная.
    for (const route of [['/'], ['/', '/tariffs'], ['/', '/tariffs', '★ заявка'], ['/'], ['/', '/#/demo'], ['/']]) {
      await collect({ route, attribution: TG })
    }
    const r = (await crm('GET', '/api/crm/analytics?days=7')).json()
    expect(r.routes).toEqual([
      { steps: ['/'], count: 1 },
      { steps: ['/', '/#/demo'], count: 1 },
      { steps: ['/', '/tariffs', '★ заявка'], count: 1 },
    ])
    expect(r.transitions).toEqual(expect.arrayContaining([
      { from: '/', to: '/tariffs', count: 1 }, { from: '/tariffs', to: '★ заявка', count: 1 }, { from: '/', to: '/#/demo', count: 1 },
    ]))
    expect(r.entries).toEqual([{ path: '/', count: 3 }])
    expect(r.exits).toEqual(expect.arrayContaining([{ path: '★ заявка', count: 1 }, { path: '/#/demo', count: 1 }, { path: '/', count: 1 }]))
    // Только маршрут (отметка nvMark) — просмотров не добавляет.
    expect(await visits()).toEqual([])
  })

  it('кривой маршрут не считается вовсе', () => {
    expect(cleanRoute(Array(11).fill('/'))).toBe('')
    expect(cleanRoute(['/', 5])).toBe('')
    expect(cleanRoute(['/', 'http://evil'])).toBe('')
    expect(cleanRoute(['/#/c/KEY', '★ Заявка!'])).toBe('/#/c → ★ заявка')
    expect(routeReport([{ route: '/', hits: 2 }, { route: '/ → /a', hits: 2 }]).routes).toEqual([{ steps: ['/', '/a'], count: 2 }])
  })
})

describe('источник заявки и отчёт «канал → заявки → оплаты»', () => {
  const lead = (body) => app.inject({ method: 'POST', url: '/api/leads', headers: { origin: LAB }, payload: { name: 'ТЕСТ Иван', contact: '+79001112233', task: 'ТЕСТ', ...body } })
  const deals = () => app.db.prepare('SELECT id, contact_id, channel, utm_source, utm_medium, utm_campaign, ref_host, landing FROM deals ORDER BY id').all()

  it('источник ложится в сделку; повторная заявка первый источник не перезаписывает; без источника — «не указан»', async () => {
    await build()
    expect((await lead({ attribution: { ...TG, landing: '/tariffs?phone=1' } })).statusCode).toBe(204)
    await lead({ attribution: { utm_source: 'avito' } })
    await lead({ contact: '+79004445566' })
    const [first, second] = await deals()
    expect(first).toMatchObject({ channel: 'telegram', utm_campaign: 'осень 2026', ref_host: 't.me', landing: '/tariffs' })
    expect(second).toMatchObject({ channel: '', utm_source: '' })
    const note = (await app.db.prepare('SELECT note FROM interactions WHERE contact_id = ?').get(first.contact_id)).note
    expect(note).toContain('Откуда пришёл: Авито')
  })

  it('отчёт сводит заходы и заявки по каналам; оплаты и выручка — по стадии «Оплачено»', async () => {
    await build()
    await collect({ path: '/', attribution: TG, first: true })
    await collect({ path: '/', attribution: { utm_source: 'avito' }, first: true })
    await lead({ attribution: TG })
    const [d] = await deals()
    expect((await crm('PATCH', `/api/crm/deals/${d.id}`, { stage: 'Оплачено', amount: 5000 })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/crm/analytics' })).statusCode).toBe(401)
    expect((await crm('GET', '/api/crm/analytics?project=nope')).statusCode).toBe(400)
    const r = (await crm('GET', '/api/crm/analytics?days=30&project=nevarium1')).json()
    expect(r.channels).toEqual(expect.arrayContaining([
      { channel: 'telegram', visits: 1, views: 1, leads: 1, paid: 1, revenue: 5000 },
      { channel: 'avito', visits: 1, views: 1, leads: 0, paid: 0, revenue: 0 },
    ]))
    expect(r.totals).toEqual({ visits: 2, views: 2, leads: 1, paid: 1, revenue: 5000 })
    expect(r.byDay.length).toBe(1)
    expect((await crm('GET', '/api/crm/analytics?project=nevarium-vizor')).json().totals.visits).toBe(0)
  })

  it('канал правится вручную только кодом из списка', async () => {
    await build()
    await lead({})
    const [d] = await deals()
    expect((await crm('PATCH', `/api/crm/deals/${d.id}`, { channel: 'radio' })).statusCode).toBe(400)
    expect((await crm('PATCH', `/api/crm/deals/${d.id}`, { channel: 'referral' })).statusCode).toBe(200)
    expect((await deals())[0].channel).toBe('referral')
  })

  it('обезличивание стирает метки и страницу входа, канал и сайт-источник остаются (отчёт за прошлое не едет)', async () => {
    await build()
    await lead({ attribution: TG })
    const [d] = await deals()
    expect((await crm('POST', `/api/crm/contacts/${d.contact_id}/anonymize`)).statusCode).toBe(200)
    expect((await deals())[0]).toMatchObject({ channel: 'telegram', ref_host: 't.me', utm_source: '', utm_medium: '', utm_campaign: '', landing: '' })
  })

  it('экспорт → импорт сохраняет источник сделки', async () => {
    await build()
    await lead({ attribution: TG })
    const dump = (await crm('GET', '/api/crm/export')).json()
    expect((await crm('POST', '/api/crm/import', dump)).statusCode).toBe(200)
    expect((await deals())[0]).toMatchObject({ channel: 'telegram', utm_campaign: 'осень 2026', landing: '/' })
  })

  it('очистка статистики — только администратор; заявки не трогает', async () => {
    await build()
    await collect({ path: '/', attribution: TG, first: true, route: ['/'] })
    await lead({ attribution: TG })
    expect((await crm('DELETE', '/api/crm/analytics/visits')).json()).toMatchObject({ ok: true, removed: 1 })
    expect(await visits()).toEqual([])
    expect(Number((await app.db.prepare('SELECT COUNT(*) c FROM site_routes').get()).c)).toBe(0)
    expect((await deals()).length).toBe(1)
  })
})
