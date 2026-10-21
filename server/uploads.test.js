// @vitest-environment node
// Загрузка фото/видео этапа по личной ссылке, PDF-отчёты в кабинете, письма клиенту, выдача файлов NVizor
// (ADR-025, задание сайта 2026-10-20). Хранилище — подставное, в памяти; TEST_DATABASE_URL — тот же набор на настоящем Postgres.
import pg from 'pg'
import { newDb } from 'pg-mem'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, mskToday } from './app.js'
import { hashPassword, resetThrottle } from './auth.js'
import { now } from './db.js'
import { createS3, signPostPolicy } from './photos.js'
import { composeClientMail, maskEmail } from './client-mail.js'
import { VIDEO_MAX_BYTES } from './uploads.js'
import { checkS3Presign, corsXml, DEFAULT_CORS_ORIGINS } from './test-s3.js'

const TOKEN = 'test-nvizor-token-0123456789abcdef0123456789'
const NV = { authorization: `Bearer ${TOKEN}` }
const PHONE = '+79215551488'
const REAL_PG = process.env.TEST_DATABASE_URL || ''
let schemaSeq = 0
async function makePool() {
  if (!REAL_PG) return new (newDb().adapters.createPg()).Pool()
  const schema = `u${process.pid}_${process.env.VITEST_WORKER_ID ?? 0}_${++schemaSeq}`
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

const JPEG = (n = 64, fill = 7) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n - 4, fill)])
const MP4 = (n = 64) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(n - 12, 3)])
const PDF = (n = 200) => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(n - 9, 0x20)])

function fakeS3() {
  const store = new Map()
  const real = createS3({ S3_ENDPOINT: 'https://s3.example.test', S3_BUCKET: 'bkt', S3_REGION: 'ru-1', S3_ACCESS_KEY: 'AKIDTEST', S3_SECRET_KEY: 'very-secret-key' }, { clock: () => new Date('2026-10-20T10:00:00Z') })
  return {
    configured: true, store, failPut: false,
    async put(key, body, mime) { if (this.failPut) throw Object.assign(new Error('full'), { code: 'HTTP_507' }); store.set(key, { body, mime }) },
    async get(key) { return store.get(key)?.body ?? null },
    async del(key) { store.delete(key) },
    async head(key) { const o = store.get(key); return o ? { size: o.body.length, mime: o.mime } : null },
    async getRange(key, from, to) { const o = store.get(key); return o ? o.body.subarray(from, to + 1) : null },
    async stream(key) {
      const o = store.get(key)
      if (!o) return null
      return { body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(o.body)); c.close() } }), size: o.body.length }
    },
    presignPost: (args) => real.presignPost(args),
  }
}

function fakeMailer() {
  return { configured: true, mode: 'fake', sent: [], fail: false, async send(m) { if (this.fail) throw Object.assign(new Error('boom'), { code: 'HTTP_500' }); this.sent.push(m) } }
}

let app, pool, s3, mailer, cookie
beforeEach(async () => {
  resetThrottle()
  s3 = fakeS3()
  mailer = fakeMailer()
  pool = await makePool()
  app = await buildApp({ dbConfig: pool, secure: false, nvizorToken: TOKEN, cabinetBaseUrl: 'https://nevarium-vizor.ru', s3, mailer })
  await app.db.prepare('INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)')
    .run('Админ', 'a@a.ru', await hashPassword('password123'), 'admin', now())
  await app.ready()
  cookie = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@a.ru', password: 'password123' } })).headers['set-cookie']
})
afterEach(async () => {
  try { await app?.close?.() } finally { await dropPool(pool) }
})

const one = (sql, ...a) => app.db.prepare(sql).get(...a)
const all = (sql, ...a) => app.db.prepare(sql).all(...a)
const count = async (sql, ...a) => Number((await one(sql, ...a)).c)
const crm = (method, url, payload) => app.inject({ method, url, payload, headers: { cookie } })
const nv = (method, url, payload, headers = {}) => app.inject({ method, url, payload, headers: { ...NV, ...headers } })
const tokenOf = (url) => url.split('/#/c/')[1]

let seq = 0
/** Клиент сайта Визора: заявка с телефоном, почтой для счёта и слепком согласия. */
async function vizorClient({ phone = PHONE, email = 'client@example.ru', consent = true } = {}) {
  const payload = { name: `Иван ${++seq}`, contact: phone, task: 'Квартира / ремонт', project: 'nevarium-vizor', request_id: `u-${seq}`, invoice_channel: 'email', invoice_contact: email }
  if (consent) payload.consent = { version: 'v1', text: 'Согласен', accepted_at: '2026-10-20T09:00:00Z' }
  await app.inject({ method: 'POST', url: '/api/leads', payload })
  return (await one('SELECT id FROM contacts ORDER BY id DESC LIMIT 1')).id
}
/** Сотрудник открывает приём → { id, url, token, res, ... }. */
async function openUpload(contactId, body = { stage_code: 'electrical' }) {
  const res = await crm('POST', `/api/crm/contacts/${contactId}/uploads`, body)
  const j = res.json()
  return { res, ...j, token: j.url ? tokenOf(j.url) : null }
}
const photo = (uploadId, token, buf, { idx = 0, type = 'image/jpeg', headers = {} } = {}) =>
  app.inject({ method: 'POST', url: `/api/client/upload/${uploadId}/photos`, payload: buf, headers: { 'content-type': type, 'x-photo-index': String(idx), 'x-client-key': token, ...headers } })
