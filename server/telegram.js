import { now } from './db.js'

// Outbox: уведомление переживает падение Telegram — запись ретраится каждые
// ~30 c, до 20 попыток (~10 минут). Исчерпавшие попытки записи остаются в
// таблице с sent_at IS NULL и видны в диагностике как «в очереди».
export function enqueue(db, kind, payload) {
  db.prepare('INSERT INTO outbox (kind, payload, created_at) VALUES (?, ?, ?)').run(kind, JSON.stringify(payload), now())
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

export function leadMessage(lead) {
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const lines = [
    `🔵 <b>Новый лид с сайта</b>${lead.suspicious ? ' ⚠️ подозрительный' : ''}`,
    `<b>${esc(lead.name)}</b>${lead.company ? ` · ${esc(lead.company)}` : ''}`,
    lead.title ? esc(lead.title) : null,
    lead.contactInfo ? `Контакт: ${esc(lead.contactInfo)}` : null,
    lead.note ? esc(lead.note) : null,
  ]
  return lines.filter(Boolean).join('\n')
}

export function startOutboxWorker(db, { intervalMs = 30_000, send = sendTelegram, log = console, autoStart = true } = {}) {
  let running = false
  async function tick() {
    if (running) return
    running = true
    try {
      const rows = db
        .prepare("SELECT * FROM outbox WHERE sent_at IS NULL AND attempts < 20 ORDER BY id LIMIT 10")
        .all()
      for (const row of rows) {
        try {
          const payload = JSON.parse(row.payload)
          if (row.kind === 'lead') await send(leadMessage(payload))
          else if (row.kind === 'text') await send(payload.text)
          db.prepare('UPDATE outbox SET sent_at = ? WHERE id = ?').run(now(), row.id)
        } catch (err) {
          db.prepare('UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?').run(String(err), row.id)
          log.warn?.(`outbox: попытка ${row.attempts + 1} для #${row.id} не удалась: ${err}`)
        }
      }
    } finally {
      running = false
    }
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  if (autoStart) tick()
  return { tick, stop: () => clearInterval(timer) }
}
