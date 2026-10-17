// @vitest-environment node
// Фото объекта из формы заявки сайта Визора (задание сайта 2026-10-16, часть Б; ADR-022).
// Хранилище подставное, в памяти: настоящий S3 в тестах не нужен — подпись запросов проверяется отдельно.
import fs from 'node:fs'
import { newDb } from 'pg-mem'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { hashPassword, resetThrottle } from './auth.js'
import { now } from './db.js'
import { PHOTO_MAX_BYTES, createS3, sniffImage } from './photos.js'
import { checkS3, describeS3Config, explainS3Error } from './test-s3.js'

const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0]
const jpeg = (n = 64, fill = 7) => Buffer.concat([Buffer.from(JPEG_HEAD), Buffer.alloc(n - 4, fill)])
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)])
const webp = () => Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBP'), Buffer.alloc(16, 1)])
const heic = (brand = 'heic') => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp'), Buffer.from(brand), Buffer.alloc(16, 1)])

function fakeS3() {
  const store = new Map()
  const s3 = {
    configured: true, store, failPut: false, failDel: false,
    async put(key, body, mime) { if (s3.failPut) throw Object.assign(new Error('full'), { code: 'HTTP_507' }); store.set(key, { body, mime }) },
    async get(key) { return store.get(key)?.body ?? null },
    async del(key) { if (s3.failDel) throw Object.assign(new Error('down'), { code: 'ECONNECTION' }); store.delete(key) },
  }
  return s3
}

let app, cookie, s3

async function boot({ s3: custom } = {}) {
  resetThrottle()
  s3 = custom ?? fakeS3()
  const pool = new (newDb().adapters.createPg()).Pool()
  app = await buildApp({ dbConfig: pool, secure: false, s3, photoLimitBytes: 1024 * 1024 * 1024 })
  await app.db.prepare('INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)')
    .run('Владелец', 'owner@example.ru', await hashPassword('password123'), 'admin', now())
  await app.ready()
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.ru', password: 'password123' } })
  cookie = res.headers['set-cookie']
}
beforeEach(() => boot())
afterEach(async () => { await app?.close?.() })

const one = (sql, ...a) => app.db.prepare(sql).get(...a)
const all = (sql, ...a) => app.db.prepare(sql).all(...a)
const count = async (table) => Number((await one(`SELECT COUNT(*) c FROM ${table}`)).c)
const crm = (method, url, payload) => app.inject({ method, url, payload, headers: { cookie } })
let seq = 0
const lead = (body = {}) => {
  const request_id = body.request_id ?? `req-${++seq}`
  return app.inject({ method: 'POST', url: '/api/leads', payload: { project: 'nevarium-vizor', name: `Клиент ${seq}`, contact: `+7900${String(1000000 + seq)}`, task: 'Проверка', request_id, ...body } }).then((r) => ({ r, request_id }))
}
const photo = (request_id, buf, { idx = 0, type = 'image/jpeg', name = 'IMG 1.jpg', headers = {} } = {}) =>
  app.inject({ method: 'POST', url: `/api/leads/${request_id}/photos`, payload: buf, headers: { 'content-type': type, 'x-photo-index': String(idx), 'x-file-name': encodeURIComponent(name), 'idempotency-key': `${request_id}:${idx}`, ...headers } })

// server/index.js (прод-вход) в тестах не запускается — ему нужен настоящий Postgres. Один раз это стоило сорвавшегося
// деплоя: функцию вызвали, а импорт не добавили (ReferenceError при старте, платформа откатилась на прежнюю версию).
// Страховка: каждая функция, вызываемая отдельной строкой в index.js, обязана быть там импортирована или объявлена.
describe('server/index.js: все вызываемые функции импортированы', () => {
  it('нет вызова без импорта и без объявления; запуск фоновых задач — ровно по одному разу', () => {
    const src = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8')
    const imported = new Set([...src.matchAll(/import\s*\{([^}]+)\}/g)].flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop())).filter(Boolean))
    const declared = new Set([...src.matchAll(/\b(?:const|let|var|function)\s+([A-Za-z_]\w*)/g)].map((m) => m[1]))
    const globals = new Set(['console', 'setInterval', 'setTimeout', 'clearInterval', 'clearTimeout', 'fetch'])
    const called = [...src.matchAll(/^\s*(?:await\s+)?([A-Za-z_]\w*)\(/gm)].map((m) => m[1])
    expect(called.length).toBeGreaterThan(3)
    const unknown = called.filter((n) => !imported.has(n) && !declared.has(n) && !globals.has(n))
    expect(unknown, `вызваны без импорта: ${unknown.join(', ')}`).toEqual([])
    for (const starter of ['startOutboxWorker', 'scheduleAuthHousekeeping', 'schedulePhotoHousekeeping', 'scheduleEntitlementReminders']) {
      expect(called.filter((n) => n === starter), `${starter} должен запускаться один раз`).toHaveLength(1)
    }
  })
})

