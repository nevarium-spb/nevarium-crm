// Отправка СЛУЖЕБНЫХ писем сотрудникам CRM (ADR-020): восстановление пароля, смена email,
// уведомление о смене пароля. Это единственное, для чего почта используется.
//
// ОГРАНИЧЕНИЕ (152-ФЗ, политика ПДн): канал — Gmail, зарубежный сервис, а политика обещает
// клиентам, что их данные не покидают Россию. Поэтому ЗДЕСЬ — никаких писем клиентам и никаких
// данных клиентов: в тексты шаблонов (server/account.js) они не попадают, а получатель
// проверяется там же (только адрес существующего сотрудника или подтверждаемый им новый).
//
// SMTP — только из переменных окружения (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS,
// SMTP_FROM); не в репозитории и не в логах. Не настроено — configured=false, а формы
// честно пишут, что восстановление по почте недоступно.
import nodemailer from 'nodemailer'

export function createMailer(env = process.env) {
  const host = String(env.SMTP_HOST || '').trim()
  const user = String(env.SMTP_USER || '').trim()
  const pass = String(env.SMTP_PASS || '')
  const port = Number(env.SMTP_PORT) || 465
  const from = String(env.SMTP_FROM || user).trim()
  const configured = Boolean(host && user && pass && from)
  let transport = null
  return {
    configured,
    /** Только простой текст; адресат — одна почта. Ошибки наружу без пароля и адреса. */
    async send({ to, subject, text }) {
      if (!configured) throw new Error('smtp_not_configured')
      if (typeof to !== 'string' || !/^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(to)) throw new Error('bad_recipient')
      transport ??= nodemailer.createTransport({
        host, port, secure: port === 465, auth: { user, pass },
        connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
      })
      await transport.sendMail({ from, to, subject, text })
    },
  }
}