const clientPost = (url, token, payload) => app.inject({ method: 'POST', url, payload, headers: { 'x-client-key': token } })
const summary = async (token) => (await app.inject({ method: 'POST', url: '/api/client/summary', payload: { token } })).json()
const publishReport = (phone, buf, { number = 'NV-2026-000006', version = '1', headers = {} } = {}) =>
  nv('POST', '/api/nvizor/reports', buf, { 'content-type': 'application/pdf', 'x-record-id': 'rec-1', 'x-report-number': number, 'x-report-version': version, 'x-published-at': '2026-10-20T12:00:00Z', 'x-client-phone': phone, ...headers })
const enableClientMail = () => crm('PATCH', '/api/crm/settings', { clientMail: { enabled: true } })

describe('открыть приём (сотрудник)', () => {
  it('этап из тарифа → ссылка, готовый текст, срок 7 дней; кабинет показывает приём; в журнале', async () => {
    const id = await vizorClient()
    expect((await summary('нет такого ключа')).error).toBe('not_found')
    const op = await openUpload(id)
    expect(op.res.statusCode).toBe(200)
    expect(op.expiresOn).toBe(new Date(Date.parse(`${mskToday()}T12:00:00Z`) + 6 * 864e5).toISOString().slice(0, 10))
    expect(op.message).toContain('«Электрика»')
    expect(op.message).toContain(op.url)
    expect(op.mail).toBe('disabled')
    const s = await summary(op.token)
    expect(s.upload).toEqual({ id: op.id, stage: 'Электрика', kind: 'primary', photos: { limit: 30, used: 0 }, videos: { limit: 2, used: 0 }, expiresOn: op.expiresOn })
    expect(s.reports).toEqual([])
    expect((await one("SELECT detail FROM audit_log WHERE entity = 'upload_requests'")).detail).toContain('Электрика')
  })

  it('повторная — 10 фото без видео; свободная строка этапа; тот же этап дважды — 409; неверный этап и вид — 400', async () => {
    const id = await vizorClient()
    const re = await openUpload(id, { stage_title: 'Балкон', kind: 'recheck' })
    expect((await summary(re.token)).upload).toMatchObject({ stage: 'Балкон', kind: 'recheck', photos: { limit: 10 }, videos: { limit: 0 } })
    const dup = await crm('POST', `/api/crm/contacts/${id}/uploads`, { stage_title: 'балкон' })
    expect(dup.statusCode).toBe(409)
    expect(dup.json()).toMatchObject({ error: 'already_open', id: re.id })
    expect((await crm('POST', `/api/crm/contacts/${id}/uploads`, { stage_code: 'nope' })).statusCode).toBe(400)
    expect((await crm('POST', `/api/crm/contacts/${id}/uploads`, {})).statusCode).toBe(400)
    expect((await crm('POST', `/api/crm/contacts/${id}/uploads`, { stage_code: 'plumbing', kind: 'x' })).statusCode).toBe(400)
    expect((await crm('POST', '/api/crm/contacts/999999/uploads', { stage_code: 'plumbing' })).statusCode).toBe(404)
  })

  it('обезличенному контакту открыть приём нельзя', async () => {
    const id = await vizorClient()
    await crm('POST', `/api/crm/contacts/${id}/anonymize`)
    expect((await crm('POST', `/api/crm/contacts/${id}/uploads`, { stage_code: 'plumbing' })).statusCode).toBe(409)
  })

  it('«Принято» закрывает приём — кабинет его больше не показывает; закрыть можно и из NVizor', async () => {
    const id = await vizorClient()
    const a = await openUpload(id)
    expect((await crm('POST', `/api/crm/uploads/${a.id}/close`)).statusCode).toBe(200)
    expect((await summary(a.token)).upload).toBeNull()
    expect((await photo(a.id, a.token, JPEG())).statusCode).toBe(404)
    const b = await openUpload(id, { stage_code: 'plumbing' })
    expect((await nv('POST', `/api/nvizor/uploads/${b.id}/close`)).statusCode).toBe(200)
    expect((await summary(b.token)).upload).toBeNull()
    expect((await nv('POST', '/api/nvizor/uploads/999999/close')).statusCode).toBe(404)
  })
})