describe('тип файла — по содержимому, а не по заголовку', () => {
  it('JPEG, PNG, WebP, HEIC/HEIF распознаются; текст и обрезок — нет', () => {
    expect(sniffImage(jpeg())).toEqual({ mime: 'image/jpeg', ext: 'jpg' })
    expect(sniffImage(png()).mime).toBe('image/png')
    expect(sniffImage(webp()).mime).toBe('image/webp')
    for (const b of ['heic', 'heix', 'hevc']) expect(sniffImage(heic(b)).mime).toBe('image/heic')
    for (const b of ['mif1', 'msf1']) expect(sniffImage(heic(b)).mime).toBe('image/heif')
    expect(sniffImage(heic('mp42'))).toBeNull()
    expect(sniffImage(Buffer.from('<?php echo 1; ?> not an image at all'))).toBeNull()
    expect(sniffImage(Buffer.from([0xff, 0xd8]))).toBeNull()
    expect(sniffImage('строка')).toBeNull()
  })
})

describe('клиент S3: запросы подписаны, секрет не уходит', () => {
  const env = { S3_ENDPOINT: 'https://s3.example.test/', S3_BUCKET: 'bkt', S3_REGION: 'ru-1', S3_ACCESS_KEY: 'AKIDTEST', S3_SECRET_KEY: 'very-secret-key' }
  const clock = () => new Date('2026-10-17T20:05:09.123Z')
  const recorder = (status = 200, body = Buffer.from('x')) => {
    const calls = []
    return { calls, fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return { ok: status < 400, status, arrayBuffer: async () => body } } }
  }

  it('PUT: path-style, хеш тела в заголовке, подпись для ru-1/s3, секрета в запросе нет', async () => {
    const rec = recorder()
    const s3c = createS3(env, { fetchImpl: rec.fetchImpl, clock })
    expect(s3c.configured).toBe(true)
    await s3c.put('abc.jpg', jpeg(100), 'image/jpeg')
    const { url, init } = rec.calls[0]
    expect(url).toBe('https://s3.example.test/bkt/abc.jpg')
    expect(init.method).toBe('PUT')
    expect(init.headers['X-Amz-Date']).toBe('20261017T200509Z')
    expect(init.headers['X-Amz-Content-Sha256']).toMatch(/^[0-9a-f]{64}$/)
    expect(init.headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\/20261017\/ru-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/)
    expect(JSON.stringify(init.headers)).not.toContain('very-secret-key')
  })

  it('GET отдаёт байты, 404 — null; DELETE идемпотентен (404 — успех), другая ошибка — исключение', async () => {
    expect((await createS3(env, { fetchImpl: recorder(200, Buffer.from('data')).fetchImpl, clock }).get('k')).toString()).toBe('data')
    expect(await createS3(env, { fetchImpl: recorder(404).fetchImpl, clock }).get('k')).toBeNull()
    await createS3(env, { fetchImpl: recorder(404).fetchImpl, clock }).del('k')
    await expect(createS3(env, { fetchImpl: recorder(500).fetchImpl, clock }).del('k')).rejects.toMatchObject({ code: 'HTTP_500' })
    await expect(createS3(env, { fetchImpl: recorder(507).fetchImpl, clock }).put('k', jpeg(), 'image/jpeg')).rejects.toMatchObject({ code: 'HTTP_507' })
  })

  it('не настроено — configured=false и понятная ошибка', async () => {
    const s3c = createS3({})
    expect(s3c.configured).toBe(false)
    await expect(s3c.put('k', jpeg(), 'image/jpeg')).rejects.toMatchObject({ code: 'S3_NOT_CONFIGURED' })
  })
})

