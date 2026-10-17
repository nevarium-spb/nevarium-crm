// Проверка почты из консоли сервера: node server/test-mail.js  (или `npm run test-mail`).
// Показывает, что именно мешает письмам: порт недоступен, Gmail не принял логин/пароль,
// пароль не задан. Отправляет ОДНО тестовое письмо — только сотруднику CRM (политика ПДн:
// почта — исключительно служебная, клиентам и с данными клиентов она не используется).
// Пароль приложения нигде не печатается: только «задан / не задан» и его длина.
import net from 'node:net'
import readline from 'node:readline/promises'
import { openDb } from './db.js'
import { createMailer } from './mailer.js'

/** Настройки SMTP без секретов. */
export function describeMailConfig(env = process.env) {
  const pass = String(env.SMTP_PASS || '')
  const user = String(env.SMTP_USER || '').trim()
  const keyId = String(env.POSTBOX_KEY_ID || '').trim()
  const secret = String(env.POSTBOX_SECRET_KEY || '').trim()
  return {
    mode: keyId || secret ? 'postbox' : 'smtp',
    keyIdSet: keyId.length > 0,
    secretSet: secret.length > 0,
    secretLength: secret.length,
    host: String(env.SMTP_HOST || '').trim(),
    port: Number(env.SMTP_PORT) || 465,
    user,
    from: String(env.SMTP_FROM || user).trim(),
    passSet: pass.length > 0,
    passLength: pass.length,
    // Пробелы внутри пароля приложения (Google показывает его «xxxx xxxx xxxx xxxx») — частая ошибка при вставке.
    passHasSpaces: /\s/.test(pass),
  }
}

/** Доходит ли сервер до SMTP-порта вообще (отличает «хостинг режет порт» от «Gmail не принял пароль»). */
export function checkTcp(host, port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const started = Date.now()
    const socket = net.connect({ host, port })
    const done = (res) => { socket.destroy(); resolve({ ...res, ms: Date.now() - started }) }
    socket.setTimeout(timeoutMs, () => done({ ok: false, error: 'таймаут — соединение не установилось' }))
    socket.on('connect', () => done({ ok: true }))
    socket.on('error', (err) => done({ ok: false, error: err.code || err.message }))
  })
}