describe('фото этапа по ссылке', () => {
  it('принимает, хранит КАК ЕСТЬ, повтор номера — 204 без копии, счётчик растёт', async () => {
    const id = await vizorClient()
    const op = await openUpload(id)
    const buf = JPEG(300, 9)
    expect((await photo(op.id, op.token, buf, { idx: 0, headers: { 'x-file-name': encodeURIComponent('IMG 1.jpg') } })).statusCode).toBe(204)
    expect((await photo(op.id, op.token, buf, { idx: 0 })).statusCode).toBe(204)
    expect((await photo(op.id, op.token, JPEG(100), { idx: 1 })).statusCode).toBe(204)
    expect(await count("SELECT COUNT(*) c FROM upload_files WHERE kind = 'photo'")).toBe(2)
    expect([...s3.store.values()].some((o) => o.body.equals(buf))).toBe(true)
    expect((await one("SELECT original_name FROM upload_files WHERE idx = 0 AND kind = 'photo'")).original_name).toBe('IMG 1.jpg')
    expect((await summary(op.token)).upload.photos).toEqual({ limit: 30, used: 2 })
  })

  it('ошибки: чужой/неверный ключ и чужой приём — 404; не картинка 415; большой 413; номер ≥ лимита 409; плохой номер 400', async () => {
    const a = await vizorClient()
    const opA = await openUpload(a)
    const b = await vizorClient({ phone: '+79215550000' })
    const opB = await openUpload(b)
    expect((await photo(opA.id, 'неверный', JPEG())).statusCode).toBe(404)
    expect((await photo(opA.id, opB.token, JPEG())).statusCode).toBe(404)
    expect((await photo(opA.id, opA.token, Buffer.from('<?php echo 1; ?> это не картинка'))).statusCode).toBe(415)
    expect((await photo(opA.id, opA.token, Buffer.alloc(16 * 1024 * 1024 - 100, 1).fill(0xff, 0, 3))).statusCode).toBe(413)
    expect((await photo(opA.id, opA.token, JPEG(), { idx: 30 })).statusCode).toBe(409)
    expect((await photo(opA.id, opA.token, JPEG(), { idx: -1 })).statusCode).toBe(400)
    // повторная: лимит 10 фото
    const re = await openUpload(a, { stage_title: 'Повтор', kind: 'recheck' })
    expect((await photo(re.id, re.token, JPEG(), { idx: 10 })).statusCode).toBe(409)
    expect((await photo(re.id, re.token, JPEG(), { idx: 9 })).statusCode).toBe(204)
    s3.failPut = true
    expect((await photo(re.id, re.token, JPEG(), { idx: 1 })).statusCode).toBe(503)
  })

  it('истёкший приём — 404 (срок — последний день включительно)', async () => {
    const id = await vizorClient()
    const op = await openUpload(id)
    await app.db.prepare('UPDATE upload_requests SET expires_on = ? WHERE id = ?').run(mskToday(), op.id)
    expect((await photo(op.id, op.token, JPEG())).statusCode).toBe(204) // сегодня — ещё можно
    await app.db.prepare('UPDATE upload_requests SET expires_on = ? WHERE id = ?').run('2020-01-01', op.id)
    expect((await photo(op.id, op.token, JPEG(), { idx: 2 })).statusCode).toBe(404)
    expect((await summary(op.token)).upload).toBeNull()
  })

  it('CORS: preflight разрешает нужные заголовки только доменам сайта', async () => {
    const ok = await app.inject({ method: 'OPTIONS', url: '/api/client/upload/1/photos', headers: { origin: 'https://nevarium-vizor.ru', 'access-control-request-method': 'POST' } })
    expect(ok.statusCode).toBe(204)
    for (const h of ['content-type', 'x-client-key', 'x-photo-index', 'x-file-name', 'idempotency-key']) expect(ok.headers['access-control-allow-headers']).toContain(h)
    const bad = await app.inject({ method: 'OPTIONS', url: '/api/client/upload/1/photos', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } })
    expect(bad.statusCode).toBe(403)
  })
})

describe('видео этапа: прямо в бакет', () => {
  const videoUrl = (uploadId, token, body) => clientPost(`/api/client/upload/${uploadId}/video-url`, token, body)
  const videoDone = (uploadId, token, index) => clientPost(`/api/client/upload/${uploadId}/video-done`, token, { index })

  it('подписанная форма: ключ, тип, размер ≤ 300 МБ, срок 30 минут, секрета в ответе нет; после загрузки — подтверждение', async () => {
    const id = await vizorClient()
    const op = await openUpload(id)
    const res = await videoUrl(op.id, op.token, { index: 0, size: 120 * 1024 * 1024, type: 'video/mp4' })
    expect(res.statusCode).toBe(200)
    const { url, fields, expiresIn } = res.json()
    expect(url).toBe('https://s3.example.test/bkt')
    expect(expiresIn).toBe(1800)
    expect(fields.key).toMatch(/^v\/[0-9a-f]{48}\.mp4$/)
    expect(fields['Content-Type']).toBe('video/mp4')
    const policy = JSON.parse(Buffer.from(fields.policy, 'base64').toString())
    expect(policy.conditions).toContainEqual(['content-length-range', 1, VIDEO_MAX_BYTES])
    expect(policy.conditions).toContainEqual(['eq', '$key', fields.key])
    expect(Date.parse(policy.expiration) - Date.parse('2026-10-20T10:00:00Z')).toBe(30 * 60_000)
    expect(JSON.stringify(res.json())).not.toContain('very-secret-key')
    expect(fields['x-amz-signature']).toBe(signPostPolicy(fields.policy, { secret: 'very-secret-key', day: '20261020', region: 'ru-1' }))

    // клиент ещё не загрузил — 404; не использовано
    expect((await videoDone(op.id, op.token, 0)).statusCode).toBe(404)
    expect((await summary(op.token)).upload.videos.used).toBe(0)
    // загрузил (в тесте кладём объект сами) — подтверждение принимает, повтор — 204, номер занят — 409
    s3.store.set(fields.key, { body: MP4(5000), mime: 'video/mp4' })
    expect((await videoDone(op.id, op.token, 0)).statusCode).toBe(204)
    expect((await videoDone(op.id, op.token, 0)).statusCode).toBe(204)
    expect((await summary(op.token)).upload.videos).toEqual({ limit: 2, used: 1 })
    expect((await videoUrl(op.id, op.token, { index: 0, size: 10, type: 'video/mp4' })).statusCode).toBe(409)
    expect((await one("SELECT size FROM upload_files WHERE kind = 'video'")).size).toBe(5000)
  })

  it('отказы: тип, размер, номер ≥ лимита, повторная проверка без видео, чужой ключ; обман с типом файла', async () => {
    const id = await vizorClient()
    const op = await openUpload(id)
    expect((await videoUrl(op.id, op.token, { index: 0, size: 10, type: 'video/webm' })).statusCode).toBe(415)
    expect((await videoUrl(op.id, op.token, { index: 0, size: VIDEO_MAX_BYTES + 1, type: 'video/mp4' })).statusCode).toBe(413)
    expect((await videoUrl(op.id, op.token, { index: 2, size: 10, type: 'video/mp4' })).statusCode).toBe(409)
    expect((await videoUrl(op.id, op.token, { index: 'x', size: 10, type: 'video/mp4' })).statusCode).toBe(400)
    expect((await videoUrl(op.id, 'неверный', { index: 0, size: 10, type: 'video/mp4' })).statusCode).toBe(404)
    const re = await openUpload(id, { stage_title: 'Повтор', kind: 'recheck' })
    expect((await videoUrl(re.id, re.token, { index: 0, size: 10, type: 'video/mp4' })).statusCode).toBe(409)
    // клиент загрузил в бакет не видео: подтверждение отказывает, объект уходит в очередь удаления, номер освобождается
    const fields = (await videoUrl(op.id, op.token, { index: 1, size: 10, type: 'video/quicktime' })).json().fields
    expect(fields.key).toMatch(/\.mov$/)
    s3.store.set(fields.key, { body: Buffer.from('это совсем не видео, просто текст'), mime: 'video/quicktime' })
    expect((await videoDone(op.id, op.token, 1)).statusCode).toBe(415)
    expect(await count('SELECT COUNT(*) c FROM photo_deletions WHERE storage_key = ?', fields.key)).toBe(1)
    expect((await videoUrl(op.id, op.token, { index: 1, size: 10, type: 'video/mp4' })).statusCode).toBe(200)
  })

  it('незавершённое видео убирается фоном через пару часов, объект — в очередь удаления', async () => {
    const id = await vizorClient()
    const op = await openUpload(id)
    const key = (await videoUrl(op.id, op.token, { index: 0, size: 10, type: 'video/mp4' })).json().fields.key
    s3.store.set(key, { body: MP4(100), mime: 'video/mp4' })
    await app.photoSweep()
    expect(await count("SELECT COUNT(*) c FROM upload_files WHERE state = 'pending'")).toBe(1)
    await app.db.prepare("UPDATE upload_files SET created_at = '2020-01-01T00:00:00Z'").run()
    await app.photoSweep()
    await app.photoSweep()
    expect(await count('SELECT COUNT(*) c FROM upload_files')).toBe(0)
    expect(s3.store.has(key)).toBe(false)
  })
})

