// @vitest-environment node
// Очистка тестовых данных на общем запуске (ADR-028): «Импорт JSON» файла deploy/launch-empty-dump.json стирает всё, что
// накопилось от тестовых заявок («ТЕСТ …»), а пользователей, проекты и настройки оставляет.
import fs from 'node:fs'
import pg from 'pg'
import { newDb } from 'pg-mem'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { hashPassword, resetThrottle } from './auth.js'
import { now } from './db.js'

const TOKEN = 'test-nvizor-token-0123456789abcdef0123456789'
const SITE_VIZOR = 'https://nevarium-vizor.ru'
const SITE_LAB = 'https://nevarium-lab.ru'

// Таблицы, куда приём что-то записывает. После очистки все (кроме журнала с самой очисткой) обязаны остаться пустыми.
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

let app, s3, cookie, pool
const REAL_PG = process.env.TEST_DATABASE_URL || ''
let schemaSeq = 0
// TEST_DATABASE_URL — тот же набор на настоящем Postgres, своя схема на тест (как в uploads.test.js).
async function makePool() {
  if (!REAL_PG) return new (newDb().adapters.createPg()).Pool()
  const schema = `i${process.pid}_${process.env.VITEST_WORKER_ID ?? 0}_${++schemaSeq}`
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
async function build() {
  resetThrottle()
  s3 = fakeS3()
  pool = await makePool()
  app = await buildApp({ dbConfig: pool, secure: false, nvizorToken: TOKEN, s3 })
  await app.db.prepare('INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)')
    .run('Владелец', 'owner@example.ru', await hashPassword('password123'), 'admin', now())
  await app.ready()
  cookie = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.ru', password: 'password123' } })).headers['set-cookie']
  return app
}
afterEach(async () => { try { await app?.close?.() } finally { await dropPool(pool); app = null; pool = null } })

let seq = 0
const lead = (origin, body = {}) => app.inject({
  method: 'POST', url: '/api/leads',
  headers: origin ? { origin } : {},
  payload: { name: 'ТЕСТ Иван', contact: `+7900${String(1000000 + ++seq)}`, task: 'ТЕСТ проверка', request_id: `req-${seq}`, consent: { version: 'v', text: 'согласие', accepted_at: now() }, ...body },
})
const pdRequest = (origin) => app.inject({ method: 'POST', url: '/api/pd-requests', headers: origin ? { origin } : {}, payload: { contact: 'test@example.ru', kind: 'delete' } })
const count = async (t) => Number((await app.db.prepare(`SELECT COUNT(*) c FROM ${t}`).get()).c)

describe('очистка тестовых данных на общем запуске', () => {
  it('«Импорт JSON» файла deploy/launch-empty-dump.json стирает всё, что накопилось; пользователи, проекты и настройки остаются', async () => {
    await build()
    expect((await app.inject({ method: 'PATCH', url: '/api/crm/settings', headers: { cookie }, payload: { clientMail: { enabled: true } } })).statusCode).toBe(200)
    const settingsBefore = await count('settings')
    expect(settingsBefore).toBeGreaterThan(0)
    const request_id = 'req-clean-1'
    expect((await lead(SITE_VIZOR, { request_id })).statusCode).toBe(204)
    expect((await pdRequest(SITE_LAB)).statusCode).toBe(204)
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 7)])
    expect((await app.inject({ method: 'POST', url: `/api/leads/${request_id}/photos`, payload: jpeg, headers: { origin: SITE_VIZOR, 'content-type': 'image/jpeg', 'x-photo-index': '0' } })).statusCode).toBe(204)
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
