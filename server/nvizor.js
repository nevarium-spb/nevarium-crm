// Настольное приложение NVizor (Невариум Визор): общая история бесплатных отчётов
// тарифа Free для всех ПК эксперта (решение владельца 2026-09-28, «пункт 5 через CRM»).
//
// Зачем здесь, а не на каждом ПК: у каждого ПК своя база, и клиент, получивший
// бесплатный отчёт на одном компьютере, на другом выглядел новым. Приложение при
// выдаче бесплатного PDF присылает сюда слепок признаков клиента и перед каждым
// запросом Free спрашивает записи, у которых совпал хотя бы один признак. Правило
// «отказ / предупреждение» остаётся в приложении (shared/tariff/freeTier.ts) — сервер
// только грубо отбирает кандидатов, чтобы не отдавать приложению всю историю.
//
// Доступ — только по ключу приложения NVIZOR_APP_TOKEN (заголовок Authorization:
// Bearer …), без cookie-сессии и без CORS: вызывает main-процесс Electron, не браузер.
// Ключ не задан — эндпоинты отвечают 503, а не работают без защиты. Проверка ключа
// привязана к КАНОНИЧЕСКОМУ шаблону роута (routeOptions.url), а не к req.url — урок
// пентеста 2026-09-10 (обход через %63rm), см. хук авторизации /api/crm/ в app.js.

import crypto from 'node:crypto'

export const NVIZOR_PREFIX = '/api/nvizor/'
const MIN_TOKEN_LENGTH = 32
const SAME_PLACE_RADIUS_M = 100

const MAX = { name: 200, phone: 40, device: 200, devices: 50, locations: 200, hashes: 500, recordId: 100 }

const str = (v, max) => String(v ?? '').trim().slice(0, max)

/** Тот же ключ телефона, что у дедупа лидов (phoneKey в app.js): последние 10 цифр. */
export function nvizorPhoneKey(raw) {
  const s = String(raw || '')
  if (s.includes('@')) return ''
  let d = s.replace(/\D/g, '')
  if (d.length === 11 && d.startsWith('8')) d = '7' + d.slice(1)
  return d.length >= 10 ? d.slice(-10) : ''
}

const normName = (s) => String(s || '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ')

function strList(value, max, itemMax) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((v) => str(v, itemMax).toLowerCase()).filter(Boolean))].slice(0, max)
}

function locationList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const p of value.slice(0, MAX.locations)) {
    const lat = Number(p?.lat)
    const lng = Number(p?.lng)
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      out.push({ lat, lng })
    }
  }
  return out
}

function haversineMeters(a, b) {
  const R = 6_371_000
  const rad = (d) => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function parseJson(raw, fallback) {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : fallback
  } catch {
    return fallback
  }
}

function rowToRecord(row) {
  return {
    recordId: row.record_id,
    objectRef: row.object_ref,
    clientName: row.client_name,
    phoneKey: row.phone_key,
    devices: parseJson(row.devices, []),
    locations: parseJson(row.locations, []),
    photoHashes: parseJson(row.photo_hashes, []),
    usedAt: row.used_at
  }
}

