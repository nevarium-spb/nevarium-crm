// @vitest-environment node
import { newDb } from 'pg-mem'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { hashPassword, resetThrottle } from './auth.js'
import { now } from './db.js'

const TOKEN = 'test-nvizor-token-0123456789abcdef0123456789'
const auth = { authorization: `Bearer ${TOKEN}` }

let app

async function makeApp(nvizorToken = TOKEN) {
  resetThrottle()
  const mem = newDb()
  const pool = new (mem.adapters.createPg()).Pool()
  app = await buildApp({ dbConfig: pool, secure: false, nvizorToken })
  await app.ready()
  return app
}

afterEach(async () => {
  await app?.close?.()
})

const record = (over = {}) => ({
  recordId: 'rec-1',
  objectRef: 'obj-1',
  clientName: 'Петров Пётр',
  clientPhone: '+7 (921) 000-00-01',
  devices: ['apple|iphone 15'],
  locations: [{ lat: 59.9386, lng: 30.3141 }],
  photoHashes: ['hash-a', 'hash-b'],
  usedAt: '2026-09-28T10:00:00.000Z',
  ...over
})

const search = (body) => app.inject({ method: 'POST', url: '/api/nvizor/free-reports/search', headers: auth, payload: body })

describe('NVizor: доступ по ключу приложения', () => {
  it('ключ не настроен — 503, а не работа без защиты', async () => {
    await makeApp(null)
    const res = await app.inject({ method: 'GET', url: '/api/nvizor/ping', headers: auth })
    expect(res.statusCode).toBe(503)
  })

  it('без ключа или с чужим ключом — 401; с верным — ok', async () => {
    await makeApp()
    expect((await app.inject({ method: 'GET', url: '/api/nvizor/ping' })).statusCode).toBe(401)
    expect(
      (await app.inject({ method: 'GET', url: '/api/nvizor/ping', headers: { authorization: 'Bearer wrong' } })).statusCode
    ).toBe(401)
    const ok = await app.inject({ method: 'GET', url: '/api/nvizor/ping', headers: auth })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ ok: true })
  })

  it('процентное кодирование пути не обходит проверку ключа (урок пентеста 2026-09-10)', async () => {
    await makeApp()
    for (const url of ['/api/%6Evizor/ping', '/api/nvizo%72/free-reports/search', '/api/%6E%76izor/ping']) {
      const res = await app.inject({ method: url.endsWith('search') ? 'POST' : 'GET', url, payload: url.endsWith('search') ? {} : undefined })
      expect([401, 404]).toContain(res.statusCode)
      expect(res.statusCode).not.toBe(200)
    }
  })
})

describe('NVizor: история бесплатных отчётов', () => {
  it('запись сохраняется, повтор той же записи не создаёт дубль', async () => {
    await makeApp()
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/nvizor/free-reports', headers: auth, payload: record() })
      expect(res.statusCode).toBe(201)
    }
    const rows = await app.db.prepare('SELECT * FROM nvizor_free_reports').all()
    expect(rows).toHaveLength(1)
    expect(rows[0].phone_key).toBe('9210000001')
  })

  it('поиск отдаёт только записи с совпавшим признаком', async () => {
    await makeApp()
    await app.inject({ method: 'POST', url: '/api/nvizor/free-reports', headers: auth, payload: record() })
    await app.inject({
      method: 'POST',
      url: '/api/nvizor/free-reports',
      headers: auth,
      payload: record({ recordId: 'rec-2', clientName: 'Другой', clientPhone: '', devices: [], locations: [], photoHashes: ['z'] })
    })

    const byPhone = (await search({ clientPhone: '8 921 000 00 01' })).json().records
    expect(byPhone.map((r) => r.recordId)).toEqual(['rec-1'])

    // 44 м — то же место; 200 м — нет.
    expect((await search({ locations: [{ lat: 59.939, lng: 30.3141 }] })).json().records).toHaveLength(1)
    expect((await search({ locations: [{ lat: 59.9404, lng: 30.3141 }] })).json().records).toHaveLength(0)

    expect((await search({ devices: ['Apple|iPhone 15'] })).json().records.map((r) => r.recordId)).toEqual(['rec-1'])
    expect((await search({ photoHashes: ['z'] })).json().records.map((r) => r.recordId)).toEqual(['rec-2'])
    expect((await search({ clientName: ' петров  петр ' })).json().records.map((r) => r.recordId)).toEqual(['rec-1'])
    expect((await search({ clientPhone: '+79990000000' })).json().records).toEqual([])
  })

  it('без recordId или даты — 400', async () => {
    await makeApp()
    const res = await app.inject({ method: 'POST', url: '/api/nvizor/free-reports', headers: auth, payload: record({ recordId: '' }) })
    expect(res.statusCode).toBe(400)
  })
})