describe('test-s3 (диагностика хранилища из консоли сервера)', () => {
  it('настройки без секретов: только «задан»', () => {
    const cfg = describeS3Config({ S3_ENDPOINT: 'https://s3.example.test', S3_BUCKET: 'bkt', S3_ACCESS_KEY: 'AKID', S3_SECRET_KEY: 'very-secret-key' })
    expect(cfg).toMatchObject({ endpoint: 'https://s3.example.test', bucket: 'bkt', region: 'ru-1', accessKeySet: true, secretSet: true, limitMb: 1024 })
    expect(JSON.stringify(cfg)).not.toContain('very-secret')
    expect(describeS3Config({}).accessKeySet).toBe(false)
  })

  it('проверка: запись, чтение, удаление; в бакете ничего не остаётся', async () => {
    const steps = await checkS3(s3)
    expect(steps.map((s) => [s.name, s.ok])).toEqual([['запись', true], ['чтение', true], ['удаление', true]])
    expect(s3.store.size).toBe(0)
  })

  it('запись упала — дальше не идём; чтение подменено — ошибка, но удаление всё равно выполняется', async () => {
    s3.failPut = true
    const failed = await checkS3(s3)
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ name: 'запись', ok: false })
    expect(explainS3Error(failed[0].err)).toContain('переполнен')
    s3.failPut = false
    s3.get = async () => Buffer.from('другое')
    const bad = await checkS3(s3)
    expect(bad.map((s) => [s.name, s.ok])).toEqual([['запись', true], ['чтение', false], ['удаление', true]])
    expect(s3.store.size).toBe(0)
  })

  it('подсказки: доступ, бакет, связь, не настроено', () => {
    expect(explainS3Error({ code: 'HTTP_403' })).toContain('ключ')
    expect(explainS3Error({ code: 'HTTP_404' })).toContain('S3_BUCKET')
    expect(explainS3Error({ code: 'ETIMEDOUT' })).toContain('S3_ENDPOINT')
    expect(explainS3Error({ code: 'S3_NOT_CONFIGURED' })).toContain('S3_SECRET_KEY')
  })
})

