// Отправка СЛУЖЕБНЫХ писем сотрудникам CRM (ADR-020): восстановление пароля, смена email,
// уведомление о смене пароля. Это единственное, для чего почта используется.
//
// ОГРАНИЧЕНИЕ (152-ФЗ, политика ПДн): никаких писем клиентам и никаких данных клиентов:
// в тексты шаблонов (server/account.js) они не попадают, а получатель проверяется там же
// (только адрес существующего сотрудника или подтверждаемый им новый).
//
// Два способа отправки, настройки — только из переменных окружения (не в репозитории и не в логах):
//  1) Yandex Cloud Postbox по HTTPS (AWS-совместимый API SES v2): POSTBOX_KEY_ID + POSTBOX_SECRET_KEY
//     (статический ключ сервисного аккаунта с ролью postbox.sender) + SMTP_FROM (адрес отправителя на
//     домене с подтверждённым DKIM); необязательно POSTBOX_ENDPOINT и MAIL_FROM_NAME. Нужен, когда
//     хостинг закрывает исходящий SMTP (так на Timeweb App Platform: таймаут на 465/587/2525).
//     Только простой текст — никакой подмены ссылок: в ссылке восстановления лежит одноразовый ключ.
//  2) SMTP: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM.
// Если заданы ключи Postbox — используется он. Не настроено ничего — configured=false, а формы
// честно пишут, что восстановление по почте недоступно.
import crypto from 'node:crypto'
import nodemailer from 'nodemailer'

const DEFAULT_POSTBOX_URL = 'https://postbox.cloud.yandex.net'
const POSTBOX_REGION = 'ru-central1'
const POSTBOX_SERVICE = 'ses'
const RECIPIENT_RE = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex')
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest()

/**
 * Подпись запроса по AWS Signature Version 4 (так Postbox проверяет ключ). Вынесена и проверяется
 * тестом на опубликованном AWS примере. headers — только те, что подписываем (host и x-amz-date обязательны).
 * Возвращает значение заголовка Authorization.
 */
export function signV4({ method, path, headers, body = '', region, service, keyId, secret }) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]))
  const names = Object.keys(lower).sort()
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join('')
  const signedHeaders = names.join(';')
  const canonical = [method, path, '', canonicalHeaders, signedHeaders, sha256hex(body)].join('\n')
  const amzDate = lower['x-amz-date']
  const day = amzDate.slice(0, 8)
  const scope = `${day}/${region}/${service}/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n')
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), 'aws4_request')
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex')
  return `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
}

/** Ошибка отправки по API: код и ответ сервиса без ключей. */
function apiError(code, message) {
  const err = new Error(message)
  err.code = code
  err.response = message
  return err
}

export function createMailer(env = process.env, { fetchImpl = globalThis.fetch, clock = () => new Date() } = {}) {
  const keyId = String(env.POSTBOX_KEY_ID || '').trim()
  const secret = String(env.POSTBOX_SECRET_KEY || '').trim()
  const endpoint = String(env.POSTBOX_ENDPOINT || DEFAULT_POSTBOX_URL).trim().replace(/\/+$/, '')
  const fromName = String(env.MAIL_FROM_NAME || 'Невариум CRM').trim()
  const host = String(env.SMTP_HOST || '').trim()
  const user = String(env.SMTP_USER || '').trim()
  const pass = String(env.SMTP_PASS || '')
  const port = Number(env.SMTP_PORT) || 465
  const from = String(env.SMTP_FROM || user).trim()
  const mode = keyId || secret ? 'postbox' : 'smtp'
  const configured = mode === 'postbox' ? Boolean(keyId && secret && RECIPIENT_RE.test(from)) : Boolean(host && user && pass && from)
  let transport = null

  async function sendViaPostbox({ to, subject, text }) {
    const url = new URL(`${endpoint}/v2/email/outbound-emails`)
    const body = JSON.stringify({
      FromEmailAddress: `${fromName.replace(/[<>"\r\n]/g, '')} <${from}>`,
      Destination: { ToAddresses: [to] },
      Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Text: { Data: text, Charset: 'UTF-8' } } } },
    })
    const amzDate = clock().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
    const signed = { 'content-type': 'application/json', host: url.host, 'x-amz-date': amzDate }
    const authorization = signV4({ method: 'POST', path: url.pathname, headers: signed, body, region: POSTBOX_REGION, service: POSTBOX_SERVICE, keyId, secret })
    let res
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': signed['content-type'], 'X-Amz-Date': amzDate, Authorization: authorization },
        body,
        signal: AbortSignal.timeout(15_000),
      })
    } catch (err) {
      throw apiError(err?.name === 'TimeoutError' ? 'ETIMEDOUT' : 'ECONNECTION', err?.message || 'network')
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw apiError(`HTTP_${res.status}`, String(data?.message || data?.Message || `HTTP ${res.status}`).slice(0, 300))
    }
  }

  return {
    configured,
    mode,
    /** Только простой текст; адресат — одна почта. Ошибки наружу без ключей/пароля и адреса. */
    async send({ to, subject, text }) {
      if (!configured) throw new Error('smtp_not_configured')
      if (typeof to !== 'string' || !RECIPIENT_RE.test(to)) throw new Error('bad_recipient')
      if (mode === 'postbox') return sendViaPostbox({ to, subject, text })
      transport ??= nodemailer.createTransport({
        host, port, secure: port === 465, auth: { user, pass },
        connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
      })
      await transport.sendMail({ from, to, subject, text })
    },
  }
}
