// Загрузка фото и видео этапа по личной ссылке клиента, PDF-отчёты в кабинете (ADR-025; задание сайта 2026-10-20, части 1, 2, 4).
//
// ПДн: фото — КАК ЕСТЬ, с EXIF (в нём координаты съёмки, то есть адрес объекта), видео и PDF-отчёт — тоже данные клиента. Бакет
// приватный, прямых ссылок на файл нет нигде: сотруднику и NVizor файл отдаёт сервер после входа / по ключу приложения, клиенту —
// только его собственный отчёт по его личной ссылке. Каждое открытие — в журнал. Всё удаляется вместе с контактом (queuePhotoDeletion).
// В мессенджеры — только числа.
//
// Личная ссылка клиента — та же `client_links` (ADR-019). Для загрузки ключ идёт заголовком X-Client-Key (не в адресе: адрес
// попадает в журналы), для кабинета и скачивания отчёта — телом запроса, как у /api/client/summary.
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { FORM_GRACE_MS, PHOTO_BODY_LIMIT, PHOTO_MAX_BYTES, sniffImage } from './photos.js'
import { addDays, contactsByPhone, hashToken, linkExpiryFor, mskDateOf, newToken } from './entitlements.js'
import { enqueueClientMail } from './client-mail.js'
import { LIMITS, STAGES } from './shared/plans.js'

