// @vitest-environment node
// Режим «приём закрыт» (INTAKE_MODE=closed, ADR-026): до общего запуска сайта, CRM и NVizor данные настоящих людей в CRM
// не попадают — публичный приём пропускает только домены стендов, остальным 403 intake_closed и НИЧЕГО не сохраняется.
import fs from 'node:fs'
import { newDb } from 'pg-mem'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { hashPassword, resetThrottle } from './auth.js'
import { now } from './db.js'
import { INTAKE_ROUTES, parseAllowedOrigins, parseIntakeMode } from './intake.js'

const TOKEN = 'test-nvizor-token-0123456789abcdef0123456789'
const LIVE = 'https://nevarium-lab.ru' // живой сайт лаборатории: есть в projects.origins, но не стенд
const STAND_LAB = 'https://lab-stand.example.test'
const STAND_VIZOR = 'https://vizor-stand.example.test'
const ALLOWED = `${STAND_LAB}=nevarium1, ${STAND_VIZOR}/=nevarium-vizor`

// Таблицы, куда приём мог бы что-то записать. После отказа все обязаны остаться пустыми.
const INTAKE_TABLES = ['contacts', 'deals', 'interactions', 'tasks', 'consents', 'pd_requests', 'lead_intake', 'lead_photos', 'upload_files', 'idempotency_keys', 'outbox', 'audit_log']

function fakeS3() {
  const store = new Map()
  return {
    configured: true, store,
    async put(key, body, mime) { store.set(key, { body, mime }) },
    async get(key) { return store.get(key)?.body ?? null },
    async del(key) { store.delete(key) },
    async head(key) { const o = store.get(key); return o ? { size: o.body.length, mime: o.mime } : null },
    presignPost: () => ({ url: 'https://s3.example.test/bkt', fields: {} }),
  }
}

let app, s3, cookie
async function build(opts = {}) {
  resetThrottle()
  s3 = fakeS3()
  const pool = new (newDb().adapters.createPg()).Pool()
  app = await buildApp({ dbConfig: pool, secure: false, nvizorToken: TOKEN, s3, ...opts })
  await app.db.prepare('INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)')
    .run('Владелец', 'owner@example.ru', await hashPassword('password123'), 'admin', now())
  await app.ready()
  cookie = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.ru', password: 'password123' } })).headers['set-cookie']
  return app
}
const closed = () => build({ intakeMode: 'closed', intakeAllowedOrigins: ALLOWED })
afterEach(async () => { await app?.close?.(); app = null })

let seq = 0
const lead = (origin, body = {}) => app.inject({
  method: 'POST', url: '/api/leads',
  headers: origin ? { origin } : {},
  payload: { name: 'ТЕСТ Иван', contact: `+7900${String(1000000 + ++seq)}`, task: 'ТЕСТ проверка', request_id: `req-${seq}`, consent: { version: 'v', text: 'согласие', accepted_at: now() }, ...body },
})
const pdRequest = (origin) => app.inject({ method: 'POST', url: '/api/pd-requests', headers: origin ? { origin } : {}, payload: { contact: 'test@example.ru', kind: 'delete' } })
const count = async (t) => Number((await app.db.prepare(`SELECT COUNT(*) c FROM ${t}`).get()).c)
async function expectNothingStored() {
  for (const t of INTAKE_TABLES) expect(await count(t), t).toBe(0)
}
const projectIdOf = async (slug) => (await app.db.prepare('SELECT id FROM projects WHERE slug = ?').get(slug)).id

