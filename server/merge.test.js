// @vitest-environment node
// Слияние дублей контактов (HANDOFF: «слияние уже существующих дублей»; ADR-023). Слияние необратимо и затрагивает
// одиннадцать таблиц — поэтому проверяем и что переехало всё, и что отказы ничего не меняют.
import pg from 'pg'
import { newDb } from 'pg-mem'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { hashPassword, resetThrottle } from './auth.js'
import { now } from './db.js'

// TEST_DATABASE_URL — тот же набор на настоящем Postgres (внешние ключи и блокировки pg-mem не проверяет), своя схема на тест,
// как в api.test.js. Слияние трогает одиннадцать таблиц — именно здесь забытая ссылка и роняет удаление лишней карточки.
const REAL_PG = process.env.TEST_DATABASE_URL || ''
let schemaSeq = 0
async function makePool() {
  if (!REAL_PG) return new (newDb().adapters.createPg()).Pool()
  const schema = `m${process.pid}_${process.env.VITEST_WORKER_ID ?? 0}_${++schemaSeq}`
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

let app, cookie, pool

async function login(email) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'password123' } })
  return res.headers['set-cookie']
}

beforeEach(async () => {
  resetThrottle()
  pool = await makePool()
  app = await buildApp({ dbConfig: pool, secure: false })
  const hash = await hashPassword('password123')
  for (const [name, email, role] of [['Владелец', 'owner@example.ru', 'admin'], ['Сотрудник', 'staff@example.ru', 'member']]) {
    await app.db.prepare('INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)').run(name, email, hash, role, now())
  }
  await app.ready()
  cookie = await login('owner@example.ru')
})
afterEach(async () => {
  try { await app?.close?.() } finally { await dropPool(pool) }
})

const one = (sql, ...a) => app.db.prepare(sql).get(...a)
const all = (sql, ...a) => app.db.prepare(sql).all(...a)
const count = async (sql, ...a) => Number((await one(sql, ...a)).c)
const crm = (method, url, payload, ck = cookie) => app.inject({ method, url, payload, headers: { cookie: ck } })

async function contact({ project, ...fields } = {}) {
  // project — slug проекта; общий CRUD принимает project_id
  const extra = project ? { project_id: (await one('SELECT id FROM projects WHERE slug = ?', project)).id } : {}
  const res = await crm('POST', '/api/crm/contacts', { name: 'Иван', ...fields, ...extra })
  return res.json().item
}

describe('кандидаты в дубли', () => {
  it('телефон в любом формате, почта без учёта регистра и ник; свой проект, без обезличенных, без самого себя', async () => {
    const me = await contact({ name: 'Основной', phone: '+7 900 111-22-33', email: 'Ivan@Mail.ru' })
    const byPhone = await contact({ name: 'По телефону', phone: '89001112233' })
    const byMail = await contact({ name: 'По почте', email: 'ivan@mail.ru' })
    await contact({ name: 'Чужой', phone: '+7 900 999-99-99' })
    const otherProject = await contact({ name: 'Другой проект', phone: '+79001112233', project: 'nevarium-vizor' })
    const gone = await contact({ name: 'Обезличенный', phone: '+79001112233' })
    await crm('POST', `/api/crm/contacts/${gone.id}/anonymize`)

    const res = await crm('GET', `/api/crm/contacts/${me.id}/duplicates`)
    expect(res.statusCode, res.body).toBe(200)
    const items = res.json().items
    expect(items.map((c) => c.name).sort()).toEqual(['По почте', 'По телефону'])
    expect(items.find((c) => c.id === byPhone.id).reasons).toEqual(['телефон'])
    expect(items.find((c) => c.id === byMail.id).reasons).toEqual(['почта или ник'])
    expect(items.some((c) => c.id === otherProject.id || c.id === gone.id || c.id === me.id)).toBe(false)
  })

  it('только администратор; у обезличенного списка нет; чужой id — 404', async () => {
    const me = await contact({ phone: '+79001112233' })
    const staff = await login('staff@example.ru')
    expect((await crm('GET', `/api/crm/contacts/${me.id}/duplicates`, undefined, staff)).statusCode).toBe(403)
    expect((await crm('GET', '/api/crm/contacts/999999/duplicates')).statusCode).toBe(404)
    await crm('POST', `/api/crm/contacts/${me.id}/anonymize`)
    expect((await crm('GET', `/api/crm/contacts/${me.id}/duplicates`)).json().items).toEqual([])
  })
})

