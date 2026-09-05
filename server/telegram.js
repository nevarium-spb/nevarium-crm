import fs from 'node:fs'
import path from 'node:path'
import { now } from './db.js'
import { withTransaction, maintenanceBarrier } from './db-adapter.js'

const MAX_API = 'https://platform-api2.max.ru'

// Outbox: уведомление переживает падение канала отправки — запись ретраится
// каждые ~30 c, до 20 попыток (~10 минут) на каждый канал (Telegram, MAX) отдельно.
// Исчерпавшие попытки записи остаются в таблице и видны в диагностике как «в очереди».
export async function enqueue(db, kind, payload) {
  await db.prepare('INSERT INTO outbox (kind, payload, created_at) VALUES (?, ?, ?)').run(kind, JSON.stringify(payload), now())
}

export async function sendTelegram(text, env = process.env) {
  const token = env.TG_BOT_TOKEN
  const chatId = env.TG_CHAT_ID
  if (!token || !chatId) throw new Error('TG_BOT_TOKEN/TG_CHAT_ID не заданы')
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`)
}

// MAX Bot API: platform-api2.max.ru, POST /messages?chat_id=…, токен — в заголовке
// Authorization (без "Bearer"), format: 'html' поддерживает те же теги, что мы уже
// экранируем в leadMessage(). Источник — исходники клиента max-messenger/max-bot-api-client-ts.
export async function sendMax(text, env = process.env) {
  const token = env.MAX_BOT_TOKEN
  const chatId = env.MAX_CHAT_ID
  if (!token || !chatId) throw new Error('MAX_BOT_TOKEN/MAX_CHAT_ID не заданы')
  const url = new URL(`${MAX_API}/messages`)
  url.searchParams.set('chat_id', chatId)
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: token },
    body: JSON.stringify({ text, format: 'html' }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`MAX HTTP ${res.status}`)
}

/**
 * Отправка файла в MAX — этим уходит ночной бэкап базы (см. server/backup.js).
 * Именно MAX, а не Telegram: в файле базы лежат ПДн всех клиентов, а Telegram
 * зарубежный — это была бы трансграничная передача (152-ФЗ). ADR-009.
 *
 * Три шага, как требует MAX Bot API: получить URL → залить файл → прикрепить
 * к сообщению по токену. Файл обрабатывается на их стороне асинхронно, поэтому
 * сразу после загрузки прикрепление отвечает `attachment.not.ready` — это
 * нормальный ход событий (проверено на живом боте), ждём и повторяем.
 */
export async function sendMaxDocument(filePath, caption, env = process.env, { attempts = 10, delayMs = 2000 } = {}) {
  const token = env.MAX_BOT_TOKEN
  const chatId = env.MAX_CHAT_ID
  if (!token || !chatId) throw new Error('MAX_BOT_TOKEN/MAX_CHAT_ID не заданы')

  const urlRes = await fetch(`${MAX_API}/uploads?type=file`, {
    method: 'POST',
    headers: { Authorization: token },
    signal: AbortSignal.timeout(30_000),
  })
  if (!urlRes.ok) throw new Error(`MAX uploads HTTP ${urlRes.status}`)
  const { url: uploadUrl } = await urlRes.json()
  if (!uploadUrl) throw new Error('MAX uploads: не вернул url для загрузки')

  const form = new FormData()
  form.append('data', new Blob([fs.readFileSync(filePath)]), path.basename(filePath))
  const upRes = await fetch(uploadUrl, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) })
  if (!upRes.ok) throw new Error(`MAX upload HTTP ${upRes.status}`)
  const fileToken = (await upRes.json())?.token
  if (!fileToken) throw new Error('MAX upload: не вернул token файла')

  const msgUrl = new URL(`${MAX_API}/messages`)
  msgUrl.searchParams.set('chat_id', chatId)
  let lastError = ''
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(msgUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: token },
      body: JSON.stringify({ text: caption, attachments: [{ type: 'file', payload: { token: fileToken } }] }),
      signal: AbortSignal.timeout(30_000),
    })
    if (res.ok) return
    lastError = await res.text().catch(() => `HTTP ${res.status}`)
    // Не «ещё не готово» — повторять бессмысленно, ошибка настоящая
    if (!lastError.includes('not.ready')) throw new Error(`MAX attach HTTP ${res.status}: ${lastError.slice(0, 200)}`)
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  throw new Error(`MAX attach: файл так и не обработался за ${attempts} попыток: ${lastError.slice(0, 200)}`)
}

/**
 * Уведомление в Telegram — БЕЗ персональных данных.
 * Telegram — зарубежный сервис, а имя и телефон клиента по 152-ФЗ должны
 * оставаться в российском контуре. Поэтому здесь только проект, источник и
 * ссылка на карточку: сами данные открываются в CRM после входа.
 * Менять формат — только не возвращая сюда поля клиента.
 */
export function leadMessage(lead, env = process.env) {
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const base = String(env.CRM_BASE_URL || '').trim().replace(/\/+$/, '')
  const link = base && lead.contactId ? `${base}/crm/contacts/${lead.contactId}` : null
  const lines = [
    `${leadHeader(lead)}${lead.suspicious ? ' ⚠️ подозрительная' : ''}`,
    lead.projectName ? `Проект: <b>${esc(lead.projectName)}</b>` : null,
    lead.source ? `Источник: ${esc(lead.source)}` : null,
    link ? `Открыть: ${esc(link)}` : 'Детали — в CRM, карточка заявки',
  ]
  return lines.filter(Boolean).join('\n')
}

/**
 * Заголовок уведомления. Повторное обращение и возврат ушедшего клиента — разные
 * поводы: первое значит «не заводите вторую карточку, всё уже в одной», второе —
 * «человек вернулся сам, напоминания сняты». Персональных данных в заголовке нет,
 * поэтому он одинаков для Telegram и MAX.
 */
function leadHeader(lead) {
  if (lead.returned) return '🟢 <b>Клиент вернулся сам</b>'
  if (lead.repeat) return '🔁 <b>Повторная заявка</b>'
  return '🔵 <b>Новая заявка</b>'
}

/**
 * Уведомление в MAX — С персональными данными (имя, контакт, суть задачи).
 * В отличие от Telegram, MAX — российский сервис, трансграничной передачи ПДн
 * тут нет, поэтому можно не обезличивать. Контакт и последнюю сделку тянем из
 * БД по contactId в момент отправки — сам outbox.payload остаётся обезличенным
 * (см. enqueue в app.js), ПДн не дублируются в очередь на диске.
 */
export async function leadMessageFull(lead, db, env = process.env) {
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const contact = lead.contactId ? await db.prepare('SELECT name, phone, email, messenger FROM contacts WHERE id = ?').get(lead.contactId) : null
  const deal = lead.contactId ? await db.prepare('SELECT title, note FROM deals WHERE contact_id = ? ORDER BY id DESC LIMIT 1').get(lead.contactId) : null
  const base = String(env.CRM_BASE_URL || '').trim().replace(/\/+$/, '')
  const link = base && lead.contactId ? `${base}/crm/contacts/${lead.contactId}` : null
  const contactLine = contact ? [contact.phone, contact.email, contact.messenger].filter(Boolean).join(' · ') : ''
  const lines = [
    `${leadHeader(lead)}${lead.suspicious ? ' ⚠️ подозрительная' : ''}`,
    lead.projectName ? `Проект: <b>${esc(lead.projectName)}</b>` : null,
    lead.source ? `Источник: ${esc(lead.source)}` : null,
    contact?.name ? `Клиент: <b>${esc(contact.name)}</b>` : null,
    contactLine ? `Контакт: ${esc(contactLine)}` : null,
    deal?.title ? `Задача: ${esc(deal.title)}` : null,
    deal?.note ? `Заметка: ${esc(deal.note)}` : null,
    link ? `Открыть: ${esc(link)}` : null,
  ]
  return lines.filter(Boolean).join('\n')
}

// Каждый канал — свои sent_at/attempts/last_error (миграция v7): падение MAX не
// должно ни блокировать Telegram, ни повторно слать туда, куда уже доставлено.
// leadText разный: Telegram — обезличенный leadMessage, MAX — полный leadMessageFull.
// leadText — async у обоих ради единообразия вызова ниже (await channel.leadText(...)):
// у tg он не трогает БД и просто резолвится немедленно, у max — реально читает БД.
const CHANNELS = [
  { name: 'tg', sentCol: 'tg_sent_at', attemptsCol: 'tg_attempts', errorCol: 'tg_last_error', leadText: async (payload) => leadMessage(payload) },
  { name: 'max', sentCol: 'max_sent_at', attemptsCol: 'max_attempts', errorCol: 'max_last_error', leadText: async (payload, db) => leadMessageFull(payload, db) },
]

export function startOutboxWorker(db, { intervalMs = 30_000, senders = { tg: sendTelegram, max: sendMax }, log = console, autoStart = true } = {}) {
  let running = false
  async function tick() {
    if (running) return
    running = true
    try {
      // Внешний SELECT ниже раньше был синхронным чтением локального файла SQLite и
      // на практике не падал никогда. Теперь это сетевой запрос к Postgres: обрыв
      // соединения, исчерпанный пул, рестарт управляемой базы при обслуживании —
      // штатные события. Без catch отказ здесь уходит НЕОБРАБОТАННЫМ отклонением
      // промиса из колбэка setInterval, а это в Node по умолчанию валит весь процесс
      // CRM. Ловим и логируем: следующий тик через intervalMs попробует снова, очередь
      // в outbox никуда не девается.
      for (const channel of CHANNELS) {
        const send = senders[channel.name]
        if (!send) continue
        const rows = await db
          .prepare(`SELECT * FROM outbox WHERE ${channel.sentCol} IS NULL AND ${channel.attemptsCol} < 20 ORDER BY id LIMIT 10`)
          .all()
        for (const row of rows) {
          try {
            // Текст собирается В ТРАНЗАКЦИИ ПОД БАРЬЕРОМ и с перепроверкой строки
            // (найдено red team). Очередь намеренно обезличена: в ней только
            // contactId, а имя и телефон достаются из БД ИМЕННО ЗДЕСЬ (ADR-009).
            // Партия из 10 строк с таймаутом отправки 10 c растягивается на минуты,
            // и восстановление дампа успевало закоммититься посреди неё: строку
            // очереди импорт уже удалил, контакты заменены целиком — и следующая
            // строка партии разрешала свой contactId в ДРУГОГО человека, отправляя
            // в MAX его имя и телефон под заголовком чужой заявки. Молча: финальный
            // UPDATE просто не находил строку. Барьер не даёт восстановлению
            // вклиниться, а перепроверка ловит уже случившееся: строки нет — значит
            // заявку откатили вместе с ней, отправлять нечего.
            //
            // Сама отправка — СНАРУЖИ транзакции: держать барьер на время сетевого
            // вызова значило бы, что восстановление ждёт мессенджер.
            let text = null
            if (db.pool) {
              await withTransaction(db.pool, async (tx) => {
                await maintenanceBarrier(tx)
                const fresh = await tx.prepare(`SELECT id, kind, payload FROM outbox WHERE id = ? FOR UPDATE`).get(row.id)
                if (!fresh) return
                const payload = JSON.parse(fresh.payload)
                text = fresh.kind === 'lead' ? await channel.leadText(payload, tx) : payload.text
              })
            } else {
              // Путь без пула (старые тесты передают db-подобную заглушку) — прежнее
              // поведение, без барьера: там восстановления не бывает.
              const payload = JSON.parse(row.payload)
              text = row.kind === 'lead' ? await channel.leadText(payload, db) : payload.text
            }
            if (text === null || text === undefined) continue
            await send(text)
            await db.prepare(`UPDATE outbox SET ${channel.sentCol} = ? WHERE id = ?`).run(now(), row.id)
          } catch (err) {
            await db.prepare(`UPDATE outbox SET ${channel.attemptsCol} = ${channel.attemptsCol} + 1, ${channel.errorCol} = ? WHERE id = ?`).run(String(err), row.id)
            log.warn?.(`outbox[${channel.name}]: попытка ${row[channel.attemptsCol] + 1} для #${row.id} не удалась: ${err}`)
          }
        }
      }
    } catch (err) {
      // Сюда попадают только отказы САМОЙ базы (внешний SELECT, или UPDATE счётчика
      // попыток внутри catch выше) — доставка в мессенджеры разбирается своим catch
      // построчно. Молча глотать нельзя, ронять процесс — тем более: логируем и ждём
      // следующего тика.
      log.error?.(`outbox: тик прерван ошибкой базы, повтор через ${Math.round(intervalMs / 1000)} c: ${err}`)
    } finally {
      running = false
    }
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  if (autoStart) tick()
  return { tick, stop: () => clearInterval(timer) }
}