describe('приём закрыт (INTAKE_MODE=closed)', () => {
  it('заявка с живого сайта — 403 intake_closed с CORS-заголовком (сайт может прочитать отказ), в базе ничего', async () => {
    await closed()
    const res = await lead(LIVE)
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'intake_closed' })
    expect(res.headers['access-control-allow-origin']).toBe(LIVE)
    await expectNothingStored()
  })

  it('без Origin и с чужого домена — тоже отказ; чужому домену CORS не открывается', async () => {
    await closed()
    expect((await lead(null)).statusCode).toBe(403)
    const evil = await lead('https://evil.example.test')
    expect(evil.statusCode).toBe(403)
    expect(evil.headers['access-control-allow-origin']).toBeUndefined()
    // Закодированный адрес ведёт на тот же маршрут — и тоже закрыт (проверка по шаблону маршрута, не по req.url).
    const encoded = await app.inject({ method: 'POST', url: '/api/%6Ceads', headers: { origin: LIVE }, payload: { name: 'ТЕСТ', contact: '+79000000009' } })
    expect(encoded.statusCode).toBe(403)
    await expectNothingStored()
  })

  it('стенд принимается: preflight открыт, заявка относится к проекту, указанному у домена', async () => {
    await closed()
    const pre = await app.inject({ method: 'OPTIONS', url: '/api/leads', headers: { origin: STAND_VIZOR, 'access-control-request-method': 'POST' } })
    expect(pre.statusCode).toBe(204)
    expect(pre.headers['access-control-allow-origin']).toBe(STAND_VIZOR)

    expect((await lead(STAND_VIZOR)).statusCode).toBe(204)
    expect((await lead(STAND_LAB, { project: 'nevarium-vizor' })).statusCode).toBe(204) // домен стенда важнее поля формы
    const rows = await app.db.prepare('SELECT project_id FROM contacts ORDER BY id').all()
    expect(rows.map((r) => r.project_id)).toEqual([await projectIdOf('nevarium-vizor'), await projectIdOf('nevarium1')])
  })

  it('запрос по ПДн: с живого сайта — 403 и ничего не записано, со стенда — принят', async () => {
    await closed()
    expect((await pdRequest(LIVE)).statusCode).toBe(403)
    await expectNothingStored()
    expect((await pdRequest(STAND_LAB)).statusCode).toBe(204)
    expect(await count('pd_requests')).toBe(1)
  })

  it('фото к заявке: чужой домен — 403 до хранилища, стенд — принято', async () => {
    await closed()
    const request_id = 'req-photo-1'
    expect((await lead(STAND_VIZOR, { request_id })).statusCode).toBe(204)
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 7)])
    const photo = (origin) => app.inject({ method: 'POST', url: `/api/leads/${request_id}/photos`, payload: jpeg, headers: { origin, 'content-type': 'image/jpeg', 'x-photo-index': '0' } })
    expect((await photo(LIVE)).statusCode).toBe(403)
    expect(s3.store.size).toBe(0)
    expect(await count('lead_photos')).toBe(0)
    expect((await photo(STAND_VIZOR)).statusCode).toBe(204)
    expect(s3.store.size).toBe(1)
  })

  it('загрузки клиента по личной ссылке: отказ раньше проверки ключа; со стенда — обычная проверка ключа (404)', async () => {
    await closed()
    const routes = [
      ['/api/client/upload/1/photos', { 'content-type': 'image/jpeg', 'x-photo-index': '0' }, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])],
      ['/api/client/upload/1/video-url', {}, { index: 0, size: 100, type: 'video/mp4' }],
      ['/api/client/upload/1/video-done', {}, { index: 0 }],
    ]
    for (const [url, headers, payload] of routes) {
      const base = { 'x-client-key': 'no-such-key', ...headers }
      expect((await app.inject({ method: 'POST', url, payload, headers: { ...base, origin: LIVE } })).statusCode, url).toBe(403)
      expect((await app.inject({ method: 'POST', url, payload, headers: { ...base, origin: STAND_VIZOR } })).statusCode, url).toBe(404)
    }
    expect(s3.store.size).toBe(0)
  })

  it('кабинет клиента и NVizor режим не трогает', async () => {
    await closed()
    // Неверный ключ кабинета — обычный 404, не intake_closed: кабинет работает как раньше.
    const summary = await app.inject({ method: 'POST', url: '/api/client/summary', headers: { origin: LIVE }, payload: { key: 'no-such-key' } })
    expect(summary.statusCode).toBe(404)
    const ping = await app.inject({ method: 'GET', url: '/api/nvizor/ping', headers: { authorization: `Bearer ${TOKEN}` } })
    expect(ping.statusCode).toBe(200)
  })

  it('статус для плашки в «Настройках»: только вошедшим; домены стендов и счётчик отказов', async () => {
    await closed()
    expect((await app.inject({ method: 'GET', url: '/api/crm/intake' })).statusCode).toBe(401)
    await lead(LIVE)
    const st = (await app.inject({ method: 'GET', url: '/api/crm/intake', headers: { cookie } })).json()
    expect(st).toMatchObject({ closed: true, refused: 1, lastRefused: { origin: LIVE } })
    expect(st.allowedOrigins).toEqual([{ origin: STAND_LAB, project: 'nevarium1' }, { origin: STAND_VIZOR, project: 'nevarium-vizor' }])
  })

  it('на проде (secure) localhost не пропускается', async () => {
    await build({ secure: true, intakeMode: 'closed', intakeAllowedOrigins: '' })
    expect((await lead('http://localhost:5173')).statusCode).toBe(403)
    await expectNothingStored()
  })

  it('все маршруты из списка существуют — переименованный маршрут не выпадет из закрытия молча', async () => {
    await closed()
    for (const url of INTAKE_ROUTES) expect(app.hasRoute({ method: 'POST', url }), url).toBe(true)
  })
})

