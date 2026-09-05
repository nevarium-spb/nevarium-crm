import fs from 'node:fs'
import path from 'node:path'
import { buildDump } from './db.js'
import { sendMax, sendMaxDocument, sendTelegram } from './telegram.js'

/**
 * Ночной бэкап: JSON-дамп (7 ротаций), затем копия уходит в мессенджер —
 * офф-бокс копия на случай, если сама база станет недоступна.
 *
 * ПЕРЕВОД НА POSTGRES (план в nevarium-lab#3, раздел про backup.js): раньше здесь
 * было ДВЕ копии — `.sqlite` (VACUUM INTO, точный слепок файла) и `.json` (формат
 * «Импорта JSON» из настроек). `VACUUM INTO` — SQLite-специфика, у Postgres нет
 * прямого аналога (снимок делается снаружи, `pg_dump`, которого может не быть в
 * контейнере приложения). Убрали `.sqlite`-копию совсем: она и была нужна только
 * потому, что на SQLite это стоило одну команду и давало offline-восстановление
 * без shell. `.json` остаётся единственным форматом бэкапа в MAX — обычные
 * `SELECT *` (buildDump), перевод почти не тронул — и его дополняют управляемые
 * бэкапы самого Timeweb Postgres (включаются на Этапе 2 плана переезда, отдельно
 * от этого кода). Итог даже надёжнее прежнего: снимок на уровне СУБД + переносимый
 * JSON, вместо одного файла базы.
 *
 * JSON уходит ТОЛЬКО в MAX (российский сервис). В Telegram его отправлять нельзя
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

  const jsonFile = path.join(dir, `crm-${stamp}.json`)
  // Сборка дампа обязана СООБЩИТЬ о своём провале, а не просто бросить. Ниже уже есть
  // статус «создан, но не отправился»; а вот «не создан вовсе» уходил только в лог
  // процесса — который на App Platform теряется при передеплое (ADR-008). Для
  // неприсматриваемой ночной задачи, чей результат и есть единственный путь
  // восстановления (ADR-013), это означало: неудавшийся бэкап неотличим от удавшегося,
  // и владелец узнаёт правду в аварии (найдено red team). У buildDump с этой сессии
  // появились новые способы упасть — ему теперь нужно соединение пула и снимок
  // REPEATABLE READ, а пул может быть занят восстановлением.
  try {
    fs.writeFileSync(jsonFile, JSON.stringify(await buildDump(db)))
  } catch (err) {
    log.error?.(`backup: дамп не собран: ${err}`)
    try { await sendStatus(`🛑 Бэкап CRM за ${stamp} НЕ СОЗДАН: ${err}. Проверьте базу — восстанавливаться сейчас нечем.`, env) } catch {}
    throw err
  }

  // Ротация по 7 датам.
  const stamps = [...new Set(fs.readdirSync(dir)
    .filter((f) => f.startsWith('crm-') && f.endsWith('.json'))
    .map((f) => f.slice(4, 14)))].sort()
  for (const old of stamps.slice(0, -7)) fs.rmSync(path.join(dir, `crm-${old}.json`), { force: true })

  const sizeMb = (fs.statSync(jsonFile).size / 1024 / 1024).toFixed(1)
  if (env.MAX_BOT_TOKEN && env.MAX_CHAT_ID) {
    try {
      await sendDocument(jsonFile, `Бэкап CRM · ${stamp} · JSON — этим восстанавливаются через «Импорт JSON» в настройках`, env)
      return { jsonFile, sent: ['.json'] }
    } catch (err) {
      log.warn?.(`backup: не удалось отправить ${path.basename(jsonFile)} в MAX: ${err}`)
      try { await sendStatus(`⚠️ Бэкап CRM за ${stamp} создан на сервере (${sizeMb} МБ), но не отправился: ${err}`, env) } catch {}
      return { jsonFile, sent: [] }
    }
  }
  log.warn?.('backup: MAX не настроен — копия осталась только на сервере')
  try { await sendStatus(`⚠️ Бэкап CRM за ${stamp} создан на сервере (${sizeMb} МБ), но MAX не настроен — офф-бокс копии нет.`, env) } catch {}
  return { jsonFile, sent: [] }
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
