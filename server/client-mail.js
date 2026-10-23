// Письма КЛИЕНТУ (ADR-025, задание сайта 2026-10-20, часть 3). Это ПЕРВОЕ использование почты не для сотрудников.
//
// Что письмо может содержать: только имя клиента и личную ссылку в кабинет (+ номер отчёта / название этапа и срок). Никаких фото,
// адреса объекта, замечаний, телефона. Закрытый набор из двух шаблонов — тексты утверждены владельцем 2026-10-20.
// Письмо уходит только на адрес, который клиент указал сам (contacts.email или контакт для счёта типа «email»), и только если
// у контакта есть слепок согласия и нет флага email_opt_out.
//
// ВЫКЛЮЧЕНО ПО УМОЛЧАНИЮ (настройка client_mail.enabled): включает владелец после подтверждения сайта, что новая редакция политики
// ПДн выложена. Пока выключено — в очередь ничего не попадает и никаких писем нет.
//
// Ссылка в кабинет: ключ CRM не хранит (только SHA-256), поэтому в очереди — только параметры, а новая ссылка выпускается при
// КАЖДОЙ попытке отправки; если письмо не ушло, эта ссылка тут же гасится.
import { loadSettingsSafe } from './settings.js'
import { hashToken, newToken, linkExpiryFor } from './entitlements.js'

export const CLIENT_MAIL_KINDS = ['report_ready', 'upload_request']
const MAX_ATTEMPTS = 10
const DEFAULT_FROM_NAME = 'Невариум Визор'
const DEFAULT_REPLY_TO = 'nvizor-spb@yandex.ru'
// Памятка «Как снимать» на сайте Визора (сообщение сайта 2026-10-23). CLIENT_GUIDE_URL переопределяет; пустая строка — без фразы.
const DEFAULT_GUIDE_URL = 'https://nevarium-vizor.ru/photo-guide'

const FOOTER = '—\nВы получили письмо, потому что оставили заявку на nevarium-vizor.ru. Не хотите получать письма — ответьте на это письмо.'

const ruDate = (d) => (d ? `${String(d).slice(8, 10)}.${String(d).slice(5, 7)}.${String(d).slice(0, 4)}` : '')

/**
 * Имя для приветствия. Его вводит кто угодно в форме заявки, а письмо уходит с нашего адреса — поэтому имя не длиннее 60 символов
 * и без ссылок/адресов: иначе «имя» вида «Иван, срочно перейдите на evil.example» превращало бы письмо CRM в чужую рассылку
 * (проверка безопасности 2026-10-22). Подозрительное — нейтральное «клиент».
 */
export function greetingName(raw) {
  // eslint-disable-next-line no-control-regex
  const s = String(raw || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!s) return 'клиент'
  if (/(https?:|\/\/|www\.|@|[a-z0-9-]+\.(ru|рф|com|net|org|io|me|info|xyz|online|site|top|club|pro|su|biz)\b)/iu.test(s)) return 'клиент'
  return s.length > 60 ? `${s.slice(0, 60).trimEnd()}…` : s
}

/** Тексты писем (утверждены владельцем). Чистая функция — тест проверяет дословно. */
export function composeClientMail(kind, { name, link, number = '', stage = '', until = '', guideUrl = '' }) {
  const hello = `Здравствуйте, ${greetingName(name)}!`
  if (kind === 'report_ready') {
    return {
      subject: 'Отчёт готов — Невариум Визор',
      text: `${hello}\n\nОтчёт по вашему объекту готов: ${number}. Скачать его и посмотреть тариф можно в личном кабинете: ${link}.\n\nНевариум Визор\n\n${FOOTER}\n`,
    }
  }
  if (kind === 'upload_request') {
    const guide = guideUrl ? ` Как снимать: ${guideUrl}` : ''
    return {
      subject: 'Пришлите фото этапа — Невариум Визор',
      text: `${hello}\n\nЭксперт ждёт фото этапа «${stage}» до ${ruDate(until)}. Загрузите их с телефона по ссылке: ${link}.${guide}\n\nНевариум Визор\n\n${FOOTER}\n`,
    }
  }
  throw new Error('unknown_mail_kind')
}

/** Адрес для журнала: «i***@m***.ru» — по журналу видно, что письмо было, но не кому именно. */
export function maskEmail(addr) {
  const [local = '', domain = ''] = String(addr || '').split('@')
  const [host = '', ...rest] = domain.split('.')
  return `${local.slice(0, 1)}***@${host.slice(0, 1)}***${rest.length ? `.${rest.join('.')}` : ''}`
}

/**
 * Можно ли писать этому контакту. Возвращает { ok:true, to, name } или { ok:false, reason } — reason: no_contact | anonymized |
 * opted_out | no_address | no_consent. Адрес — contacts.email, иначе контакт для счёта типа email из самой свежей сделки.
 */
export async function clientMailTarget(runner, contactId) {
  const c = await runner.prepare('SELECT id, name, email, anonymized_at, email_opt_out FROM contacts WHERE id = ?').get(contactId)
  if (!c) return { ok: false, reason: 'no_contact' }
  if (c.anonymized_at) return { ok: false, reason: 'anonymized' }
  if (Number(c.email_opt_out)) return { ok: false, reason: 'opted_out' }
  let to = String(c.email || '').trim()
  if (!to) {
    const d = await runner.prepare("SELECT invoice_contact FROM deals WHERE contact_id = ? AND invoice_channel = 'email' AND invoice_contact <> '' ORDER BY id DESC LIMIT 1").get(contactId)
    to = String(d?.invoice_contact || '').trim()
  }
  if (!to || !to.includes('@')) return { ok: false, reason: 'no_address' }
  // Слепок согласия — доказательство, что человек сам оставил заявку и согласился на обработку (152-ФЗ ст. 9).
  // Строка согласия создаётся и у заявки БЕЗ согласия (accepted_at пусто — «согласия не было»), поэтому смотрим на дату принятия.
  const consent = await runner.prepare('SELECT 1 FROM consents WHERE contact_id = ? AND accepted_at IS NOT NULL LIMIT 1').get(contactId)
  if (!consent) return { ok: false, reason: 'no_consent' }
  return { ok: true, to, name: c.name }
}