describe('открытый режим (по умолчанию) — как раньше', () => {
  it('живой сайт принимается, список доменов стендов не действует', async () => {
    await build({ intakeAllowedOrigins: ALLOWED })
    expect((await lead(LIVE)).statusCode).toBe(204)
    expect(await count('contacts')).toBe(1)
    const pre = await app.inject({ method: 'OPTIONS', url: '/api/leads', headers: { origin: STAND_VIZOR, 'access-control-request-method': 'POST' } })
    expect(pre.statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/crm/intake', headers: { cookie } })).json()).toMatchObject({ closed: false, refused: 0 })
  })
})

describe('очистка тестовых данных на общем запуске', () => {
  it('«Импорт JSON» файла deploy/launch-empty-dump.json стирает всё, что принял стенд; пользователи, проекты и настройки остаются', async () => {
    await closed()
    expect((await app.inject({ method: 'PATCH', url: '/api/crm/settings', headers: { cookie }, payload: { clientMail: { enabled: true } } })).statusCode).toBe(200)
    const settingsBefore = await count('settings')
    expect(settingsBefore).toBeGreaterThan(0)
    const request_id = 'req-clean-1'
    expect((await lead(STAND_VIZOR, { request_id })).statusCode).toBe(204)
    expect((await pdRequest(STAND_LAB)).statusCode).toBe(204)
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 7)])
    expect((await app.inject({ method: 'POST', url: `/api/leads/${request_id}/photos`, payload: jpeg, headers: { origin: STAND_VIZOR, 'content-type': 'image/jpeg', 'x-photo-index': '0' } })).statusCode).toBe(204)
    expect(await count('contacts')).toBe(1)
    expect(await count('lead_photos')).toBe(1)

    const dump = JSON.parse(fs.readFileSync(new URL('../deploy/launch-empty-dump.json', import.meta.url), 'utf8'))
    const res = await app.inject({ method: 'POST', url: '/api/crm/import', headers: { cookie }, payload: dump })
    expect(res.statusCode).toBe(200)
    for (const t of INTAKE_TABLES.filter((n) => n !== 'audit_log')) expect(await count(t), t).toBe(0)
    // В журнале — ровно одна запись: сама очистка.
    expect((await app.db.prepare('SELECT action FROM audit_log').all()).map((r) => r.action)).toEqual(['import'])
    expect(await count('users')).toBe(1)
    expect(await count('projects')).toBe(2)
    expect(await count('settings')).toBe(settingsBefore)
    // Объект фото — в очереди на удаление из бакета (фоновый проход), строки уже нет.
    expect(await count('photo_deletions')).toBe(1)
  })
})

describe('настройка режима', () => {
  it('опечатка в INTAKE_MODE или кривой домен — сервер не стартует, а не открывает приём молча', async () => {
    expect(parseIntakeMode(' CLOSED ')).toBe('closed')
    expect(parseIntakeMode(undefined)).toBe('open')
    expect(parseIntakeMode('open')).toBe('open')
    expect(() => parseIntakeMode('close')).toThrow(/INTAKE_MODE/)
    expect(() => parseAllowedOrigins('nevarium-lab.ru')).toThrow(/INTAKE_ALLOWED_ORIGINS/)
    expect(() => parseAllowedOrigins('https://x.ru/path')).toThrow(/INTAKE_ALLOWED_ORIGINS/)
    expect(parseAllowedOrigins(' HTTPS://A.Example.ru/ , https://b.example.ru:8443=nevarium-vizor,')).toEqual([
      { origin: 'https://a.example.ru', project: null },
      { origin: 'https://b.example.ru:8443', project: 'nevarium-vizor' },
    ])
    const pool = new (newDb().adapters.createPg()).Pool()
    await expect(buildApp({ dbConfig: pool, secure: false, intakeMode: 'close' })).rejects.toThrow(/INTAKE_MODE/)
  })
})