describe('слияние', () => {
  it('всё переезжает к основной карточке, лишняя исчезает, в журнале нет персональных данных', async () => {
    const keep = await contact({ name: 'Иван Петров', phone: '+7 900 111-22-33' })
    const drop = await contact({ name: 'Иван Петров', phone: '89001112233', email: 'ivan@example.ru', messenger: '@ivan', note: 'просил перезвонить' })
    const projectId = (await one('SELECT project_id FROM contacts WHERE id = ?', drop.id)).project_id
    const ts = now()
    const deal = (await crm('POST', '/api/crm/deals', { contact_id: drop.id, title: 'Ремонт' })).json().item
    await crm('POST', '/api/crm/tasks', { contact_id: drop.id, title: 'Позвонить' })
    await crm('POST', '/api/crm/interactions', { contact_id: drop.id, deal_id: deal.id, type: 'звонок', note: 'говорили' })
    await app.db.prepare('INSERT INTO pd_requests (contact_id, kind, requester, source, project_id, due_date, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(drop.id, 'access', 'ivan@example.ru', 'manual', projectId, '2026-11-01', ts, ts)
    await app.db.prepare('INSERT INTO consents (contact_id, deal_id, project_id, requester, version, text, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(drop.id, deal.id, projectId, 'ivan@example.ru', 'v1', 'согласен', ts)
    await app.db.prepare('INSERT INTO entitlements (contact_id, project_id, plan, starts_on, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run(drop.id, projectId, 'free', '2026-10-20', ts, ts)
    await app.db.prepare('INSERT INTO client_links (contact_id, token_hash, created_at) VALUES (?,?,?)').run(drop.id, 'a'.repeat(64), ts)
    await app.db.prepare('INSERT INTO lead_intake (request_id, contact_id, deal_id, created_at) VALUES (?,?,?,?)').run('r-1', drop.id, deal.id, ts)
    await app.db.prepare('INSERT INTO lead_photos (contact_id, deal_id, request_id, idx, storage_key, mime, size, sha256, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(drop.id, deal.id, 'r-1', 0, 'k-1.jpg', 'image/jpeg', 10, 'b'.repeat(64), ts)

    const res = await crm('POST', `/api/crm/contacts/${keep.id}/merge`, { from_id: drop.id })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.contact).toMatchObject({ id: keep.id, email: 'ivan@example.ru', messenger: '@ivan', phone: '+7 900 111-22-33' })
    expect(body.contact.note).toContain('просил перезвонить')
    expect(body.moved).toMatchObject({ deals: 1, tasks: 1, interactions: 1, pd_requests: 1, consents: 1, entitlements: 1, client_links: 1, lead_intake: 1, lead_photos: 1 })

    expect(await one('SELECT id FROM contacts WHERE id = ?', drop.id)).toBeFalsy()
    for (const table of ['deals', 'tasks', 'interactions', 'pd_requests', 'consents', 'entitlements', 'client_links', 'lead_intake', 'lead_photos', 'winback_sequences', 'entitlement_checks']) {
      expect(await count(`SELECT COUNT(*) c FROM ${table} WHERE contact_id = ?`, drop.id), table).toBe(0)
    }
    expect(await count('SELECT COUNT(*) c FROM deals WHERE contact_id = ?', keep.id)).toBe(1)
    expect((await crm('GET', `/api/crm/contacts/${keep.id}`)).json().interactions).toHaveLength(1)

    const entry = await one("SELECT * FROM audit_log WHERE action = 'merge'")
    expect(entry).toMatchObject({ entity: 'contacts', entity_id: keep.id })
    expect(entry.detail).toContain(`#${drop.id}`)
    expect(JSON.stringify(entry)).not.toMatch(/ivan@example|@ivan|перезвонить|89001112233/)
  })

  it('отличающиеся значения не теряются: остаются у основной, чужие попадают в заметку', async () => {
    const keep = await contact({ name: 'Иван', email: 'one@example.ru', company: 'Альфа', note: 'первая заметка' })
    const drop = await contact({ name: 'Иван П.', email: 'two@example.ru', company: 'Бета', note: 'вторая заметка' })
    const res = await crm('POST', `/api/crm/contacts/${keep.id}/merge`, { from_id: drop.id })
    const c = res.json().contact
    expect(c).toMatchObject({ name: 'Иван', email: 'one@example.ru', company: 'Альфа' })
    for (const piece of ['первая заметка', 'вторая заметка', 'two@example.ru', 'Бета', 'Иван П.']) expect(c.note, piece).toContain(piece)
  })

  it('архив и «подозрительный» сохраняются, только если были у обеих', async () => {
    const keep = await contact({ name: 'А', archived: 1, suspicious: 1 })
    const drop = await contact({ name: 'А', archived: 0, suspicious: 1 })
    const c = (await crm('POST', `/api/crm/contacts/${keep.id}/merge`, { from_id: drop.id })).json().contact
    expect(c.archived).toBe(0)
    expect(c.suspicious).toBe(1)
  })

  it('отказы ничего не меняют: разные телефоны, разные проекты, обезличенная, сама с собой, нет такой, не админ', async () => {
    const a = await contact({ name: 'А', phone: '+79001112233' })
    const b = await contact({ name: 'Б', phone: '+79005556677' })
    const other = await contact({ name: 'В', phone: '+79001112233', project: 'nevarium-vizor' })
    const gone = await contact({ name: 'Г' })
    await crm('POST', `/api/crm/contacts/${gone.id}/anonymize`)
    const before = await count('SELECT COUNT(*) c FROM contacts')

    const call = (id, from, ck) => crm('POST', `/api/crm/contacts/${id}/merge`, { from_id: from }, ck)
    expect((await call(a.id, b.id)).statusCode).toBe(409)
    expect((await call(a.id, b.id)).json().error).toBe('phones_differ')
    expect((await call(a.id, other.id)).json().error).toBe('different_project')
    expect((await call(a.id, gone.id)).json().error).toBe('anonymized')
    expect((await call(gone.id, a.id)).json().error).toBe('anonymized')
    expect((await call(a.id, a.id)).json().error).toBe('same_contact')
    expect((await call(a.id, 999999)).statusCode).toBe(404)
    expect((await crm('POST', `/api/crm/contacts/${a.id}/merge`, {})).statusCode).toBe(400)
    expect((await call(a.id, b.id, await login('staff@example.ru'))).statusCode).toBe(403)
    expect(await count('SELECT COUNT(*) c FROM contacts')).toBe(before)
    expect(await count("SELECT COUNT(*) c FROM audit_log WHERE action = 'merge'")).toBe(0)
  })

  it('после слияния обезличивание основной карточки чистит и то, что приехало с присоединённой', async () => {
    const keep = await contact({ name: 'Иван', phone: '+79001112233' })
    const drop = await contact({ name: 'Иван', phone: '89001112233', email: 'ivan@example.ru' })
    await crm('POST', '/api/crm/deals', { contact_id: drop.id, title: 'Ремонт', note: 'секретная заметка' })
    await crm('POST', `/api/crm/contacts/${keep.id}/merge`, { from_id: drop.id })
    await crm('POST', `/api/crm/contacts/${keep.id}/anonymize`)
    const c = await one('SELECT * FROM contacts WHERE id = ?', keep.id)
    expect(c).toMatchObject({ phone: '', email: '' })
    expect((await all('SELECT note FROM deals WHERE contact_id = ?', keep.id)).every((d) => d.note === '')).toBe(true)
  })
})