describe('NVizor: персональные данные и резервная копия', () => {
  async function login() {
    await app.db
      .prepare('INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)')
      .run('Админ', 'a@a.ru', await hashPassword('password123'), 'admin', now())
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@a.ru', password: 'password123' } })
    return res.headers['set-cookie']
  }

  it('обезличивание контакта стирает записи Free с тем же телефоном, чужие остаются', async () => {
    await makeApp()
    const cookie = await login()
    await app.inject({ method: 'POST', url: '/api/nvizor/free-reports', headers: auth, payload: record() })
    await app.inject({
      method: 'POST',
      url: '/api/nvizor/free-reports',
      headers: auth,
      payload: record({ recordId: 'rec-2', clientPhone: '+79990000000' })
    })
    const created = await app.inject({
      method: 'POST',
      url: '/api/crm/contacts',
      headers: { cookie },
      payload: { name: 'Петров', phone: '89210000001' }
    })
    expect(created.statusCode).toBeLessThan(300)
    const id = created.json().item.id
    const anon = await app.inject({ method: 'POST', url: `/api/crm/contacts/${id}/anonymize`, headers: { cookie } })
    expect(anon.statusCode).toBeLessThan(300)
    const left = await app.db.prepare('SELECT record_id FROM nvizor_free_reports').all()
    expect(left.map((r) => r.record_id)).toEqual(['rec-2'])
  })

  it('экспорт → импорт сохраняет записи Free; старый дамп без них их не стирает', async () => {
    await makeApp()
    const cookie = await login()
    await app.inject({ method: 'POST', url: '/api/nvizor/free-reports', headers: auth, payload: record() })
    const dump = (await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })).json()
    expect(dump.nvizor_free_reports).toHaveLength(1)

    await app.db.prepare('DELETE FROM nvizor_free_reports').run()
    const restored = await app.inject({ method: 'POST', url: '/api/crm/import', headers: { cookie }, payload: dump })
    expect(restored.statusCode).toBeLessThan(300)
    expect((await app.db.prepare('SELECT record_id FROM nvizor_free_reports').all()).map((r) => r.record_id)).toEqual(['rec-1'])

    // Дамп до появления таблицы (v4): записи Free не трогаются.
    const old = { ...dump, version: 4 }
    delete old.nvizor_free_reports
    const again = await app.inject({ method: 'POST', url: '/api/crm/import', headers: { cookie }, payload: old })
    expect(again.statusCode).toBeLessThan(300)
    expect(await app.db.prepare('SELECT record_id FROM nvizor_free_reports').all()).toHaveLength(1)
  })
})

describe('NVizor: экран «NVizor Free» в CRM', () => {
  async function loginAs(role, email) {
    await app.db
      .prepare('INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)')
      .run(role, email, await hashPassword('password123'), role, now())
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password123' } })
    return res.headers['set-cookie']
  }
  const push = (over) => app.inject({ method: 'POST', url: '/api/nvizor/free-reports', headers: auth, payload: record(over) })
  const list = (cookie, q = '') =>
    app.inject({ method: 'GET', url: `/api/crm/nvizor-free${q ? `?q=${encodeURIComponent(q)}` : ''}`, headers: cookie ? { cookie } : {} })

  it('без входа — 401, ключ приложения вместо входа не годится, не-админ — 403', async () => {
    await makeApp()
    expect((await list()).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/crm/nvizor-free', headers: auth })).statusCode).toBe(401)
    const member = await loginAs('member', 'm@m.ru')
    expect((await list(member)).statusCode).toBe(403)
    expect((await app.inject({ method: 'DELETE', url: '/api/crm/nvizor-free/1', headers: { cookie: member } })).statusCode).toBe(403)
  })

  it('список: свежие сверху, без хешей и координат, только счётчики', async () => {
    await makeApp()
    const cookie = await loginAs('admin', 'a@a.ru')
    await push()
    await push({ recordId: 'rec-2', clientName: 'Сидорова Анна', clientPhone: '+7 999 111-22-33', usedAt: '2026-09-29T10:00:00.000Z' })
    const res = await list(cookie)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(2)
    expect(body.items.map((r) => r.recordId)).toEqual(['rec-2', 'rec-1'])
    expect(body.items[1]).toMatchObject({ clientName: 'Петров Пётр', phoneKey: '9210000001', photoCount: 2, locationCount: 1, devices: ['apple|iphone 15'] })
    expect(body.items[1].photoHashes).toBeUndefined()
    expect(body.items[1].locations).toBeUndefined()
  })

  it('поиск по имени (регистр, ё) и по цифрам телефона', async () => {
    await makeApp()
    const cookie = await loginAs('admin', 'a@a.ru')
    await push()
    await push({ recordId: 'rec-2', clientName: 'Сидорова Анна', clientPhone: '+7 999 111-22-33' })
    expect((await list(cookie, 'петров петр')).json().items.map((r) => r.recordId)).toEqual(['rec-1'])
    expect((await list(cookie, '111-22')).json().items.map((r) => r.recordId)).toEqual(['rec-2'])
    expect((await list(cookie, 'нет такого')).json().items).toEqual([])
  })

  it('удаление: запись исчезает и из поиска приложения, в журнале без ПДн; повтор — 404', async () => {
    await makeApp()
    const cookie = await loginAs('admin', 'a@a.ru')
    await push()
    const [{ id }] = (await list(cookie)).json().items
    const del = await app.inject({ method: 'DELETE', url: `/api/crm/nvizor-free/${id}`, headers: { cookie } })
    expect(del.statusCode).toBe(200)
    expect((await search({ clientPhone: '+7 921 000-00-01' })).json().records).toEqual([])
    const log = await app.db.prepare("SELECT * FROM audit_log WHERE entity = 'nvizor_free_reports'").all()
    expect(log).toHaveLength(1)
    expect(log[0].detail).toBe('record rec-1')
    expect((await app.inject({ method: 'DELETE', url: `/api/crm/nvizor-free/${id}`, headers: { cookie } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'DELETE', url: '/api/crm/nvizor-free/abc', headers: { cookie } })).statusCode).toBe(400)
  })
})