describe('сотрудник и NVizor видят файлы', () => {
  it('список с файлами, скачивание (поток, журнал), выдача NVizor по телефону; без ключа — 401; чужой телефон — 404', async () => {
    const id = await vizorClient()
    const op = await openUpload(id)
    const buf = JPEG(400, 5)
    await photo(op.id, op.token, buf, { idx: 0, headers: { 'x-file-name': encodeURIComponent('фото.jpg') } })
    const fields = (await clientPost(`/api/client/upload/${op.id}/video-url`, op.token, { index: 0, size: 10, type: 'video/mp4' })).json().fields
    s3.store.set(fields.key, { body: MP4(900), mime: 'video/mp4' })
    await clientPost(`/api/client/upload/${op.id}/video-done`, op.token, { index: 0 })

    const list = (await crm('GET', `/api/crm/contacts/${id}/uploads`)).json()
    expect(list.items[0]).toMatchObject({ id: op.id, stage: 'Электрика', open: true, photos: { limit: 30, used: 1 }, videos: { limit: 2, used: 1 } })
    expect(list.items[0].files.map((f) => `${f.kind}${f.idx}`)).toEqual(['photo0', 'video0'])
    const photoId = list.items[0].files[0].id
    const dl = await crm('GET', `/api/crm/upload-files/${photoId}`)
    expect(dl.statusCode).toBe(200)
    expect(dl.rawPayload.equals(buf)).toBe(true)
    expect(dl.headers['content-disposition']).toContain('attachment')
    expect(dl.headers['cache-control']).toContain('no-store')
    expect(await count("SELECT COUNT(*) c FROM audit_log WHERE action = 'view' AND entity = 'upload_files'")).toBe(1)
    expect((await crm('GET', '/api/crm/upload-files/999999')).statusCode).toBe(404)

    // NVizor
    expect((await app.inject({ method: 'GET', url: `/api/nvizor/uploads?phone=${encodeURIComponent(PHONE)}` })).statusCode).toBe(401)
    const nvList = (await nv('GET', `/api/nvizor/uploads?phone=${encodeURIComponent('8 (921) 555-14-88')}`)).json()
    expect(nvList.items).toHaveLength(1)
    expect(nvList.items[0]).toMatchObject({ id: op.id, stage: 'Электрика', open: true })
    expect(nvList.items[0].files).toHaveLength(2)
    expect(nvList.items[0].files[0]).toMatchObject({ kind: 'photo', idx: 0, mime: 'image/jpeg', size: 400, original_name: 'фото.jpg' })
    const file = await nv('GET', `/api/nvizor/uploads/files/${nvList.items[0].files[1].id}`)
    expect(file.statusCode).toBe(200)
    expect(file.rawPayload.length).toBe(900)
    expect((await nv('GET', `/api/nvizor/uploads?phone=${encodeURIComponent('+79990009999')}`)).statusCode).toBe(404)
    // закрытый приём виден как закрытый, а давно закрытый в выдачу не попадает
    await nv('POST', `/api/nvizor/uploads/${op.id}/close`)
    expect((await nv('GET', `/api/nvizor/uploads?phone=${encodeURIComponent(PHONE)}`)).json().items[0].open).toBe(false)
    await app.db.prepare("UPDATE upload_requests SET closed_at = '2020-01-01T00:00:00Z'").run()
    expect((await nv('GET', `/api/nvizor/uploads?phone=${encodeURIComponent(PHONE)}`)).json().items).toEqual([])
  })

  it('число загрузок уходит в мессенджеры через пару минут после первого файла — без персональных данных, один раз', async () => {
    const id = await vizorClient()
    const op = await openUpload(id)
    await photo(op.id, op.token, JPEG(), { idx: 0 })
    await photo(op.id, op.token, JPEG(), { idx: 1 })
    await app.photoSweep()
    expect(await count("SELECT COUNT(*) c FROM outbox WHERE payload LIKE '%Клиент загрузил%'")).toBe(0)
    await app.db.prepare('UPDATE upload_requests SET first_file_at = ?').run(new Date(Date.now() - 3 * 60_000).toISOString())
    await app.photoSweep()
    await app.photoSweep()
    const rows = await all("SELECT payload FROM outbox WHERE payload LIKE '%Клиент загрузил%'")
    expect(rows).toHaveLength(1)
    const text = JSON.parse(rows[0].payload).text
    expect(text).toContain('фото этапа: 2 (видео: 0)')
    expect(text).not.toMatch(/Иван|client@example|79215551488/)
  })
})