/** Подсказка по коду ошибки nodemailer — человеческим языком. */
export function explainMailError(err, tcp) {
  const code = err?.code || ''
  if (code === 'HTTP_401' || code === 'HTTP_403') return 'Postbox не принял ключ или у него нет прав. Проверьте POSTBOX_KEY_ID и POSTBOX_SECRET_KEY (скопированы целиком, без пробелов и кавычек) и что у сервисного аккаунта есть роль postbox.sender.'
  if (code.startsWith('HTTP_')) return 'Postbox ответил ошибкой (см. ответ выше). Частая причина — адрес отправителя SMTP_FROM на домене, который не подтверждён в Postbox (запись DKIM в DNS), или адрес получателя отклонён.'
  if (['ETIMEDOUT', 'ECONNECTION'].includes(code) && !tcp) return 'Не удалось связаться с Postbox (проверьте POSTBOX_ENDPOINT и доступ сервера в интернет по HTTPS).'
  if (code === 'EAUTH' || /535|Username and Password not accepted|Invalid login/i.test(err?.response || err?.message || '')) {
    return 'Gmail не принял логин/пароль. Проверьте SMTP_USER (ящик, для которого создан пароль приложения) и SMTP_PASS: это «пароль приложения» Google (16 букв, создаётся при включённой двухэтапной проверке), а не обычный пароль от почты. Лишних пробелов и кавычек быть не должно.'
  }
  if (tcp && !tcp.ok) {
    return `Сервер не может подключиться к SMTP-порту (${tcp.error}). Похоже, хостинг блокирует исходящую почту на этом порту: напишите в поддержку Timeweb, попробуйте SMTP_PORT=587 или другой способ отправки.`
  }
  if (['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'ECONNREFUSED'].includes(code)) {
    return 'Соединение с почтовым сервером оборвалось или не установилось. Проверьте SMTP_HOST и SMTP_PORT (для Gmail: smtp.gmail.com и 465).'
  }
  return 'Неизвестная ошибка отправки — приложите вывод выше, когда будете обращаться за помощью.'
}

/** Вынесено ради теста. Получатель обязан быть сотрудником CRM. */
export async function sendTestMail(db, mailer, toRaw) {
  const to = String(toRaw || '').trim().toLowerCase()
  if (!mailer.configured) return { error: 'not_configured' }
  if (!(await db.prepare('SELECT 1 FROM users WHERE email = ?').get(to))) return { error: 'not_staff' }
  try {
    await mailer.send({
      to,
      subject: 'Невариум CRM — проверка почты',
      text: 'Это тестовое письмо Невариум CRM. Если вы его читаете — отправка служебных писем (восстановление пароля, смена email) работает.',
    })
    return { ok: true }
  } catch (err) {
    return { error: 'send_failed', err }
  }
}

const isMain = import.meta.main ?? process.argv[1]?.endsWith('test-mail.js')

if (isMain) {
  const cfg = describeMailConfig()
  console.log('Настройки почты (пароль и ключ не показываются):')
  if (cfg.mode === 'postbox') {
    console.log('  Способ: Yandex Cloud Postbox по HTTPS')
    console.log(`  POSTBOX_KEY_ID: ${cfg.keyIdSet ? 'задан' : '— не задан'}`)
    console.log(`  POSTBOX_SECRET_KEY: ${cfg.secretSet ? `задан, ${cfg.secretLength} симв.` : '— не задан'}`)
    console.log(`  SMTP_FROM: ${cfg.from || '— не задан'}`)
  } else {
    console.log('  Способ: SMTP')
    console.log(`  SMTP_HOST: ${cfg.host || '— не задан'}`)
    console.log(`  SMTP_PORT: ${cfg.port}`)
    console.log(`  SMTP_USER: ${cfg.user || '— не задан'}`)
    console.log(`  SMTP_FROM: ${cfg.from || '— не задан'}`)
    console.log(`  SMTP_PASS: ${cfg.passSet ? `задан, ${cfg.passLength} симв.${cfg.passHasSpaces ? ' (ЕСТЬ ПРОБЕЛЫ — уберите)' : ''}` : '— не задан'}`)
  }
  const mailer = createMailer()
  if (!mailer.configured) {
    console.error(cfg.mode === 'postbox'
      ? '\nПочта не настроена: для Postbox нужны POSTBOX_KEY_ID, POSTBOX_SECRET_KEY и SMTP_FROM — адрес отправителя на подтверждённом домене.'
      : '\nПочта не настроена: нужны SMTP_HOST, SMTP_USER, SMTP_PASS (и SMTP_FROM либо он возьмётся из SMTP_USER) — либо POSTBOX_KEY_ID, POSTBOX_SECRET_KEY и SMTP_FROM.')
    process.exit(1)
  }
  let tcp = null
  if (cfg.mode === 'smtp') {
    tcp = await checkTcp(cfg.host, cfg.port)
    console.log(`\nСоединение с ${cfg.host}:${cfg.port}: ${tcp.ok ? `есть (${tcp.ms} мс)` : `НЕТ — ${tcp.error}`}`)
  }

  const db = await openDb(process.env.DATABASE_URL)
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  let code = 0
  try {
    const first = await db.prepare("SELECT email FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get()
    const answer = (await rl.question(`Кому отправить тестовое письмо (email сотрудника) [${first?.email || ''}]: `)).trim()
    const res = await sendTestMail(db, mailer, answer || first?.email)
    if (res.ok) console.log('\nГотово: письмо отправлено. Проверьте ящик (и папку «Спам»).')
    else if (res.error === 'not_staff') { console.error('\nТакого сотрудника в CRM нет. Письма уходят только сотрудникам — ничего не отправлено.'); code = 1 }
    else {
      code = 1
      console.error('\nОтправка не удалась.')
      console.error(`  код: ${res.err?.code || '—'}`)
      console.error(`  ответ сервера: ${res.err?.response || res.err?.message || '—'}`)
      console.error(`\nЧто это значит: ${explainMailError(res.err, tcp)}`)
    }
  } finally {
    rl.close()
    await db.pool?.end?.()
  }
  process.exit(code)
}
