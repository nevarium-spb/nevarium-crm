// Фото объекта из формы заявки сайта Визора (задание сайта 2026-10-16, часть Б; ADR-022).
//
// ПДн: фото приходят КАК ЕСТЬ — без сжатия и без удаления EXIF (решение владельца), а в EXIF бывают
// координаты съёмки, то есть адрес объекта. Поэтому: бакет приватный, сырой ссылки на файл нет нигде,
// скачивать могут только вошедшие сотрудники (каждое открытие — в журнал действий), в мессенджеры
// уходит только число. Файл удаляется вместе с заявкой, контактом, при обезличивании и импорте дампа.
//
// Хранилище — S3 Timeweb (Россия): диск App Platform стирается при деплое, поэтому не файлы и не
// база (ADR-022). Запросы подписываются SigV4 без SDK (подпись общая с почтой — mailer.js/signV4).
// Удаление из бакета — через очередь `photo_deletions`, записываемую В ТОЙ ЖЕ транзакции, что и
// удаление строки: строка и объект не расходятся, даже если S3 в этот момент недоступен.
import crypto from 'node:crypto'
import { signV4 } from './mailer.js'

export const PHOTO_MAX_BYTES = 15 * 1024 * 1024
export const PHOTO_BODY_LIMIT = 16 * 1024 * 1024
export const PHOTOS_PER_LEAD = 10
export const ATTACH_WINDOW_MS = 60 * 60_000
const INTAKE_KEEP_MS = 2 * 60 * 60_000
const NOTIFY_AFTER_MS = 2 * 60_000
const DELETE_MAX_ATTEMPTS = 50
export const PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex')
const EMPTY_SHA = sha256hex('')

/**
 * Тип файла по СОДЕРЖИМОМУ, а не по Content-Type (заголовок подделывается): JPEG FF D8 FF, PNG 89 50 4E 47,
 * WebP «RIFF....WEBP», HEIC/HEIF — «ftyp» с брендом heic|heix|hevc|mif1|msf1. Иначе — null (415).
 */
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' }
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { mime: 'image/png', ext: 'png' }
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' }
  if (buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12)
    if (['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(brand)) return { mime: brand === 'mif1' || brand === 'msf1' ? 'image/heif' : 'image/heic', ext: 'heic' }
  }
  return null
}

/** Клиент S3 (path-style, SigV4). Не настроен — configured=false, приём фото честно отвечает 503. */
export function createS3(env = process.env, { fetchImpl = globalThis.fetch, clock = () => new Date() } = {}) {
  const endpoint = String(env.S3_ENDPOINT || '').trim().replace(/\/+$/, '')
  const bucket = String(env.S3_BUCKET || '').trim()
  const region = String(env.S3_REGION || 'ru-1').trim()
  const keyId = String(env.S3_ACCESS_KEY || '').trim()
  const secret = String(env.S3_SECRET_KEY || '').trim()
  const configured = Boolean(endpoint && bucket && keyId && secret)

  async function call(method, key, { body = Buffer.alloc(0), mime } = {}) {
    if (!configured) throw Object.assign(new Error('s3_not_configured'), { code: 'S3_NOT_CONFIGURED' })
    const url = new URL(`${endpoint}/${bucket}/${key}`)
    const amzDate = clock().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
    const payloadHash = body.length ? sha256hex(body) : EMPTY_SHA
    const signed = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate }
    if (mime) signed['content-type'] = mime
    const authorization = signV4({ method, path: url.pathname, headers: signed, body, region, service: 's3', keyId, secret })
    const headers = { 'X-Amz-Content-Sha256': payloadHash, 'X-Amz-Date': amzDate, Authorization: authorization }
    if (mime) headers['Content-Type'] = mime
    let res
    try {
      res = await fetchImpl(url, { method, headers, body: method === 'PUT' ? body : undefined, signal: AbortSignal.timeout(60_000) })
    } catch (err) {
      throw Object.assign(new Error(err?.message || 'network'), { code: err?.name === 'TimeoutError' ? 'ETIMEDOUT' : 'ECONNECTION' })
    }
    return res
  }

  return {
    configured,
    async put(key, body, mime) {
      const res = await call('PUT', key, { body, mime })
      if (!res.ok) throw Object.assign(new Error(`S3 PUT ${res.status}`), { code: `HTTP_${res.status}` })
    },
    async get(key) {
      const res = await call('GET', key)
      if (res.status === 404) return null
      if (!res.ok) throw Object.assign(new Error(`S3 GET ${res.status}`), { code: `HTTP_${res.status}` })
      return Buffer.from(await res.arrayBuffer())
    },
    /** Удаление идемпотентно: объекта уже нет (404) — это успех. */
    async del(key) {
      const res = await call('DELETE', key)
      if (!res.ok && res.status !== 404) throw Object.assign(new Error(`S3 DELETE ${res.status}`), { code: `HTTP_${res.status}` })
    },
  }
}