/**
 * Поставить письмо в очередь. Выключено в настройках — ничего не делаем. Писать нельзя (нет адреса / отказ / нет согласия) — письма
 * нет, а для «отчёт готов» сотруднику создаётся задача «Сообщить клиенту». Вызывать ВНУТРИ транзакции (tx) события, которое
 * породило письмо. Возвращает 'disabled' | 'queued' | причину отказа.
 */
export async function enqueueClientMail(tx, { kind, contactId, params = {}, now, today }) {
  const settings = await loadSettingsSafe(tx)
  if (!settings['client_mail.enabled']) return 'disabled'
  const target = await clientMailTarget(tx, contactId)
  if (!target.ok) {
    if (kind === 'report_ready' && ['no_address', 'opted_out', 'no_consent'].includes(target.reason)) {
      const title = `Сообщить клиенту: отчёт готов${params.number ? ` (${params.number})` : ''}`
      const exists = await tx.prepare('SELECT 1 FROM tasks WHERE contact_id = ? AND title = ? AND done = 0').get(contactId, title)
      if (!exists) {
        await tx.prepare('INSERT INTO tasks (title, contact_id, due_date, done, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)').run(title, contactId, today, now(), now())
      }
    }
    return target.reason
  }
  await tx.prepare('INSERT INTO client_emails (kind, contact_id, params, created_at) VALUES (?, ?, ?, ?)').run(kind, contactId, JSON.stringify(params), now())
  return 'queued'
}

/**
 * Один проход очереди (раз в минуту): до 10 писем за раз. Условия проверяются ЗАНОВО в момент отправки (настройку могли выключить,
 * клиент мог отказаться, контакт — обезличиться). Сбой Postbox — повтор на следующем проходе, до 10 попыток; после них строка
 * остаётся с причиной (видна в журнале), сотрудник сообщает клиенту сам.
 */
export async function runClientMailQueue(db, { mailer, now, mskToday, cabinetBaseUrl, audit, env = process.env, log }) {
  const settings = await loadSettingsSafe(db)
  if (!settings['client_mail.enabled']) return { sent: 0, skipped: 0, failed: 0, disabled: true }
  const rows = await db.prepare('SELECT * FROM client_emails WHERE sent_at IS NULL AND attempts < ? ORDER BY id LIMIT 10').all(MAX_ATTEMPTS)
  const out = { sent: 0, skipped: 0, failed: 0 }
  const systemReq = { user: { id: null, email: 'система' } }
  for (const row of rows) {
    const target = await clientMailTarget(db, row.contact_id)
    if (!target.ok) {
      await db.prepare('UPDATE client_emails SET sent_at = ?, last_error = ? WHERE id = ?').run(now(), `пропущено: ${target.reason}`, row.id)
      out.skipped += 1
      continue
    }
    if (!mailer?.configured) {
      await db.prepare('UPDATE client_emails SET attempts = attempts + 1, last_error = ? WHERE id = ?').run('почта не настроена', row.id)
      out.failed += 1
      continue
    }
    let params = {}
    try { params = JSON.parse(row.params || '{}') } catch { /* пустые параметры */ }
    const token = newToken()
    const today = mskToday()
    const expiresOn = await linkExpiryFor(db, [row.contact_id], today)
    const linkRow = await db.prepare('INSERT INTO client_links (contact_id, token_hash, created_at, expires_on) VALUES (?, ?, ?, ?) RETURNING id')
      .run(row.contact_id, hashToken(token), now(), expiresOn)
    const { subject, text } = composeClientMail(row.kind, {
      name: target.name, link: `${cabinetBaseUrl}/#/c/${token}`, number: params.number, stage: params.stage, until: params.until, guideUrl: String(env.CLIENT_GUIDE_URL ?? DEFAULT_GUIDE_URL).trim(),
    })
    try {
      await mailer.send({
        to: target.to, subject, text,
        fromName: String(env.CLIENT_MAIL_FROM_NAME || DEFAULT_FROM_NAME).trim(),
        replyTo: String(env.CLIENT_MAIL_REPLY_TO || DEFAULT_REPLY_TO).trim(),
      })
      await db.prepare('UPDATE client_emails SET sent_at = ?, last_error = ? WHERE id = ?').run(now(), '', row.id)
      await audit(systemReq, 'send', 'client_emails', row.id, `письмо клиенту «${row.kind}»: контакт #${row.contact_id}, ${maskEmail(target.to)}`)
      out.sent += 1
    } catch (err) {
      // Письмо не ушло — только что выпущенная ссылка никому не передана: гасим её.
      await db.prepare('DELETE FROM client_links WHERE id = ?').run(linkRow.lastInsertRowid)
      await db.prepare('UPDATE client_emails SET attempts = attempts + 1, last_error = ? WHERE id = ?').run(String(err?.code || err?.message || 'ошибка').slice(0, 100), row.id)
      log?.warn?.(`client-mail: письмо #${row.id} не ушло: ${err?.code || err?.message}`)
      out.failed += 1
    }
  }
  return out
}