export const UPLOAD_DAYS = 7 // приём открыт 7 дней, последний день включительно (МСК)
export const VIDEO_MAX_BYTES = 300 * 1024 * 1024
export const VIDEO_TYPES = { 'video/mp4': 'mp4', 'video/quicktime': 'mov' }
export const REPORT_MAX_BYTES = 15 * 1024 * 1024
const NOTIFY_AFTER_MS = 2 * 60_000
const PENDING_VIDEO_KEEP_MS = 2 * 60 * 60_000
const RECENT_DAYS = 14
const KIND_LIMITS = {
  primary: { photos: LIMITS.photos, videos: LIMITS.videos },
  recheck: { photos: LIMITS.recheckPhotos, videos: 0 },
}

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex')
const ruDate = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`
const safeName = (v) => {
  let s = ''
  try { s = decodeURIComponent(String(v || '')) } catch { s = String(v || '') }
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f/\\]/g, '').trim().slice(0, 200)
}
const stageTitleOf = (code) => {
  for (const list of Object.values(STAGES)) {
    const hit = list.find(([c]) => c === code)
    // В общем файле цен названия этапов строчные («электрика»); в кабинете и письмах — с заглавной, как в задании сайта.
    if (hit) return hit[1].charAt(0).toUpperCase() + hit[1].slice(1)
  }
  return ''
}
const contentDisposition = (ascii, utf8) => `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(utf8)}`

/**
 * @param deps.corsPreflight — (разрешённые заголовки) => обработчик OPTIONS (домены сайта, метод POST)
 * @param deps.projectId — async () => id проекта nevarium-vizor
 */
export function createUploads({ db, s3, withMutation, audit, now, mskToday, hardRateLimited, applyCors, corsPreflight, enqueue, cabinetBaseUrl, projectId }) {
  const systemReq = (who) => ({ user: { id: null, email: who } })

  // ---------- общее ----------

  /** Личная ссылка по ключу → { contact_id } либо null. Неверный, отозванный, истёкший и обезличенный — одно и то же. */
  async function clientAuth(tokenRaw, runner = db) {
    const token = typeof tokenRaw === 'string' ? tokenRaw.trim() : ''
    if (!token || token.length > 200) return null
    return (await runner.prepare(`SELECT l.id link_id, l.contact_id FROM client_links l JOIN contacts c ON c.id = l.contact_id
      WHERE l.token_hash = ? AND l.revoked_at IS NULL AND (l.expires_on IS NULL OR l.expires_on >= ?) AND c.anonymized_at IS NULL`).get(hashToken(token), mskToday())) || null
  }

  /** Открытый приём этого клиента по id: не закрыт, срок не вышел, приём его (иначе — как будто его нет). */
  async function openUploadOf(contactId, uploadId, runner = db) {
    return (await runner.prepare('SELECT * FROM upload_requests WHERE id = ? AND contact_id = ? AND closed_at IS NULL AND expires_on >= ? AND opens_on <= ?')
      .get(uploadId, contactId, mskToday(), mskToday())) || null
  }

  /**
   * Следующий свободный номер фото и видео (предложение сайта 2026-10-23): сайт сам считал номер как used + порядковый, и после
   * неудачной загрузки и повторного открытия кабинета номер совпадал с занятым — CRM отвечала 204 (повтор) и новый файл не сохраняла.
   * Занятым считается номер с принятым файлом; у видео незавершённая форма (pending) номер не занимает — её заменит новая. null — всё занято.
   */
  async function nextIndexes(up, runner = db) {
    const rows = await runner.prepare('SELECT kind, idx, state FROM upload_files WHERE upload_id = ?').all(up.id)
    const busy = (kind) => new Set(rows.filter((r) => r.kind === kind && (kind === 'photo' || r.state === 'ready')).map((r) => Number(r.idx)))
    const first = (limit, taken) => { for (let i = 0; i < limit; i++) if (!taken.has(i)) return i; return null }
    return { photo: first(up.photos_limit, busy('photo')), video: first(up.videos_limit, busy('video')) }
  }

  async function usageOf(uploadId, runner = db) {
    const rows = await runner.prepare("SELECT kind, COUNT(*) c FROM upload_files WHERE upload_id = ? AND state = 'ready' GROUP BY kind").all(uploadId)
    const by = Object.fromEntries(rows.map((r) => [r.kind, Number(r.c)]))
    return { photos: by.photo || 0, videos: by.video || 0 }
  }

  /** Что видит кабинет сайта: `upload` (последний открытый приём или null) и `reports` (новые сверху). Идёт в /api/client/summary. */
  async function summaryExtras(runner, contactId, today) {
    const up = await runner.prepare('SELECT * FROM upload_requests WHERE contact_id = ? AND closed_at IS NULL AND expires_on >= ? AND opens_on <= ? ORDER BY id DESC LIMIT 1').get(contactId, today, today)
    let upload = null
    if (up) {
      const used = await usageOf(up.id, runner)
      const next = await nextIndexes(up, runner)
      upload = {
        id: up.id, stage: up.stage_title, kind: up.kind,
        photos: { limit: up.photos_limit, used: used.photos, nextIndex: next.photo },
        videos: { limit: up.videos_limit, used: used.videos, nextIndex: next.video },
        expiresOn: up.expires_on,
      }
    }
    const rows = await runner.prepare('SELECT id, number, version, stage, published_at, size FROM reports WHERE contact_id = ? ORDER BY published_at DESC, id DESC LIMIT 200').all(contactId)
    const reports = rows.map((r) => ({ id: r.id, number: r.number, version: r.version, date: mskDateOf(r.published_at), stage: r.stage, size: Number(r.size) }))
    return { upload, reports }
  }

  /** Личная ссылка в кабинет: новая на каждый вызов (ключ не хранится). Срок — по тому же правилу, что у остальных выдач. */
  async function issueLink(tx, contactId) {
    const token = newToken()
    const expiresOn = await linkExpiryFor(tx, [contactId], mskToday())
    await tx.prepare('INSERT INTO client_links (contact_id, token_hash, created_at, expires_on) VALUES (?, ?, ?, ?)').run(contactId, hashToken(token), now(), expiresOn)
    return `${cabinetBaseUrl}/#/c/${token}`
  }

  async function sendStream(reply, key, { mime, disposition, size }) {
    let got
    try { got = await s3.stream(key) } catch (err) {
      reply.log?.warn?.({ code: err?.code }, 'uploads: не удалось прочитать из хранилища')
      return reply.code(503).send({ error: 'storage_unavailable' })
    }
    if (!got) return reply.code(404).send({ error: 'not_found' })
    reply.header('Content-Type', mime).header('Content-Disposition', disposition).header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, no-store')
    const length = got.size || size
    if (length) reply.header('Content-Length', length)
    return reply.send(Readable.fromWeb(got.body))
  }

  // later — ключ, на который ещё может действовать выданная клиенту форма загрузки: удалить только после её истечения, иначе по живой
  // форме объект зальют заново, и он останется в бакете без строки и без очереди (проверка безопасности 2026-10-22).
  async function queueKey(runner, key, { later = false } = {}) {
    const notBefore = later ? new Date(Date.now() + FORM_GRACE_MS).toISOString() : null
    await runner.prepare('INSERT INTO photo_deletions (storage_key, created_at, not_before) VALUES (?, ?, ?)').run(key, now(), notBefore)
  }

  /** Приём ещё открыт? Под блокировкой строки — против удаления контакта/закрытия приёма в этот же момент. */
  async function stillOpen(tx, uploadId) {
    return Boolean(await tx.prepare('SELECT 1 FROM upload_requests WHERE id = ? AND closed_at IS NULL AND expires_on >= ? FOR UPDATE').get(uploadId, mskToday()))
  }

  // ---------- маршруты ----------

  function register(app) {
    // PDF приходит сырыми байтами от NVizor (хук /api/nvizor/ проверяет ключ приложения по адресу).
    app.addContentTypeParser('application/pdf', { parseAs: 'buffer', bodyLimit: PHOTO_BODY_LIMIT }, (req, body, done) => done(null, body))

    // ===== Клиент по личной ссылке =====
    const preflightUpload = corsPreflight('content-type, x-client-key, x-photo-index, x-file-name, idempotency-key')
    const preflightJson = corsPreflight('content-type, x-client-key')
    app.options('/api/client/upload/:id/photos', preflightUpload)
    app.options('/api/client/upload/:id/video-url', preflightJson)
    app.options('/api/client/upload/:id/video-done', preflightJson)
    app.options('/api/client/report', corsPreflight('content-type'))

    /** Общая шапка клиентских маршрутов загрузки: CORS, лимит по IP, ключ, приём. Возвращает { up } либо null (ответ уже отправлен). */
    async function clientUploadGate(req, reply) {
      await applyCors(req, reply)
      if (hardRateLimited('client_upload', req.ip)) { reply.code(429).send(); return null }
      if (!s3.configured) { reply.code(503).send({ error: 'photos_unavailable' }); return null }
      const auth = await clientAuth(req.headers['x-client-key'])
      const id = Number(req.params.id)
      const up = auth && Number.isInteger(id) ? await openUploadOf(auth.contact_id, id) : null
      if (!up) { reply.code(404).send(); return null }
      return { up }
    }

    app.post('/api/client/upload/:id/photos', { bodyLimit: PHOTO_BODY_LIMIT }, async (req, reply) => {
      const gate = await clientUploadGate(req, reply)
      if (!gate) return reply
      const { up } = gate
      const idx = Number(req.headers['x-photo-index'])
      if (!Number.isInteger(idx) || idx < 0) return reply.code(400).send({ error: 'bad_index' })
      if (idx >= up.photos_limit) return reply.code(409).send({ error: 'too_many' })
      const body = req.body
      if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(415).send({ error: 'not_image' })
      if (body.length > PHOTO_MAX_BYTES) return reply.code(413).send({ error: 'too_large' })
      const kind = sniffImage(body)
      if (!kind) return reply.code(415).send({ error: 'not_image' })
      // Повтор того же номера — 204 без второй копии (идемпотентность {upload_id}:{index}).
      if (await db.prepare("SELECT 1 FROM upload_files WHERE upload_id = ? AND kind = 'photo' AND idx = ?").get(up.id, idx)) return reply.code(204).send()
      if ((await usageOf(up.id)).photos >= up.photos_limit) return reply.code(409).send({ error: 'too_many' })

      const key = `u/${crypto.randomBytes(24).toString('hex')}.${kind.ext}`
      try { await s3.put(key, body, kind.mime) } catch (err) {
        req.log?.warn?.({ code: err?.code }, 'uploads: не удалось записать фото в хранилище')
        return reply.code(503).send({ error: 'storage_unavailable' })
      }
      const ts = now()
      const gone = await withMutation(async (tx) => {
        // Пока файл летел в хранилище, контакт могли удалить/обезличить или приём закрыть — тогда строку не пишем.
        if (!(await stillOpen(tx, up.id))) { await queueKey(tx, key); return true }
        const r = await tx.prepare(`INSERT INTO upload_files (upload_id, contact_id, kind, idx, state, storage_key, mime, size, sha256, original_name, created_at)
          VALUES (?, ?, 'photo', ?, 'ready', ?, ?, ?, ?, ?, ?) ON CONFLICT (upload_id, kind, idx) DO NOTHING`)
          .run(up.id, up.contact_id, idx, key, kind.mime, body.length, sha256hex(body), safeName(req.headers['x-file-name']), ts)
        if (!r.changes) { await queueKey(tx, key); return false }
        await tx.prepare('UPDATE upload_requests SET first_file_at = COALESCE(first_file_at, ?) WHERE id = ?').run(ts, up.id)
        return false
      })
      if (gone) return reply.code(404).send()
      req.log?.info?.({ contactId: up.contact_id, upload: up.id, idx, size: body.length }, 'stage photo accepted')
      return reply.code(204).send()
    })

    app.post('/api/client/upload/:id/video-url', { bodyLimit: 4096 }, async (req, reply) => {
      const gate = await clientUploadGate(req, reply)
      if (!gate) return reply
      const { up } = gate
      const b = req.body || {}
      const index = Number(b.index)
      const size = Number(b.size)
      if (!Number.isInteger(index) || index < 0 || !Number.isInteger(size) || size < 1) return reply.code(400).send({ error: 'bad_input' })
      if (index >= up.videos_limit) return reply.code(409).send({ error: 'too_many' })
      if (size > VIDEO_MAX_BYTES) return reply.code(413).send({ error: 'too_large' })
      const ext = VIDEO_TYPES[String(b.type)]
      if (!ext) return reply.code(415).send({ error: 'not_video' })
      const key = `v/${crypto.randomBytes(24).toString('hex')}.${ext}`
      let form
      try { form = s3.presignPost({ key, mime: String(b.type), maxBytes: VIDEO_MAX_BYTES, expiresSec: 1800 }) } catch {
        return reply.code(503).send({ error: 'photos_unavailable' })
      }
      const taken = await withMutation(async (tx) => {
        if (!(await stillOpen(tx, up.id))) return 'gone'
        const prev = await tx.prepare("SELECT id, state, storage_key FROM upload_files WHERE upload_id = ? AND kind = 'video' AND idx = ? FOR UPDATE").get(up.id, index)
        if (prev?.state === 'ready') return true
        // Прежняя форма ещё может действовать — её ключ удаляем с задержкой.
        if (prev) { await queueKey(tx, prev.storage_key, { later: true }); await tx.prepare('DELETE FROM upload_files WHERE id = ?').run(prev.id) }
        await tx.prepare("INSERT INTO upload_files (upload_id, contact_id, kind, idx, state, storage_key, mime, size, created_at) VALUES (?, ?, 'video', ?, 'pending', ?, ?, ?, ?)")
          .run(up.id, up.contact_id, index, key, String(b.type), size, now())
        return false
      })
      if (taken === 'gone') return reply.code(404).send()
      if (taken) return reply.code(409).send({ error: 'exists' })
      return { url: form.url, fields: form.fields, expiresIn: 1800 }
    })

    app.post('/api/client/upload/:id/video-done', { bodyLimit: 4096 }, async (req, reply) => {
      const gate = await clientUploadGate(req, reply)
      if (!gate) return reply
      const { up } = gate
      const index = Number(req.body?.index)
      if (!Number.isInteger(index) || index < 0) return reply.code(400).send({ error: 'bad_input' })
      const row = await db.prepare("SELECT id, state, storage_key FROM upload_files WHERE upload_id = ? AND kind = 'video' AND idx = ?").get(up.id, index)
      if (!row) return reply.code(404).send()
      if (row.state === 'ready') return reply.code(204).send()
      let head
      let first
      try {
        head = await s3.head(row.storage_key)
        first = head && head.size > 0 ? await s3.getRange(row.storage_key, 0, 31) : null
      } catch (err) {
        req.log?.warn?.({ code: err?.code }, 'uploads: не удалось проверить видео в хранилище')
        return reply.code(503).send({ error: 'storage_unavailable' })
      }
      // Объекта нет (клиент не загрузил) — 404; строка остаётся, чистка фоном через пару часов, повторный video-url её заменит.
      if (!head || head.size < 1) return reply.code(404).send()
      const sane = head.size <= VIDEO_MAX_BYTES && first && first.toString('latin1', 4, 8) === 'ftyp'
      if (!sane) {
        // Не видео или больше лимита — строку убираем, объект в очередь удаления С ЗАДЕРЖКОЙ: форма ещё может действовать.
        await withMutation(async (tx) => { await queueKey(tx, row.storage_key, { later: true }); await tx.prepare('DELETE FROM upload_files WHERE id = ?').run(row.id) })
        return reply.code(415).send({ error: 'not_video' })
      }
      const ts = now()
      const accepted = await withMutation(async (tx) => {
        if (!(await stillOpen(tx, up.id))) return false
        // Строку могли убрать параллельно (повторный video-url, удаление контакта) — подтверждаем только существующую.
        const r = await tx.prepare("UPDATE upload_files SET state = 'ready', size = ? WHERE id = ? AND state = 'pending'").run(head.size, row.id)
        if (!r.changes) return false
        await tx.prepare('UPDATE upload_requests SET first_file_at = COALESCE(first_file_at, ?) WHERE id = ?').run(ts, up.id)
        return true
      })
      return reply.code(accepted ? 204 : 404).send()
    })

    // Скачивание отчёта из кабинета: ключ — в теле (как у /api/client/summary); любая ошибка — один и тот же 404.
    app.post('/api/client/report', { bodyLimit: 4096 }, async (req, reply) => {
      await applyCors(req, reply)
      if (hardRateLimited('client_upload', req.ip)) return reply.code(429).send()
      const auth = await clientAuth(req.body?.token)
      const id = Number(req.body?.id)
      const row = auth && Number.isInteger(id)
        ? await db.prepare('SELECT id, contact_id, number, storage_key, size FROM reports WHERE id = ? AND contact_id = ?').get(id, auth.contact_id)
        : null
      if (!row) return reply.code(404).send({ error: 'not_found' })
      if (!s3.configured) return reply.code(503).send({ error: 'storage_unavailable' })
      await audit(systemReq('клиент'), 'view', 'reports', row.id, `скачан клиентом отчёт ${row.number} (контакт #${row.contact_id})`)
      const safeNumber = String(row.number).replace(/[^\w.-]+/g, '_')
      return sendStream(reply, row.storage_key, {
        mime: 'application/pdf', size: row.size,
        disposition: contentDisposition(`Nevarium-Vizor-${safeNumber}.pdf`, `Невариум Визор — ${row.number}.pdf`),
      })
    })

    // ===== Сотрудник в CRM (вход и проверка источника — общий хук /api/crm/) =====
    const fileView = (f) => ({ id: f.id, kind: f.kind, idx: f.idx, mime: f.mime, size: Number(f.size), original_name: f.original_name || '', created_at: f.created_at })

    app.get('/api/crm/contacts/:id/uploads', async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id' })
      const today = mskToday()
      const rows = await db.prepare('SELECT * FROM upload_requests WHERE contact_id = ? ORDER BY id DESC LIMIT 20').all(id)
      const items = []
      for (const u of rows) {
        const files = await db.prepare("SELECT id, kind, idx, mime, size, original_name, created_at FROM upload_files WHERE upload_id = ? AND state = 'ready' ORDER BY kind, idx").all(u.id)
        items.push({
          id: u.id, stage: u.stage_title, stageCode: u.stage_code, kind: u.kind,
          photos: { limit: u.photos_limit, used: files.filter((f) => f.kind === 'photo').length },
          videos: { limit: u.videos_limit, used: files.filter((f) => f.kind === 'video').length },
          opensOn: u.opens_on, expiresOn: u.expires_on, closedAt: u.closed_at,
          open: !u.closed_at && u.expires_on >= today,
          files: files.map(fileView),
        })
      }
      return { items, days: UPLOAD_DAYS, limits: KIND_LIMITS }
    })

    // Открыть приём: этап (из этапов тарифа или свободной строкой) и вид. Выпускает новую личную ссылку и готовый текст сообщения.
    app.post('/api/crm/contacts/:id/uploads', { bodyLimit: 4096 }, async (req, reply) => {
      const contactId = Number(req.params.id)
      if (!Number.isInteger(contactId)) return reply.code(400).send({ error: 'bad_id' })
      const b = req.body || {}
      const kind = b.kind === undefined ? 'primary' : String(b.kind)
      if (!KIND_LIMITS[kind]) return reply.code(400).send({ error: 'bad_input' })
      const stageCode = String(b.stage_code || '').trim().slice(0, 60)
      let stageTitle = String(b.stage_title || '').trim().slice(0, 100)
      if (stageCode) {
        stageTitle = stageTitleOf(stageCode)
        if (!stageTitle) return reply.code(400).send({ error: 'bad_stage' })
      }
      if (!stageTitle) return reply.code(400).send({ error: 'bad_stage' })
      const today = mskToday()
      let result = null
      await withMutation(async (tx) => {
        const c = await tx.prepare('SELECT id, name, anonymized_at FROM contacts WHERE id = ? FOR UPDATE').get(contactId)
        if (!c) { result = [404, { error: 'not_found' }]; return }
        if (c.anonymized_at) { result = [409, { error: 'anonymized' }]; return }
        const open = await tx.prepare('SELECT id, stage_code, stage_title FROM upload_requests WHERE contact_id = ? AND closed_at IS NULL AND expires_on >= ?').all(contactId, today)
        const dup = open.find((u) => (stageCode && u.stage_code === stageCode) || String(u.stage_title).toLowerCase() === stageTitle.toLowerCase())
        if (dup) { result = [409, { error: 'already_open', id: dup.id }]; return }
        let dealId = Number(b.deal_id)
        dealId = Number.isInteger(dealId) && (await tx.prepare('SELECT 1 FROM deals WHERE id = ? AND contact_id = ?').get(dealId, contactId)) ? dealId : null
        const limits = KIND_LIMITS[kind]
        const expiresOn = addDays(today, UPLOAD_DAYS - 1)
        const info = await tx.prepare(`INSERT INTO upload_requests (contact_id, deal_id, stage_code, stage_title, kind, photos_limit, videos_limit, opens_on, expires_on, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
          .run(contactId, dealId, stageCode, stageTitle, kind, limits.photos, limits.videos, today, expiresOn, req.user?.id ?? null, now())
        const url = await issueLink(tx, contactId)
        await audit(req, 'create', 'upload_requests', info.lastInsertRowid, `открыт приём фото этапа «${stageTitle}» (${kind}) до ${expiresOn}: контакт #${contactId}`, tx)
        const mail = await enqueueClientMail(tx, { kind: 'upload_request', contactId, params: { stage: stageTitle, until: expiresOn }, now, today })
        result = [200, {
          ok: true, id: info.lastInsertRowid, url, expiresOn, mail,
          message: `Здравствуйте, ${c.name}! Эксперт ждёт фото этапа «${stageTitle}» до ${ruDate(expiresOn)}. Загрузите их с телефона по ссылке: ${url}`,
        }]
      })
      return reply.code(result[0]).send(result[1])
    })

    app.post('/api/crm/uploads/:id/close', async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id' })
      const done = await withMutation(async (tx) => {
        const u = await tx.prepare('SELECT id, contact_id, closed_at FROM upload_requests WHERE id = ? FOR UPDATE').get(id)
        if (!u) return false
        if (!u.closed_at) {
          await tx.prepare('UPDATE upload_requests SET closed_at = ? WHERE id = ?').run(now(), id)
          await audit(req, 'update', 'upload_requests', id, `приём закрыт («Принято»): контакт #${u.contact_id}`, tx)
        }
        return true
      })
      return done ? { ok: true } : reply.code(404).send({ error: 'not_found' })
    })

    app.get('/api/crm/upload-files/:id', async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id' })
      const f = await db.prepare("SELECT id, contact_id, storage_key, mime, size, original_name FROM upload_files WHERE id = ? AND state = 'ready'").get(id)
      if (!f) return reply.code(404).send({ error: 'not_found' })
      await audit(req, 'view', 'upload_files', id, `открыт файл этапа (контакт #${f.contact_id})`)
      const ext = f.mime.startsWith('video/') ? (f.mime === 'video/quicktime' ? 'mov' : 'mp4') : f.mime === 'image/png' ? 'png' : f.mime === 'image/webp' ? 'webp' : f.mime.startsWith('image/hei') ? 'heic' : 'jpg'
      return sendStream(reply, f.storage_key, { mime: f.mime, size: f.size, disposition: contentDisposition(`file-${id}.${ext}`, f.original_name || `file-${id}.${ext}`) })
    })

    app.get('/api/crm/contacts/:id/reports', async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id' })
      const rows = await db.prepare('SELECT id, number, version, stage, published_at, size FROM reports WHERE contact_id = ? ORDER BY published_at DESC, id DESC').all(id)
      return { items: rows.map((r) => ({ id: r.id, number: r.number, version: r.version, stage: r.stage, publishedAt: r.published_at, size: Number(r.size) })) }
    })

    app.get('/api/crm/reports/:id', async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id' })
      const r = await db.prepare('SELECT id, contact_id, number, storage_key, size FROM reports WHERE id = ?').get(id)
      if (!r) return reply.code(404).send({ error: 'not_found' })
      await audit(req, 'view', 'reports', id, `открыт отчёт ${r.number} (контакт #${r.contact_id})`)
      const safeNumber = String(r.number).replace(/[^\w.-]+/g, '_')
      return sendStream(reply, r.storage_key, { mime: 'application/pdf', size: r.size, disposition: contentDisposition(`Nevarium-Vizor-${safeNumber}.pdf`, `Невариум Визор — ${r.number}.pdf`) })
    })

    // ===== NVizor (ключ приложения проверяет хук nvizor.js по адресу /api/nvizor/) =====
    const nvReq = systemReq('NVizor')

    // Открытые и недавно закрытые (или истёкшие за последние 14 дней) приёмы клиента с файлами.
    // Телефон — ТОЛЬКО заголовком X-Client-Phone (как у публикации отчёта): адрес запроса целиком пишется в журнал приложения, а
    // телефон клиента — персональные данные (проверка безопасности 2026-10-22). Телефон в адресе — отказ, чтобы так не делали.
    app.get('/api/nvizor/uploads', async (req, reply) => {
      if (req.query?.phone !== undefined) return reply.code(400).send({ error: 'phone_in_url', hint: 'передайте телефон заголовком X-Client-Phone' })
      const phone = String(req.headers['x-client-phone'] || '').slice(0, 40)
      const contacts = await contactsByPhone(db, phone, await projectId())
      if (!phone || !contacts.length) return reply.code(404).send({ error: 'client_not_found' })
      const today = mskToday()
      const since = addDays(today, -RECENT_DAYS)
      const marks = contacts.map(() => '?').join(',')
      const rows = await db.prepare(`SELECT * FROM upload_requests WHERE contact_id IN (${marks}) ORDER BY id DESC LIMIT 100`).all(...contacts.map((c) => c.id))
      const items = []
      for (const u of rows) {
        const open = !u.closed_at && u.expires_on >= today
        const ended = u.closed_at ? mskDateOf(u.closed_at) : u.expires_on
        if (!open && ended < since) continue
        const files = await db.prepare("SELECT id, kind, idx, mime, size, original_name, created_at FROM upload_files WHERE upload_id = ? AND state = 'ready' ORDER BY kind, idx").all(u.id)
        items.push({
          id: u.id, stage: u.stage_title, stageCode: u.stage_code, kind: u.kind, open,
          openedOn: u.opens_on, expiresOn: u.expires_on, closedAt: u.closed_at,
          files: files.map(fileView),
        })
      }
      return { items }
    })

    app.get('/api/nvizor/uploads/files/:id', async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id' })
      const f = await db.prepare("SELECT id, contact_id, storage_key, mime, size, original_name FROM upload_files WHERE id = ? AND state = 'ready'").get(id)
      if (!f) return reply.code(404).send({ error: 'not_found' })
      await audit(nvReq, 'view', 'upload_files', id, `файл этапа выдан приложению NVizor (контакт #${f.contact_id})`)
      return sendStream(reply, f.storage_key, { mime: f.mime, size: f.size, disposition: contentDisposition(`file-${id}`, f.original_name || `file-${id}`) })
    })

    app.post('/api/nvizor/uploads/:id/close', async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id' })
      const done = await withMutation(async (tx) => {
        const u = await tx.prepare('SELECT id, contact_id, closed_at FROM upload_requests WHERE id = ? FOR UPDATE').get(id)
        if (!u) return false
        if (!u.closed_at) {
          await tx.prepare('UPDATE upload_requests SET closed_at = ? WHERE id = ?').run(now(), id)
          await audit(nvReq, 'update', 'upload_requests', id, `приём закрыт экспертом (NVizor): контакт #${u.contact_id}`, tx)
        }
        return true
      })
      return done ? { ok: true } : reply.code(404).send({ error: 'not_found' })
    })

    // PDF-отчёт при публикации: сырые байты; идентификаторы — заголовками. Повтор того же номера и версии — 204 без копии; новая версия
    // заменяет показ старой, старый объект сразу уходит в очередь удаления.
    app.post('/api/nvizor/reports', { bodyLimit: PHOTO_BODY_LIMIT }, async (req, reply) => {
      if (!s3.configured) return reply.code(503).send({ error: 'storage_unavailable' })
      const number = String(req.headers['x-report-number'] || '').trim().slice(0, 60)
      const version = String(req.headers['x-report-version'] || '1').trim().slice(0, 30) || '1'
      const recordId = String(req.headers['x-record-id'] || '').trim().slice(0, 100)
      const publishedAt = String(req.headers['x-published-at'] || '').trim()
      const phone = String(req.headers['x-client-phone'] || '').trim().slice(0, 40)
      let stage = ''
      try { stage = decodeURIComponent(String(req.headers['x-report-stage'] || '')).slice(0, 100) } catch { stage = '' }
      if (!number || !phone || !Number.isFinite(Date.parse(publishedAt))) return reply.code(400).send({ error: 'bad_request' })
      const body = req.body
      if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(415).send({ error: 'not_pdf' })
      if (body.length > REPORT_MAX_BYTES) return reply.code(413).send({ error: 'too_large' })
      if (body.toString('latin1', 0, 5) !== '%PDF-') return reply.code(415).send({ error: 'not_pdf' })
      const contacts = await contactsByPhone(db, phone, await projectId())
      const contactId = contacts[0]?.id
      if (!contactId) return reply.code(404).send({ error: 'client_not_found' })
      const existing = await db.prepare('SELECT id, version FROM reports WHERE contact_id = ? AND number = ?').get(contactId, number)
      if (existing && existing.version === version) return reply.code(204).send()

      const key = `r/${crypto.randomBytes(24).toString('hex')}.pdf`
      try { await s3.put(key, body, 'application/pdf') } catch (err) {
        req.log?.warn?.({ code: err?.code }, 'reports: не удалось записать в хранилище')
        return reply.code(503).send({ error: 'storage_unavailable' })
      }
      const ts = now()
      const today = mskToday()
      const mail = await withMutation(async (tx) => {
        // Пока PDF летел в хранилище, контакт могли удалить или обезличить — тогда отчёт не записываем (в нём данные клиента).
        if (!(await tx.prepare('SELECT 1 FROM contacts WHERE id = ? AND anonymized_at IS NULL FOR UPDATE').get(contactId))) {
          await queueKey(tx, key)
          return 'gone'
        }
        const cur = await tx.prepare('SELECT id, storage_key FROM reports WHERE contact_id = ? AND number = ? FOR UPDATE').get(contactId, number)
        if (cur) {
          await queueKey(tx, cur.storage_key)
          await tx.prepare('UPDATE reports SET record_id = ?, version = ?, stage = ?, published_at = ?, storage_key = ?, size = ?, sha256 = ? WHERE id = ?')
            .run(recordId, version, stage, publishedAt, key, body.length, sha256hex(body), cur.id)
          await audit(nvReq, 'update', 'reports', cur.id, `отчёт ${number}: новая версия ${version} (контакт #${contactId})`, tx)
          return 'replaced'
        }
        const info = await tx.prepare('INSERT INTO reports (contact_id, record_id, number, version, stage, published_at, storage_key, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
          .run(contactId, recordId, number, version, stage, publishedAt, key, body.length, sha256hex(body), ts)
        await audit(nvReq, 'create', 'reports', info.lastInsertRowid, `отчёт ${number} опубликован в кабинете (контакт #${contactId})`, tx)
        // Письмо «отчёт готов» — только о НОВОМ отчёте, не о новой версии того же номера.
        return enqueueClientMail(tx, { kind: 'report_ready', contactId, params: { number }, now, today })
      })
      if (mail === 'gone') return reply.code(404).send({ error: 'client_not_found' })
      return reply.code(201).send({ ok: true, mail })
    })
  }

  // ---------- фон (раз в минуту, из общего прохода photoSweep) ----------
  async function sweep() {
    const ts = Date.now()
    // Незавершённые видео (форма выдана, подтверждения нет) — через пару часов: объект в очередь удаления, строку убираем.
    const stale = await db.prepare("SELECT id, storage_key FROM upload_files WHERE state = 'pending' AND created_at < ?").all(new Date(ts - PENDING_VIDEO_KEEP_MS).toISOString())
    for (const row of stale) {
      await withMutation(async (tx) => { await queueKey(tx, row.storage_key); await tx.prepare('DELETE FROM upload_files WHERE id = ?').run(row.id) })
    }
    // «📷 Клиент загрузил фото этапа: N (видео: M)» — одно уведомление на приём, через пару минут после первого файла.
    const due = await db.prepare('SELECT id FROM upload_requests WHERE files_notified = 0 AND first_file_at IS NOT NULL AND first_file_at < ?').all(new Date(ts - NOTIFY_AFTER_MS).toISOString())
    for (const row of due) {
      const used = await usageOf(row.id)
      await withMutation(async (tx) => {
        await tx.prepare('UPDATE upload_requests SET files_notified = 1 WHERE id = ?').run(row.id)
        if (used.photos + used.videos > 0) await enqueue(tx, 'text', { text: `📷 Клиент загрузил фото этапа: ${used.photos} (видео: ${used.videos}). Открыть — в карточке контакта в CRM.` })
      })
    }
  }

  return { register, sweep, summaryExtras, clientAuth }
}
