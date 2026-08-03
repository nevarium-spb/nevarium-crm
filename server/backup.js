import fs from 'node:fs'
import path from 'node:path'
import { buildDump } from './db.js'
import { sendMax, sendMaxDocument, sendTelegram } from './telegram.js'

/**
 * Ночной бэкап: VACUUM INTO (безопасно при WAL), 7 ротаций, затем копии уходят
 * в мессенджер — офф-бокс копия на случай, если диск на сервере пропадёт.
 *
 * Копий ДВЕ, и это не избыточность (ADR-013):
 *  - `.sqlite` — точный слепок, но вернуть его можно только положив файл на диск,
 *    то есть при наличии shell. На App Platform shell'а нет.
 *  - `.json` — тот же дамп в формате «Импорта JSON» из настроек. Единственный
 *    способ восстановиться на App Platform: скачать из чата и загрузить браузером.
 *
 * Обе уходят ТОЛЬКО в MAX (российский сервис). В Telegram их отправлять нельзя
 * ни при каких условиях: внутри имена, телефоны, email, заметки и транскрипты
 * переписок всех клиентов, а Telegram зарубежный — это была бы трансграничная
 * передача ПДн (152-ФЗ). Ровно то, из-за чего сами уведомления о заявках
 * в Telegram обезличены (ADR-009).
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

  const jsonFile = path.join(dir, `crm-${stamp}.json`)
  fs.writeFileSync(jsonFile, JSON.stringify(buildDump(db)))

  // Ротация по 7 дат: у каждой даты две копии, поэтому считаем именно даты.
  const stamps = [...new Set(fs.readdirSync(dir)
    .filter((f) => f.startsWith('crm-'))
    .map((f) => f.slice(4, 14)))].sort()
  for (const old of stamps.slice(0, -7)) {
    for (const ext of ['.sqlite', '.json']) fs.rmSync(path.join(dir, `crm-${old}${ext}`), { force: true })
  }

  const sizeMb = (fs.statSync(file).size / 1024 / 1024).toFixed(1)
  if (env.MAX_BOT_TOKEN && env.MAX_CHAT_ID) {
    // JSON шлём первым: именно им восстанавливаются на App Platform, и если
    // сорвётся вторая отправка, важнее сохранить восстановимую копию.
    const sent = []
    for (const [f, caption] of [
      [jsonFile, `Бэкап CRM · ${stamp} · JSON — этим восстанавливаются через «Импорт JSON» в настройках`],
      [file, `Бэкап CRM · ${stamp} · файл базы (нужен shell, для App Platform не подходит)`],
    ]) {
      try {
        await sendDocument(f, caption, env)
        sent.push(path.extname(f))
      } catch (err) {
        log.warn?.(`backup: не удалось отправить ${path.basename(f)} в MAX: ${err}`)
        try { await sendStatus(`⚠️ Бэкап CRM за ${stamp} создан на сервере (${sizeMb} МБ), но ${path.extname(f)} не отправился: ${err}`, env) } catch {}
      }
    }
    return { file, jsonFile, sent }
  }
  log.warn?.('backup: MAX не настроен — копии остались только на сервере')
  try { await sendStatus(`⚠️ Бэкап CRM за ${stamp} создан на сервере (${sizeMb} МБ), но MAX не настроен — офф-бокс копии нет.`, env) } catch {}
  return { file, jsonFile, sent: [] }
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