describe('приём: POST /api/leads/{request_id}/photos', () => {
  it('204: файл в хранилище под случайным именем, в базе — описание; повтор того же номера — без второй копии', async () => {
    const { request_id } = await lead()
    const buf = jpeg(2048)
    expect((await photo(request_id, buf, { name: 'Кухня 1.jpg' })).statusCode).toBe(204)
    expect((await photo(request_id, buf, { name: 'Кухня 1.jpg' })).statusCode).toBe(204)
    expect(s3.store.size).toBe(1)
    const row = await one('SELECT * FROM lead_photos')
    expect(row).toMatchObject({ idx: 0, mime: 'image/jpeg', size: 2048, original_name: 'Кухня 1.jpg', request_id })
    expect(row.storage_key).toMatch(/^[0-9a-f]{48}\.jpg$/)
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(s3.store.get(row.storage_key).body.equals(buf)).toBe(true)
    const deal = await one('SELECT id, contact_id FROM deals')
    expect(row).toMatchObject({ deal_id: deal.id, contact_id: deal.contact_id })
  })

  it('все пять форматов принимаются, несколько фото с разными номерами', async () => {
    const { request_id } = await lead()
    const files = [[jpeg(), 'image/jpeg'], [png(), 'image/png'], [webp(), 'image/webp'], [heic('heic'), 'image/heic'], [heic('mif1'), 'image/heif']]
    for (const [i, [buf, type]] of files.entries()) expect((await photo(request_id, buf, { idx: i, type })).statusCode).toBe(204)
    expect((await all('SELECT mime FROM lead_photos ORDER BY idx')).map((r) => r.mime)).toEqual(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
  })

  it('415: Content-Type врёт — смотрим на содержимое', async () => {
    const { request_id } = await lead()
    const res = await photo(request_id, Buffer.from('<script>alert(1)</script> not really a picture'), { type: 'image/jpeg' })
    expect(res.statusCode).toBe(415)
    expect(s3.store.size).toBe(0)
    expect((await photo(request_id, Buffer.alloc(0))).statusCode).toBe(415)
  })

  it('413: файл больше 15 МБ; ровно 15 МБ проходит', async () => {
    const { request_id } = await lead()
    expect((await photo(request_id, jpeg(PHOTO_MAX_BYTES + 1), { idx: 0 })).statusCode).toBe(413)
    expect((await photo(request_id, jpeg(16 * 1024 * 1024 + 10), { idx: 1 })).statusCode).toBe(413)
    expect((await photo(request_id, jpeg(PHOTO_MAX_BYTES), { idx: 2 })).statusCode).toBe(204)
    expect(s3.store.size).toBe(1)
  })

  it('409: номер 10 и дальше — уже 10 фото; десять фото принимаются', async () => {
    const { request_id } = await lead()
    for (let i = 0; i < 10; i++) expect((await photo(request_id, jpeg(64, i + 1), { idx: i })).statusCode, `фото ${i}`).toBe(204)
    expect((await photo(request_id, jpeg(), { idx: 10 })).statusCode).toBe(409)
    expect(await count('lead_photos')).toBe(10)
    expect((await photo(request_id, jpeg(), { idx: -1 })).statusCode).toBe(400)
    expect((await photo(request_id, jpeg(), { headers: { 'x-photo-index': 'abc' } })).statusCode).toBe(400)
  })

  it('404 одинаково: неизвестный request_id, чат, чужой проект, окно 60 минут истекло', async () => {
    expect((await photo('no-such-request', jpeg())).statusCode).toBe(404)
    const chat = await lead({ source: 'chat', detail: 'вопрос', transcript: 'Привет' })
    expect((await photo(chat.request_id, jpeg())).statusCode).toBe(404)
    const lab = await lead({ project: 'nevarium1' })
    expect((await photo(lab.request_id, jpeg())).statusCode).toBe(404)

    const old = await lead()
    expect((await photo(old.request_id, jpeg())).statusCode).toBe(204)
    await app.db.prepare('UPDATE lead_intake SET created_at = ? WHERE request_id = ?').run(new Date(Date.now() - 61 * 60_000).toISOString(), old.request_id)
    expect((await photo(old.request_id, jpeg(64, 2), { idx: 1 })).statusCode).toBe(404)
    expect(await count('lead_photos')).toBe(1)
  })

  it('404: заявка, помеченная «подозрительной» (много обращений с одного адреса), фото не принимает', async () => {
    for (let i = 0; i < 3; i++) await lead()
    const fourth = await lead()
    expect(Number((await one('SELECT COUNT(*) c FROM contacts WHERE suspicious = 1')).c)).toBe(1)
    expect((await photo(fourth.request_id, jpeg())).statusCode).toBe(404)
  })

  it('заявка без ключа идемпотентности окна прикрепления не получает', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/leads', payload: { project: 'nevarium-vizor', name: 'Без ключа', contact: '+79005550101' } })
    expect(res.statusCode).toBe(204)
    expect(await count('lead_intake')).toBe(0)
  })

  it('503: хранилище недоступно или полно — заявка сохранена, фото нет; после восстановления тот же ключ проходит', async () => {
    const { r, request_id } = await lead()
    expect(r.statusCode).toBe(204)
    s3.failPut = true
    expect((await photo(request_id, jpeg())).statusCode).toBe(503)
    expect(await count('deals')).toBe(1)
    expect(await count('lead_photos')).toBe(0)
    s3.failPut = false
    expect((await photo(request_id, jpeg())).statusCode).toBe(204)
    expect(await count('lead_photos')).toBe(1)
  })

  it('503: хранилище не настроено', async () => {
    await app.close()
    await boot({ s3: { ...fakeS3(), configured: false } })
    const { request_id } = await lead()
    expect((await photo(request_id, jpeg())).statusCode).toBe(503)
  })

  it('CORS: preflight разрешает нужные заголовки только сайтам проекта', async () => {
    await app.db.prepare("UPDATE projects SET origins = 'https://vizor.example.test' WHERE slug = 'nevarium-vizor'").run()
    await app.refreshProjectsOriginCache()
    const ok = await app.inject({ method: 'OPTIONS', url: '/api/leads/abc/photos', headers: { origin: 'https://vizor.example.test', 'access-control-request-method': 'POST' } })
    expect(ok.statusCode).toBe(204)
    for (const h of ['content-type', 'x-photo-index', 'x-file-name', 'idempotency-key']) expect(ok.headers['access-control-allow-headers']).toContain(h)
    expect(ok.headers['access-control-allow-origin']).toBe('https://vizor.example.test')
    const bad = await app.inject({ method: 'OPTIONS', url: '/api/leads/abc/photos', headers: { origin: 'https://evil.example.test' } })
    expect(bad.statusCode).toBe(403)
  })
})