/**
 * Фото контакта/сделки/всех — строки удаляются, а их объекты уходят в очередь удаления ТОЙ ЖЕ транзакцией
 * (tx — открытая транзакция вызывающего). where: { contactId } | { dealId } | { all: true }.
 */
export async function queuePhotoDeletion(tx, where, nowIso) {
  const [cond, args] = where.all ? ['1 = 1', []] : where.dealId !== undefined ? ['deal_id = ?', [where.dealId]] : ['contact_id = ?', [where.contactId]]
  await tx.prepare(`INSERT INTO photo_deletions (storage_key, created_at) SELECT storage_key, CAST(? AS TEXT) FROM lead_photos WHERE ${cond}`).run(nowIso, ...args)
  await tx.prepare(`DELETE FROM lead_photos WHERE ${cond}`).run(...args)
}

const safeName = (v) => {
  let s = ''
  try { s = decodeURIComponent(String(v || '')) } catch { s = String(v || '') }
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f/\\]/g, '').trim().slice(0, 200)
}

export function registerPhotoRoutes(app, { db, s3, withMutation, audit, now, hardRateLimited, applyCors, corsPreflight, enqueue, limitBytes }) {
  // Тело — сырые байты (НЕ multipart). Парсер ТОЛЬКО для этих типов; другие маршруты и их потолки не затронуты.
  app.addContentTypeParser(PHOTO_MIME_TYPES, { parseAs: 'buffer', bodyLimit: PHOTO_BODY_LIMIT }, (req, body, done) => done(null, body))

  app.options('/api/leads/:requestId/photos', async (req, reply) => corsPreflight(req, reply))

  app.post('/api/leads/:requestId/photos', { bodyLimit: PHOTO_BODY_LIMIT }, async (req, reply) => {
    await applyCors(req, reply)
    if (hardRateLimited('lead_photos', req.ip)) return reply.code(429).send()
    if (!s3.configured) return reply.code(503).send({ error: 'photos_unavailable' })

    const requestId = String(req.params.requestId || '').slice(0, 200)
    const idx = Number(req.headers['x-photo-index'])
    if (!Number.isInteger(idx) || idx < 0) return reply.code(400).send({ error: 'bad_index' })
    // Номера 0..9; десятое и дальше — «уже 10 фото» (контракт задания: 409).
    if (idx >= PHOTOS_PER_LEAD) return reply.code(409).send({ error: 'too_many' })

    // Заявка с таким request_id: нет, не с формы сайта Визора, «подозрительная» или окно истекло — всё одинаково 404.
    const intake = await db.prepare('SELECT contact_id, deal_id, created_at FROM lead_intake WHERE request_id = ?').get(requestId)
    if (!intake || Date.now() - Date.parse(intake.created_at) > ATTACH_WINDOW_MS) return reply.code(404).send()

    const body = req.body
    if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(415).send({ error: 'not_image' })
    if (body.length > PHOTO_MAX_BYTES) return reply.code(413).send({ error: 'too_large' })
    const kind = sniffImage(body)
    if (!kind) return reply.code(415).send({ error: 'not_image' })

    // Повтор с тем же номером — 204 без второй копии (ключ идемпотентности — {request_id}:{index}).
    if (await db.prepare('SELECT 1 FROM lead_photos WHERE request_id = ? AND idx = ?').get(requestId, idx)) return reply.code(204).send()
    const have = Number((await db.prepare('SELECT COUNT(*) c FROM lead_photos WHERE request_id = ?').get(requestId)).c)
    if (have >= PHOTOS_PER_LEAD) return reply.code(409).send({ error: 'too_many' })

    const key = `${crypto.randomBytes(24).toString('hex')}.${kind.ext}`
    try {
      await s3.put(key, body, kind.mime)
    } catch (err) {
      // Хранилище недоступно или полно — заявка уже сохранена, фото просто не прикрепилось; сайт повторит.
      req.log?.warn?.({ code: err?.code }, 'photos: не удалось записать в хранилище')
      return reply.code(503).send({ error: 'storage_unavailable' })
    }
    const ts = now()
    const inserted = await withMutation(async (tx) => {
      const r = await tx.prepare('INSERT INTO lead_photos (contact_id, deal_id, request_id, idx, storage_key, mime, size, sha256, original_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (request_id, idx) DO NOTHING')
        .run(intake.contact_id, intake.deal_id, requestId, idx, key, kind.mime, body.length, sha256hex(body), safeName(req.headers['x-file-name']), ts)
      if (!r.changes) {
        // Параллельный повтор успел раньше: наш объект лишний — в очередь удаления.
        await tx.prepare('INSERT INTO photo_deletions (storage_key, created_at) VALUES (?, ?)').run(key, ts)
        return false
      }
      await tx.prepare('UPDATE lead_intake SET first_photo_at = COALESCE(first_photo_at, ?) WHERE request_id = ?').run(ts, requestId)
      return true
    })
    req.log?.info?.({ contactId: intake.contact_id, idx, size: body.length, inserted }, 'lead photo accepted')
    return reply.code(204).send()
  })

  // ---------- просмотр (только вошедшие сотрудники: хук /api/crm/*) ----------
  app.get('/api/crm/contacts/:id/photos', async (req, reply) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id' })
    const items = await db.prepare('SELECT id, deal_id, idx, mime, size, original_name, created_at FROM lead_photos WHERE contact_id = ? ORDER BY deal_id, idx').all(id)
    return { items }
  })

  app.get('/api/crm/photos/:id', async (req, reply) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id' })
    const row = await db.prepare('SELECT id, contact_id, storage_key, mime, original_name FROM lead_photos WHERE id = ?').get(id)
    if (!row) return reply.code(404).send({ error: 'not_found' })
    let buf
    try { buf = await s3.get(row.storage_key) } catch (err) {
      req.log?.warn?.({ code: err?.code }, 'photos: не удалось прочитать из хранилища')
      return reply.code(503).send({ error: 'storage_unavailable' })
    }
    if (!buf) return reply.code(404).send({ error: 'not_found' })
    await audit(req, 'view', 'lead_photos', id, `открыто фото заявки (контакт #${row.contact_id})`)
    const ext = row.mime === 'image/png' ? 'png' : row.mime === 'image/webp' ? 'webp' : row.mime.startsWith('image/hei') ? 'heic' : 'jpg'
    const name = row.original_name || `photo-${id}.${ext}`
    return reply
      .header('Content-Type', row.mime)
      .header('Content-Disposition', `attachment; filename="photo-${id}.${ext}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, no-store')
      .send(buf)
  })

  /** Занятое место — для «Настроек» (без запросов к S3: считаем по таблице). */
  app.decorate('photoUsage', async () => {
    const r = await db.prepare('SELECT COUNT(*) c, COALESCE(SUM(size), 0) bytes FROM lead_photos').get()
    return { count: Number(r.c), bytes: Number(r.bytes), limitBytes: limitBytes ?? null, configured: s3.configured }
  })

  // ---------- фон: раз в минуту ----------
  /** Один проход: просроченные записи приёма, число фото в мессенджеры, очередь удаления объектов. */
  async function sweep() {
    const ts = Date.now()
    await db.prepare('DELETE FROM lead_intake WHERE created_at < ?').run(new Date(ts - INTAKE_KEEP_MS).toISOString())

    // «📷 5 фото» — одно уведомление на заявку, через пару минут после первого фото (чтобы посчитать все).
    const due = await db.prepare('SELECT request_id, contact_id FROM lead_intake WHERE photos_notified = 0 AND first_photo_at IS NOT NULL AND first_photo_at < ?')
      .all(new Date(ts - NOTIFY_AFTER_MS).toISOString())
    for (const row of due) {
      const n = Number((await db.prepare('SELECT COUNT(*) c FROM lead_photos WHERE request_id = ?').get(row.request_id)).c)
      await withMutation(async (tx) => {
        await tx.prepare('UPDATE lead_intake SET photos_notified = 1 WHERE request_id = ?').run(row.request_id)
        if (n > 0) await enqueue(tx, 'text', { text: `📷 К заявке прикреплено фото: ${n}. Открыть — в карточке контакта в CRM.` })
      })
    }

    if (!s3.configured) return
    const queue = await db.prepare('SELECT id, storage_key, attempts FROM photo_deletions WHERE attempts < ? ORDER BY id LIMIT 20').all(DELETE_MAX_ATTEMPTS)
    for (const row of queue) {
      try {
        await s3.del(row.storage_key)
        await db.prepare('DELETE FROM photo_deletions WHERE id = ?').run(row.id)
      } catch (err) {
        await db.prepare('UPDATE photo_deletions SET attempts = attempts + 1, last_error = ? WHERE id = ?').run(String(err?.code || err?.message || '').slice(0, 100), row.id)
      }
    }
  }
  app.decorate('photoSweep', sweep)
}

/** Запуск фонового прохода (прод). В тестах не запускается — они зовут app.photoSweep() сами. */
export function schedulePhotoHousekeeping(app, { log } = {}) {
  const tick = () => app.photoSweep().catch((err) => log?.warn?.(`photos: фоновый проход не удался: ${err}`))
  const timer = setInterval(tick, 60_000)
  timer.unref?.()
  return timer
}