describe('отчёты в кабинете', () => {
  it('NVizor публикует PDF → кабинет показывает список → клиент скачивает; чужой/неверный ключ — один и тот же 404', async () => {
    const id = await vizorClient()
    const { token } = await openUpload(id)
    const pdf = PDF(500)
    expect((await publishReport(PHONE, pdf, { headers: { 'x-report-stage': encodeURIComponent('Электрика') } })).statusCode).toBe(201)
    const s = await summary(token)
    expect(s.reports).toEqual([{ id: expect.any(Number), number: 'NV-2026-000006', version: '1', date: '2026-10-20', stage: 'Электрика', size: 500 }])
    const dl = await app.inject({ method: 'POST', url: '/api/client/report', payload: { token, id: s.reports[0].id } })
    expect(dl.statusCode).toBe(200)
    expect(dl.rawPayload.equals(pdf)).toBe(true)
    expect(dl.headers['content-type']).toBe('application/pdf')
    expect(dl.headers['content-disposition']).toContain(`filename*=UTF-8''${encodeURIComponent('Невариум Визор — NV-2026-000006.pdf')}`)
    expect(dl.headers['cache-control']).toContain('no-store')
    expect(dl.headers['x-content-type-options']).toBe('nosniff')
    expect(await count("SELECT COUNT(*) c FROM audit_log WHERE action = 'view' AND entity = 'reports'")).toBe(1)
    // другой клиент не получит чужой отчёт
    const other = await vizorClient({ phone: '+79215550000' })
    const otherToken = (await openUpload(other)).token
    const miss = [{ token: otherToken, id: s.reports[0].id }, { token: 'неверный', id: s.reports[0].id }, { token, id: 999999 }, { token: '', id: 1 }]
    for (const p of miss) {
      const r = await app.inject({ method: 'POST', url: '/api/client/report', payload: p })
      expect(r.statusCode).toBe(404)
      expect(r.json()).toEqual({ error: 'not_found' })
    }
    // сотрудник видит и скачивает
    const staff = (await crm('GET', `/api/crm/contacts/${id}/reports`)).json().items
    expect(staff).toHaveLength(1)
    expect((await crm('GET', `/api/crm/reports/${staff[0].id}`)).rawPayload.equals(pdf)).toBe(true)
  })

  it('проверки приёма: не PDF 415, большой 413, нет заголовков 400, нет клиента 404, без ключа 401; повтор той же версии 204', async () => {
    await vizorClient()
    expect((await publishReport(PHONE, Buffer.from('это не pdf, просто текст в запросе'))).statusCode).toBe(415)
    expect((await publishReport(PHONE, Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(16 * 1024 * 1024 - 100)]))).statusCode).toBe(413)
    expect((await publishReport(PHONE, PDF(), { headers: { 'x-report-number': '' } })).statusCode).toBe(400)
    expect((await publishReport(PHONE, PDF(), { headers: { 'x-published-at': 'не дата' } })).statusCode).toBe(400)
    expect((await publishReport('+79990009999', PDF())).statusCode).toBe(404)
    const noKey = await app.inject({ method: 'POST', url: '/api/nvizor/reports', payload: PDF(), headers: { 'content-type': 'application/pdf' } })
    expect(noKey.statusCode).toBe(401)
    expect((await publishReport(PHONE, PDF())).statusCode).toBe(201)
    expect((await publishReport(PHONE, PDF())).statusCode).toBe(204)
    expect(await count('SELECT COUNT(*) c FROM reports')).toBe(1)
    expect(s3.store.size).toBe(1)
  })

  it('новая версия заменяет показ, старый объект уходит в очередь и удаляется', async () => {
    const id = await vizorClient()
    const { token } = await openUpload(id)
    await publishReport(PHONE, PDF(300), { version: '1' })
    const oldKey = (await one('SELECT storage_key FROM reports')).storage_key
    expect((await publishReport(PHONE, PDF(400), { version: '2' })).statusCode).toBe(201)
    const reports = (await summary(token)).reports
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ version: '2', size: 400 })
    expect(await count('SELECT COUNT(*) c FROM photo_deletions WHERE storage_key = ?', oldKey)).toBe(1)
    await app.photoSweep()
    expect(s3.store.has(oldKey)).toBe(false)
    expect(s3.store.size).toBe(1)
  })

  it('место в «Настройках» считает и файлы этапа, и отчёты', async () => {
    const id = await vizorClient()
    const op = await openUpload(id)
    await photo(op.id, op.token, JPEG(1000), { idx: 0 })
    await publishReport(PHONE, PDF(500))
    const usage = await app.photoUsage()
    expect(usage.bytes).toBe(1500)
    expect(usage.count).toBe(2)
  })
})