describe('просмотр в CRM — только вошедшим', () => {
  it('список и скачивание: без входа 401; с входом — файл как вложение, nosniff, без кеша; открытие в журнале', async () => {
    const { request_id } = await lead()
    const buf = jpeg(512)
    await photo(request_id, buf, { name: 'Ванная.jpg' })
    const contact = await one('SELECT id FROM contacts')
    const rowId = (await one('SELECT id FROM lead_photos')).id

    expect((await app.inject({ method: 'GET', url: `/api/crm/contacts/${contact.id}/photos` })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: `/api/crm/photos/${rowId}` })).statusCode).toBe(401)

    const list = (await crm('GET', `/api/crm/contacts/${contact.id}/photos`)).json()
    expect(list.items).toHaveLength(1)
    expect(list.items[0]).toMatchObject({ id: rowId, size: 512, original_name: 'Ванная.jpg', mime: 'image/jpeg' })
    expect(JSON.stringify(list)).not.toContain('storage_key')

    const dl = await crm('GET', `/api/crm/photos/${rowId}`)
    expect(dl.statusCode).toBe(200)
    expect(dl.rawPayload.equals(buf)).toBe(true)
    expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="photo-\d+\.jpg"; filename\*=UTF-8''/)
    expect(dl.headers['content-disposition']).toContain(encodeURIComponent('Ванная.jpg'))
    expect(dl.headers['x-content-type-options']).toBe('nosniff')
    expect(dl.headers['cache-control']).toContain('no-store')
    expect(dl.headers['content-type']).toBe('image/jpeg')
    expect(Number((await one("SELECT COUNT(*) c FROM audit_log WHERE action = 'view' AND entity = 'lead_photos'")).c)).toBe(1)
    expect((await crm('GET', '/api/crm/photos/99999')).statusCode).toBe(404)
  })

  it('объект пропал из хранилища — 404, хранилище недоступно — 503', async () => {
    const { request_id } = await lead()
    await photo(request_id, jpeg())
    const row = await one('SELECT id, storage_key FROM lead_photos')
    s3.store.delete(row.storage_key)
    expect((await crm('GET', `/api/crm/photos/${row.id}`)).statusCode).toBe(404)
    s3.get = async () => { throw new Error('down') }
    expect((await crm('GET', `/api/crm/photos/${row.id}`)).statusCode).toBe(503)
  })

  it('«Настройки»: занятое место считается по таблице', async () => {
    const { request_id } = await lead()
    await photo(request_id, jpeg(1000), { idx: 0 })
    await photo(request_id, jpeg(500), { idx: 1 })
    const settings = (await crm('GET', '/api/crm/settings')).json()
    expect(settings.photos).toMatchObject({ count: 2, bytes: 1500, configured: true })
    expect(settings.photos.limitBytes).toBe(1024 * 1024 * 1024)
  })
})