function tokenMatches(expected, header) {
  const m = /^Bearer\s+(.+)$/i.exec(String(header || ''))
  if (!m) return false
  const a = Buffer.from(m[1].trim())
  const b = Buffer.from(expected)
  // timingSafeEqual требует одинаковой длины; сравнение длины само по себе не раскрывает
  // содержимое ключа.
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/**
 * Регистрирует хук доступа и роуты /api/nvizor/*. token — NVIZOR_APP_TOKEN (null —
 * не настроен), withMutation — обёртка мутаций с барьером обслуживания (app.js), чтобы
 * запись не пересекалась с восстановлением дампа.
 */
export function registerNvizorRoutes(app, { db, token, withMutation, now }) {
  const configured = typeof token === 'string' && token.length >= MIN_TOKEN_LENGTH

  app.addHook('preHandler', async (req, reply) => {
    const canonical = req.routeOptions?.url || ''
    let decoded = req.url
    try { decoded = decodeURIComponent(req.url) } catch { /* битое кодирование — идём с сырым */ }
    if (!canonical.startsWith(NVIZOR_PREFIX) && !decoded.startsWith(NVIZOR_PREFIX)) return
    if (!configured) return reply.code(503).send({ error: 'not_configured' })
    if (!tokenMatches(token, req.headers.authorization)) return reply.code(401).send({ error: 'unauthorized' })
  })

  // Проверка связи и ключа из «Настроек» приложения.
  app.get('/api/nvizor/ping', async () => ({ ok: true }))

  // Бесплатный отчёт выдан. record_id — id записи в приложении: повтор отправки
  // (досылка из очереди после обрыва связи) не создаёт вторую запись.
  app.post('/api/nvizor/free-reports', { bodyLimit: 128 * 1024 }, async (req, reply) => {
    const b = req.body || {}
    const recordId = str(b.recordId, MAX.recordId)
    const usedAt = str(b.usedAt, 40)
    if (!recordId || !usedAt) return reply.code(400).send({ error: 'bad_request' })
    const row = {
      record_id: recordId,
      object_ref: str(b.objectRef, MAX.recordId),
      client_name: str(b.clientName, MAX.name),
      phone_key: nvizorPhoneKey(str(b.clientPhone, MAX.phone)),
      devices: JSON.stringify(strList(b.devices, MAX.devices, MAX.device)),
      locations: JSON.stringify(locationList(b.locations)),
      photo_hashes: JSON.stringify(strList(b.photoHashes, MAX.hashes, 128)),
      used_at: usedAt,
      created_at: now()
    }
    await withMutation(async (tx) => {
      await tx
        .prepare(`INSERT INTO nvizor_free_reports (record_id, object_ref, client_name, phone_key, devices, locations, photo_hashes, used_at, created_at)
          VALUES (@record_id, @object_ref, @client_name, @phone_key, @devices, @locations, @photo_hashes, @used_at, @created_at)
          ON CONFLICT (record_id) DO NOTHING`)
        .run(row)
    })
    return reply.code(201).send({ ok: true })
  })

  // Кандидаты на повтор: записи, у которых совпал хотя бы один признак. Перебор в JS —
  // таблица маленькая (один бесплатный отчёт на клиента), а расстояние по координатам
  // SQL без расширений не посчитает (тот же приём, что findExistingContact в app.js).
  app.post('/api/nvizor/free-reports/search', { bodyLimit: 128 * 1024 }, async (req) => {
    const b = req.body || {}
    const phone = nvizorPhoneKey(str(b.clientPhone, MAX.phone))
    const name = normName(str(b.clientName, MAX.name))
    const devices = new Set(strList(b.devices, MAX.devices, MAX.device))
    const hashes = new Set(strList(b.photoHashes, MAX.hashes, 128))
    const locations = locationList(b.locations)

    const rows = await db.prepare('SELECT * FROM nvizor_free_reports ORDER BY id').all()
    const records = rows.map(rowToRecord).filter((r) => {
      if (phone && r.phoneKey === phone) return true
      if (name && normName(r.clientName) === name) return true
      if (r.devices.some((d) => devices.has(String(d).toLowerCase()))) return true
      if (r.photoHashes.some((h) => hashes.has(String(h).toLowerCase()))) return true
      return locations.some((a) => r.locations.some((l) => haversineMeters(a, l) <= SAME_PLACE_RADIUS_M))
    })
    return { records }
  })
}

/**
 * Обезличивание / удаление контакта (152-ФЗ): записи Free того же человека стираются
 * вместе с ним. Сопоставление — по ключу телефона, тем же способом, что дедуп лидов.
 * Вызывается ВНУТРИ транзакции обезличивания/удаления, на её tx.
 */
export async function deleteNvizorFreeReportsForPhone(tx, phone) {
  const key = nvizorPhoneKey(phone)
  if (!key) return 0
  const res = await tx.prepare('DELETE FROM nvizor_free_reports WHERE phone_key = ?').run(key)
  return res?.changes ?? 0
}