describe('письма клиенту (ADR-025)', () => {
  it('тексты — дословно по заданию; адрес в журнале маской', () => {
    const r = composeClientMail('report_ready', { name: 'Иван', link: 'https://nevarium-vizor.ru/#/c/KEY', number: 'NV-2026-000006' })
    expect(r.subject).toBe('Отчёт готов — Невариум Визор')
    expect(r.text).toBe('Здравствуйте, Иван!\n\nОтчёт по вашему объекту готов: NV-2026-000006. Скачать его и посмотреть тариф можно в личном кабинете: https://nevarium-vizor.ru/#/c/KEY.\n\nНевариум Визор\n\n—\nВы получили письмо, потому что оставили заявку на nevarium-vizor.ru. Не хотите получать письма — ответьте на это письмо.\n')
    const u = composeClientMail('upload_request', { name: 'Иван', link: 'L', stage: 'Электрика', until: '2026-10-27', guideUrl: 'https://nevarium-vizor.ru/guide' })
    expect(u.subject).toBe('Пришлите фото этапа — Невариум Визор')
    expect(u.text).toContain('Эксперт ждёт фото этапа «Электрика» до 27.10.2026. Загрузите их с телефона по ссылке: L. Как снимать: https://nevarium-vizor.ru/guide')
    expect(composeClientMail('upload_request', { name: 'Иван', link: 'L', stage: 'Электрика', until: '2026-10-27' }).text).not.toContain('Как снимать')
    expect(maskEmail('client@example.ru')).toBe('c***@e***.ru')
  })

  it('выключено по умолчанию: ни отчёт, ни открытие приёма не ставят письмо в очередь', async () => {
    const id = await vizorClient()
    expect((await crm('GET', '/api/crm/settings')).json().clientMail).toEqual({ enabled: false })
    await openUpload(id)
    await publishReport(PHONE, PDF())
    expect(await count('SELECT COUNT(*) c FROM client_emails')).toBe(0)
    await app.photoSweep()
    expect(mailer.sent).toEqual([])
  })

  it('включено: «отчёт готов» уходит на почту клиента от «Невариум Визор» с ответом на почту проекта; ссылка рабочая; журнал без адреса', async () => {
    await vizorClient()
    expect((await enableClientMail()).statusCode).toBe(200)
    expect((await publishReport(PHONE, PDF())).json().mail).toBe('queued')
    await app.photoSweep()
    expect(mailer.sent).toHaveLength(1)
    const m = mailer.sent[0]
    expect(m).toMatchObject({ to: 'client@example.ru', subject: 'Отчёт готов — Невариум Визор', fromName: 'Невариум Визор', replyTo: 'nvizor-spb@yandex.ru' })
    expect(m.text).toContain('Отчёт по вашему объекту готов: NV-2026-000006.')
    const link = m.text.match(/https:\/\/nevarium-vizor\.ru\/#\/c\/([A-Za-z0-9_-]{43})/)
    expect(link).toBeTruthy()
    const s = await summary(link[1])
    expect(s.client.name).toMatch(/^Иван/)
    expect(s.reports).toHaveLength(1)
    // в письме нет ничего, кроме имени, номера и ссылки: ни телефона, ни фото
    expect(m.text).not.toMatch(/79215551488|\+7/)
    const entry = await one("SELECT detail FROM audit_log WHERE action = 'send'")
    expect(entry.detail).toContain('c***@e***.ru')
    expect(entry.detail).not.toContain('client@example.ru')
    // повторный проход ничего не шлёт
    await app.photoSweep()
    expect(mailer.sent).toHaveLength(1)
    expect((await one('SELECT sent_at FROM client_emails')).sent_at).toBeTruthy()
    // новая версия того же отчёта — письма нет
    await publishReport(PHONE, PDF(300), { version: '2' })
    await app.photoSweep()
    expect(mailer.sent).toHaveLength(1)
  })

  it('«пришлите фото этапа» уходит при открытии приёма; сотруднику всё равно показан текст для копирования', async () => {
    const id = await vizorClient()
    await enableClientMail()
    const op = await openUpload(id)
    expect(op.mail).toBe('queued')
    await app.photoSweep()
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0].subject).toBe('Пришлите фото этапа — Невариум Визор')
    expect(mailer.sent[0].text).toContain('«Электрика»')
    expect(op.message).toContain('Эксперт ждёт фото этапа «Электрика»')
  })

  it('нет согласия / нет адреса / отказ — письма нет, для «отчёт готов» сотруднику создаётся задача (один раз)', async () => {
    await enableClientMail()
    const noConsent = await vizorClient({ consent: false })
    expect((await publishReport(PHONE, PDF())).json().mail).toBe('no_consent')
    const task = await one('SELECT title FROM tasks WHERE contact_id = ?', noConsent)
    expect(task.title).toBe('Сообщить клиенту: отчёт готов (NV-2026-000006)')
    // новая версия того же номера — второй задачи нет
    await publishReport(PHONE, PDF(300), { version: '2' })
    expect(await count('SELECT COUNT(*) c FROM tasks WHERE contact_id = ?', noConsent)).toBe(1)

    const optOut = await vizorClient({ phone: '+79215550001' })
    await crm('PATCH', `/api/crm/contacts/${optOut}`, { email_opt_out: 1 })
    expect((await publishReport('+79215550001', PDF(), { number: 'NV-2026-000007' })).json().mail).toBe('opted_out')
    expect(await count('SELECT COUNT(*) c FROM tasks WHERE contact_id = ?', optOut)).toBe(1)

    await app.db.prepare('UPDATE contacts SET email = ?, email_opt_out = 0 WHERE id = ?').run('', optOut)
    await app.db.prepare("UPDATE deals SET invoice_channel = '', invoice_contact = '' WHERE contact_id = ?").run(optOut)
    expect((await publishReport('+79215550001', PDF(), { number: 'NV-2026-000008' })).json().mail).toBe('no_address')
    expect(await count('SELECT COUNT(*) c FROM client_emails')).toBe(0)
    await app.photoSweep()
    expect(mailer.sent).toEqual([])
  })

  it('условия проверяются заново при отправке: выключили настройку / клиент отказался — письмо не уходит', async () => {
    const id = await vizorClient()
    await enableClientMail()
    await publishReport(PHONE, PDF())
    await crm('PATCH', '/api/crm/settings', { clientMail: { enabled: false } })
    await app.photoSweep()
    expect(mailer.sent).toEqual([])
    await enableClientMail()
    await crm('PATCH', `/api/crm/contacts/${id}`, { email_opt_out: 1 })
    await app.photoSweep()
    expect(mailer.sent).toEqual([])
    expect((await one('SELECT last_error FROM client_emails')).last_error).toBe('пропущено: opted_out')
  })

  it('сбой почты: попытка засчитана, выпущенная ссылка погашена, следующая попытка — новая ссылка и письмо уходит', async () => {
    const id = await vizorClient()
    await enableClientMail()
    await publishReport(PHONE, PDF())
    const linksBefore = await count('SELECT COUNT(*) c FROM client_links WHERE contact_id = ?', id)
    mailer.fail = true
    await app.photoSweep()
    const row = await one('SELECT attempts, last_error, sent_at FROM client_emails')
    expect(row).toMatchObject({ attempts: 1, last_error: 'HTTP_500' })
    expect(row.sent_at).toBeFalsy()
    expect(await count('SELECT COUNT(*) c FROM client_links WHERE contact_id = ?', id)).toBe(linksBefore)
    mailer.fail = false
    await app.photoSweep()
    expect(mailer.sent).toHaveLength(1)
    expect(await count('SELECT COUNT(*) c FROM client_links WHERE contact_id = ?', id)).toBe(linksBefore + 1)
  })

  it('«не писать на почту» правится в карточке и не теряется при слиянии карточек', async () => {
    const a = await vizorClient()
    const projectId = (await one("SELECT id FROM projects WHERE slug = 'nevarium-vizor'")).id
    const manual = (await crm('POST', '/api/crm/contacts', { name: 'Дубль', phone: PHONE, project_id: projectId })).json().item
    await crm('PATCH', `/api/crm/contacts/${manual.id}`, { email_opt_out: 1 })
    expect((await one('SELECT email_opt_out FROM contacts WHERE id = ?', manual.id)).email_opt_out).toBe(1)
    expect((await crm('POST', `/api/crm/contacts/${a}/merge`, { from_id: manual.id })).statusCode).toBe(200)
    expect((await one('SELECT email_opt_out FROM contacts WHERE id = ?', a)).email_opt_out).toBe(1)
  })
})

