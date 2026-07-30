import fs from 'node:fs'
import path from 'node:path'
import { sendMax, sendMaxDocument, sendTelegram } from './telegram.js'

/**
 * Ночной бэкап: VACUUM INTO (безопасно при WAL), 7 ротаций, затем копия уходит
 * в мессенджер — офф-бокс копия на случай, если диск на сервере пропадёт.
 *
 * Файл базы уходит ТОЛЬКО в MAX (российский сервис). В Telegram его отправлять
 * нельзя ни при каких условиях: внутри имена, телефоны, email, заметки и
 * транскрипты переписок всех клиентов, а Telegram зарубежный — это была бы
 * трансграничная передача ПДн (152-ФЗ). Ровно то, из-за чего сами уведомления
 * о заявках в Telegram обезличены. Подробности — ADR-009.
 *
 * Telegram остаётся только для обезличенного статуса «бэкап сделан / не ушёл» —
 * это текст без ПДн, и владельцу полезно видеть его в том мессенджере, который
 * под рукой.
 */
export async function runBackup(db, {
  dir = './data/backups',
  env = process.env,
  log = console,
  sendDocument = sendMaxDocument,
  sendStatus = sendBothChannels,
} = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 10)
  const file = path.join(dir, `crm-${stamp}.sqlite`)
  fs.rmSync(file, { force: true })
  db.prepare(`VACUUM INTO ?`).run(file)

  const backups = fs.readdirSync(dir).filter((f) => f.startsWith('crm-')).sort()
  for (const old of backups.slice(0, -7)) fs.rmSync(path.join(dir, old), { force: true })

  const sizeMb = (fs.statSync(file).size / 1024 / 1024).toFixed(1)
  if (env.MAX_BOT_TOKEN && env.MAX_CHAT_ID) {
    try {
      await sendDocument(file, `Ночной бэкап CRM · ${stamp}`, env)
    } catch (err) {
      log.warn?.(`backup: не удалось отправить в MAX: ${err}`)
      // Статус обезличен — только дата и размер, ни одного поля клиента
      try { await sendStatus(`⚠️ Бэкап CRM за ${stamp} создан на сервере (${sizeMb} МБ), но не отправился: ${err}`, env) } catch {}
    }
  } else {
    log.warn?.('backup: MAX не настроен — копия осталась только на сервере')
    try { await sendStatus(`⚠️ Бэкап CRM за ${stamp} создан на сервере (${sizeMb} МБ), но MAX не настроен — офф-бокс копии нет.`, env) } catch {}
  }
  return file
}

/** Обезличенный статус — в оба канала, чтобы молчание одного не скрыло проблему. */
async function sendBothChannels(text, env) {
  const results = await Promise.allSettled([sendTelegram(text, env), sendMax(text, env)])
  if (results.every((r) => r.status === 'rejected')) throw new Error(String(results[0].reason))
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
