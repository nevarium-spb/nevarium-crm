import fs from 'node:fs'
import path from 'node:path'
import { sendTelegram } from './telegram.js'

// Ночной бэкап: VACUUM INTO (безопасно при WAL), 7 ротаций,
// затем документ уходит админу в Telegram — офф-бокс копия.
export async function runBackup(db, { dir = './data/backups', env = process.env, log = console } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 10)
  const file = path.join(dir, `crm-${stamp}.sqlite`)
  fs.rmSync(file, { force: true })
  db.prepare(`VACUUM INTO ?`).run(file)

  const backups = fs.readdirSync(dir).filter((f) => f.startsWith('crm-')).sort()
  for (const old of backups.slice(0, -7)) fs.rmSync(path.join(dir, old), { force: true })

  const token = env.TG_BOT_TOKEN
  const chatId = env.TG_ADMIN_CHAT_ID || env.TG_CHAT_ID
  if (token && chatId) {
    try {
      const form = new FormData()
      form.append('chat_id', chatId)
      form.append('document', new Blob([fs.readFileSync(file)]), `crm-${stamp}.sqlite`)
      form.append('caption', `Ночной бэкап CRM · ${stamp}`)
      const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (err) {
      log.warn?.(`backup: не удалось отправить в Telegram: ${err}`)
      try { await sendTelegram(`⚠️ Бэкап создан, но не отправился: ${err}`, env) } catch {}
    }
  }
  return file
}

export function scheduleBackups(db, opts = {}) {
  const log = opts.log || console
  const tick = async () => {
    const mskHour = Number(new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: 'numeric', hour12: false }).format(new Date()))
    if (mskHour === 4) {
      try {
        await runBackup(db, opts)
        log.info?.('backup: ok')
      } catch (err) {
        log.error?.(`backup: ${err}`)
      }
    }
  }
  const timer = setInterval(tick, 55 * 60_000)
  timer.unref?.()
  return { stop: () => clearInterval(timer), tick }
}