describe('удаление, обезличивание, слияние, импорт', () => {
  async function filled() {
    const id = await vizorClient()
    const op = await openUpload(id)
    await photo(op.id, op.token, JPEG(), { idx: 0 })
    const fields = (await clientPost(`/api/client/upload/${op.id}/video-url`, op.token, { index: 0, size: 10, type: 'video/mp4' })).json().fields
    s3.store.set(fields.key, { body: MP4(100), mime: 'video/mp4' })
    await clientPost(`/api/client/upload/${op.id}/video-done`, op.token, { index: 0 })
    await publishReport(PHONE, PDF())
    await app.db.prepare("INSERT INTO client_emails (kind, contact_id, params, created_at) VALUES ('report_ready', ?, '{}', ?)").run(id, now())
    return { id, op }
  }
  const empty = async (contactId) => {
    for (const t of ['upload_requests', 'upload_files', 'reports', 'client_emails']) expect(await count(`SELECT COUNT(*) c FROM ${t} WHERE contact_id = ?`, contactId), t).toBe(0)
  }

  it('обезличивание уносит файлы этапа, отчёты и очередь писем; объекты — в очередь удаления и из бакета', async () => {
    const { id } = await filled()
    expect(s3.store.size).toBe(3)
    await crm('POST', `/api/crm/contacts/${id}/anonymize`)
    await empty(id)
    expect(await count('SELECT COUNT(*) c FROM photo_deletions')).toBe(3)
    await app.photoSweep()
    expect(s3.store.size).toBe(0)
  })

  it('удаление контакта — то же самое', async () => {
    const { id } = await filled()
    for (const d of await all('SELECT id FROM deals WHERE contact_id = ?', id)) expect((await crm('DELETE', `/api/crm/deals/${d.id}`)).statusCode).toBe(200)
    expect((await crm('DELETE', `/api/crm/contacts/${id}`)).statusCode).toBe(200)
    await empty(id)
    await app.photoSweep()
    expect(s3.store.size).toBe(0)
  })

  it('слияние переносит приёмы, файлы, отчёты, очередь; одинаковый номер отчёта у обеих — остаётся один', async () => {
    const { id } = await filled()
    const projectId = (await one("SELECT id FROM projects WHERE slug = 'nevarium-vizor'")).id
    const drop = (await crm('POST', '/api/crm/contacts', { name: 'Дубль без телефона', project_id: projectId })).json().item
    await app.db.prepare("INSERT INTO reports (contact_id, number, version, published_at, storage_key, size, created_at) VALUES (?, 'NV-2026-000006', '1', ?, 'r/dup.pdf', 1, ?)").run(drop.id, now(), now())
    await app.db.prepare("INSERT INTO reports (contact_id, number, version, published_at, storage_key, size, created_at) VALUES (?, 'NV-2026-000050', '1', ?, 'r/other.pdf', 1, ?)").run(drop.id, now(), now())
    const res = await crm('POST', `/api/crm/contacts/${id}/merge`, { from_id: drop.id })
    expect(res.statusCode).toBe(200)
    expect(await count('SELECT COUNT(*) c FROM reports WHERE contact_id = ?', id)).toBe(2)
    expect(await count("SELECT COUNT(*) c FROM photo_deletions WHERE storage_key = 'r/dup.pdf'")).toBe(1)
    expect(await count('SELECT COUNT(*) c FROM reports WHERE contact_id = ?', drop.id)).toBe(0)
  })

  it('импорт дампа стирает файлы этапа, отчёты и очередь (id контактов после восстановления другие)', async () => {
    const { id } = await filled()
    const dump = (await crm('GET', '/api/crm/export')).json()
    expect(Object.keys(dump)).not.toContain('reports')
    const imp = await crm('POST', '/api/crm/import', dump)
    expect(imp.statusCode).toBe(200)
    await empty(id)
    await app.photoSweep()
    expect(s3.store.size).toBe(0)
  })
})