describe('удаление: строка и объект не расходятся (персональные данные — EXIF с координатами)', () => {
  async function leadWithPhotos(n = 2) {
    const { request_id } = await lead()
    for (let i = 0; i < n; i++) await photo(request_id, jpeg(64, i + 1), { idx: i })
    return request_id
  }

  it('удаление сделки: строки уходят сразу, объекты — очередью, фоновый проход чистит бакет', async () => {
    await leadWithPhotos(2)
    const deal = await one('SELECT id FROM deals')
    expect(s3.store.size).toBe(2)
    expect((await crm('DELETE', `/api/crm/deals/${deal.id}`)).statusCode).toBe(200)
    expect(await count('lead_photos')).toBe(0)
    expect(await count('photo_deletions')).toBe(2)
    expect(s3.store.size).toBe(2)
    await app.photoSweep()
    expect(s3.store.size).toBe(0)
    expect(await count('photo_deletions')).toBe(0)
  })

  it('сделка с записью о повторной заявке удаляется: история по контакту остаётся, ссылка на сделку рвётся (раньше — 500 по FK)', async () => {
    const phone = '+79990000000'
    const first = await lead({ contact: phone, plan: 'stage' })
    await photo(first.request_id, jpeg(64, 1), { idx: 0 })
    await lead({ contact: phone, plan: 'house' }) // тот же человек → «Повторная заявка» → interactions.deal_id
    const deal = await one('SELECT id, contact_id FROM deals')
    const before = await all('SELECT id, deal_id FROM interactions WHERE deal_id IS NOT NULL')
    expect(before.length).toBeGreaterThan(0)
    expect((await crm('DELETE', `/api/crm/deals/${deal.id}`)).statusCode).toBe(200)
    const after = await all('SELECT id, deal_id FROM interactions')
    expect(after.length).toBe(before.length)
    expect(after.every((r) => r.deal_id === null)).toBe(true)
    expect(await count('lead_photos')).toBe(0)
    expect((await crm('DELETE', `/api/crm/contacts/${deal.contact_id}`)).statusCode).toBe(200)
  })

  it('хранилище недоступно при удалении — строка уже не видна, объект ждёт в очереди и удаляется позже', async () => {
    await leadWithPhotos(1)
    const deal = await one('SELECT id FROM deals')
    await crm('DELETE', `/api/crm/deals/${deal.id}`)
    s3.failDel = true
    await app.photoSweep()
    expect(s3.store.size).toBe(1)
    expect(await one('SELECT attempts, last_error FROM photo_deletions')).toMatchObject({ attempts: 1, last_error: 'ECONNECTION' })
    s3.failDel = false
    await app.photoSweep()
    expect(s3.store.size).toBe(0)
  })

  it('обезличивание контакта стирает его фото', async () => {
    await leadWithPhotos(2)
    const contact = await one('SELECT id FROM contacts')
    expect((await crm('POST', `/api/crm/contacts/${contact.id}/anonymize`)).statusCode).toBe(200)
    expect(await count('lead_photos')).toBe(0)
    expect(await count('lead_intake')).toBe(0)
    await app.photoSweep()
    expect(s3.store.size).toBe(0)
  })

  it('удаление контакта стирает и фото, привязанные к нему напрямую (если сделку удалили раньше)', async () => {
    const request_id = await leadWithPhotos(1)
    const deal = await one('SELECT id, contact_id FROM deals')
    // фото, оставшееся за контактом без сделки (защитный путь: обычно оно уходит вместе со сделкой)
    s3.store.set('orphan-key.jpg', { body: jpeg(), mime: 'image/jpeg' })
    await app.db.prepare('INSERT INTO lead_photos (contact_id, deal_id, request_id, idx, storage_key, mime, size, sha256, original_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(deal.contact_id, 0, `${request_id}-x`, 0, 'orphan-key.jpg', 'image/jpeg', 64, 'x', '', now())
    expect((await crm('DELETE', `/api/crm/deals/${deal.id}`)).statusCode).toBe(200)
    expect(await count('lead_photos')).toBe(1)
    expect((await crm('DELETE', `/api/crm/contacts/${deal.contact_id}`)).statusCode).toBe(200)
    expect(await count('lead_photos')).toBe(0)
    await app.photoSweep()
    expect(s3.store.size).toBe(0)
  })

  it('импорт дампа удаляет все фото: файлов в дампе нет, а id контактов после восстановления другие', async () => {
    await leadWithPhotos(2)
    const dump = (await crm('GET', '/api/crm/export')).json()
    expect(JSON.stringify(dump)).not.toContain('storage_key')
    expect(dump.lead_photos).toBeUndefined()
    expect((await crm('POST', '/api/crm/import', dump)).statusCode).toBe(200)
    expect(await count('lead_photos')).toBe(0)
    await app.photoSweep()
    expect(s3.store.size).toBe(0)
  })
})

describe('уведомление «📷 N фото» и уборка окна приёма', () => {
  it('одно сообщение на заявку через две минуты после первого фото; число есть, ПДн нет; повторно не шлётся', async () => {
    const { request_id } = await lead({ name: 'Иван Секретов' })
    for (let i = 0; i < 3; i++) await photo(request_id, jpeg(64, i + 1), { idx: i })
    const before = Number((await one("SELECT COUNT(*) c FROM outbox WHERE kind = 'text'")).c)
    await app.photoSweep()
    expect(Number((await one("SELECT COUNT(*) c FROM outbox WHERE kind = 'text'")).c)).toBe(before) // рано: пара минут ещё не прошла
    await app.db.prepare('UPDATE lead_intake SET first_photo_at = ? WHERE request_id = ?').run(new Date(Date.now() - 3 * 60_000).toISOString(), request_id)
    await app.photoSweep()
    await app.photoSweep()
    const texts = (await all("SELECT payload FROM outbox WHERE kind = 'text'")).map((r) => JSON.parse(r.payload).text)
    expect(texts).toHaveLength(before + 1)
    const msg = texts.at(-1)
    expect(msg).toContain('фото: 3')
    expect(msg).not.toContain('Секретов')
    expect(msg).not.toContain('+7900')
  })

  it('записи окна приёма старше двух часов убираются', async () => {
    const { request_id } = await lead()
    await app.db.prepare('UPDATE lead_intake SET created_at = ? WHERE request_id = ?').run(new Date(Date.now() - 3 * 3600_000).toISOString(), request_id)
    await app.photoSweep()
    expect(await count('lead_intake')).toBe(0)
  })
})
