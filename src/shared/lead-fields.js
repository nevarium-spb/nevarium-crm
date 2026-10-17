// Поля заявки с сайта Визора: тариф и куда прислать счёт (задание сайта 2026-10-16, часть А).
// Общий для сервера (приём /api/leads, правка сделки) и интерфейса (подписи, фильтр).
// Названия тарифов — из server/shared/plans.js (копия общего файла цен сайта, руками не править).
import { PLANS } from '../../server/shared/plans.js'

/** Коды тарифа в заявке: контракт docs/SUBSCRIPTIONS.md сайта, раздел 2, плюс free и unknown. */
export const LEAD_PLANS = ['unknown', 'free', 'stage', 'repair', 'house', 'monthly', 'company']

export const INVOICE_CHANNELS = ['email', 'telegram', 'max', 'whatsapp']
export const INVOICE_CHANNEL_LABEL = { email: 'Почта', telegram: 'Telegram', max: 'MAX', whatsapp: 'WhatsApp' }
export const INVOICE_CONTACT_MAX = 120

/** «Ремонт под контролем», «Free», «не выбран»; пустая строка — тариф не приходил. */
export function leadPlanTitle(code) {
  if (!code) return ''
  if (code === 'unknown') return 'не выбран'
  if (code === 'free') return 'Free'
  return PLANS[code]?.title || code
}

/**
 * Тариф из заявки. Незнакомый код — не отказ (заявку не отвергаем), а `unknown` + warn
 * для лога. Поле не пришло — пустая строка: заявка старого клиента сайта или из чата.
 */
export function normalizeLeadPlan(raw) {
  if (raw === undefined || raw === null || raw === '') return { plan: '' }
  const code = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (LEAD_PLANS.includes(code)) return { plan: code }
  return { plan: 'unknown', warn: String(raw).slice(0, 40) }
}

/**
 * Куда прислать счёт. Сайт уже проверил и нормализовал; здесь только канал из списка
 * (иначе поле игнорируется + warn) и потолок длины. Почта — в нижнем регистре.
 */
export function normalizeInvoice(channelRaw, contactRaw) {
  const hasAny = (channelRaw ?? '') !== '' || (contactRaw ?? '') !== ''
  if (!hasAny) return { channel: '', contact: '' }
  const channel = typeof channelRaw === 'string' ? channelRaw.trim().toLowerCase() : ''
  const contactIn = typeof contactRaw === 'string' ? contactRaw.trim().slice(0, INVOICE_CONTACT_MAX) : ''
  if (!INVOICE_CHANNELS.includes(channel) || !contactIn) {
    return { channel: '', contact: '', warn: INVOICE_CHANNELS.includes(channel) ? 'empty_contact' : String(channelRaw ?? '').slice(0, 40) }
  }
  return { channel, contact: channel === 'email' ? contactIn.toLowerCase() : contactIn }
}

/** «Telegram: @nick» / «MAX: +7…» / «WhatsApp: +7…» — формат поля «Мессенджер» контакта. */
export function invoiceMessengerValue(channel, contact) {
  return channel && channel !== 'email' && contact ? `${INVOICE_CHANNEL_LABEL[channel]}: ${contact}` : ''
}

/** «Telegram @nick» — для карточки и строки в истории. */
export function invoiceLabel(channel, contact) {
  return channel && contact ? `${INVOICE_CHANNEL_LABEL[channel] || channel} ${contact}` : ''
}