describe('хранилище: проверка формы загрузки и правило CORS (npm run test-s3)', () => {
  // Подставное «хранилище по форме»: принимает файл не больше лимита из политики, кладёт его по ключу.
  const formServer = (store, { ignoreLimit = false } = {}) => async (url, init) => {
    const fd = init.body
    const policy = JSON.parse(Buffer.from(fd.get('policy'), 'base64').toString())
    const max = policy.conditions.find((c) => Array.isArray(c) && c[0] === 'content-length-range')[2]
    const file = Buffer.from(await fd.get('file').arrayBuffer())
    if (!ignoreLimit && file.length > max) return { ok: false, status: 400, text: async () => '<Error><Code>EntityTooLarge</Code></Error>' }
    store.set(fd.get('key'), { body: file, mime: fd.get('Content-Type') })
    return { ok: true, status: 204, text: async () => '' }
  }

  it('форма работает и лимит соблюдается — все шаги OK, служебный файл удалён', async () => {
    const steps = await checkS3Presign(s3, formServer(s3.store))
    expect(steps.map((s) => [s.name, s.ok])).toEqual([
      ['загрузка по подписанной форме (так телефон клиента будет загружать видео)', true],
      ['файл на месте и нужного размера', true],
      ['файл больше лимита из подписи отклоняется', true],
      ['удаление', true],
    ])
    expect(s3.store.size).toBe(0)
  })

  it('хранилище не соблюдает лимит — шаг падает с понятным кодом; форму не приняло — дальше не идём', async () => {
    const lax = await checkS3Presign(s3, formServer(s3.store, { ignoreLimit: true }))
    expect(lax.find((s) => !s.ok).err.code).toBe('NO_LIMIT')
    const refused = await checkS3Presign(s3, async () => ({ ok: false, status: 403, text: async () => 'SignatureDoesNotMatch' }))
    expect(refused).toHaveLength(1)
    expect(refused[0].err).toMatchObject({ code: 'POST_REJECTED' })
    expect(refused[0].err.detail).toContain('SignatureDoesNotMatch')
  })

  it('правило CORS: только домены сайта и только POST; запрос подписан вместе с Content-MD5', async () => {
    const xml = corsXml()
    for (const o of DEFAULT_CORS_ORIGINS) expect(xml).toContain(`<AllowedOrigin>${o}</AllowedOrigin>`)
    expect(xml).toContain('<AllowedMethod>POST</AllowedMethod>')
    expect(xml).not.toMatch(/<AllowedMethod>(GET|PUT|DELETE)</)
    const calls = []
    const real = createS3({ S3_ENDPOINT: 'https://s3.example.test', S3_BUCKET: 'bkt', S3_ACCESS_KEY: 'AKIDTEST', S3_SECRET_KEY: 'very-secret-key' }, {
      fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return { ok: true, status: 200, text: async () => xml } },
    })
    await real.putCors(xml)
    expect(calls[0].url).toBe('https://s3.example.test/bkt?cors')
    expect(calls[0].init.method).toBe('PUT')
    expect(calls[0].init.headers['content-md5']).toMatch(/^[A-Za-z0-9+/]{22}==$/)
    expect(calls[0].init.headers.Authorization).toMatch(/SignedHeaders=content-md5;content-type;host;x-amz-content-sha256;x-amz-date/)
    expect(JSON.stringify(calls[0].init.headers)).not.toContain('very-secret-key')
    expect(await real.getCors()).toBe(xml)
  })
})
