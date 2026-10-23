// Источник посетителя и заявки (ADR-027): откуда человек пришёл на сайт. Общий для сервера (заявки, счётчик посещений)
// и интерфейса (подписи каналов). Только адрес сайта-источника и метки ссылок (utm) — ни IP, ни cookie, ни адресов страниц
// с параметрами: ничего, что указывало бы на конкретного человека.

/** Каналы по порядку показа. Код хранится в базе, подпись — только здесь. */
export const CHANNELS = {
  search: 'Поиск',
  ads: 'Реклама',
  telegram: 'Telegram',
  max: 'MAX',
  whatsapp: 'WhatsApp',
  vk: 'ВКонтакте',
  avito: 'Авито',
  referral: 'Другие сайты',
  direct: 'Прямой заход',
  other: 'Другое (по метке)',
}
export const CHANNEL_CODES = Object.keys(CHANNELS)
export const channelTitle = (code) => CHANNELS[code] || 'Не указан'

const TAG_MAX = 64
const PATH_MAX = 120

/** Метка utm: строчные буквы, цифры, «_-.+» и пробел, до 64 символов. Всё прочее выбрасывается — метка не место для ПДн. */
export function cleanTag(v) {
  if (typeof v !== 'string') return ''
  return v.trim().toLowerCase().replace(/[^\p{L}\p{N}_.+\- ]/gu, '').replace(/\s+/g, ' ').trim().slice(0, TAG_MAX)
}

/** Сайт-источник: только домен (без пути и параметров), без «www.». Принимает адрес целиком или домен. */
export function cleanHost(v) {
  if (typeof v !== 'string' || !v.trim()) return ''
  let host = v.trim().toLowerCase()
  try { if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) host = new URL(host).hostname } catch { return '' }
  host = host.replace(/^www\./, '').replace(/\.$/, '')
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && host.length <= 100 ? host : ''
}

/**
 * Страница сайта: путь без параметров. Маршрут после «#» (сайт Визора) сохраняется, но личная ссылка кабинета `#/c/<ключ>`
 * обрезается до `#/c` — ключ даёт доступ к кабинету клиента и не должен оседать нигде.
 */
export function cleanPath(v) {
  if (typeof v !== 'string') return ''
  let s = v.trim()
  if (!s.startsWith('/')) return ''
  const hashAt = s.indexOf('#')
  const path = (hashAt >= 0 ? s.slice(0, hashAt) : s).split('?')[0]
  let hash = hashAt >= 0 ? s.slice(hashAt).split('?')[0] : ''
  if (/^#\/c(\/|$)/.test(hash)) hash = '#/c'
  if (hash === '#' || hash === '#/') hash = ''
  s = (path || '/') + hash
  s = s.replace(/[^\p{L}\p{N}/_.~#-]/gu, '')
  return s.slice(0, PATH_MAX) || '/'
}

const has = (s, ...words) => words.some((w) => s.includes(w))

/** Канал по меткам и сайту-источнику. Метки важнее сайта: ссылку с меткой ставили вы сами. */
export function channelOf({ utm_source = '', utm_medium = '', ref_host = '' } = {}) {
  const src = utm_source
  const med = utm_medium
  if (has(med, 'cpc', 'ppc', 'paid', 'cpm', 'ads', 'реклама') || has(src, 'yandex_direct', 'direct.yandex', 'ydirect')) return 'ads'
  const byName = (s) => {
    if (!s) return ''
    if (s === 'tg' || has(s, 'telegram', 't.me')) return 'telegram'
    if (s === 'max' || has(s, 'max.ru', 'max_messenger')) return 'max'
    if (has(s, 'whatsapp', 'wa.me')) return 'whatsapp'
    if (s === 'vk' || has(s, 'vk.com', 'vk.ru', 'vkontakte')) return 'vk'
    if (has(s, 'avito')) return 'avito'
    if (has(s, 'yandex', 'google', 'bing', 'duckduckgo', 'go.mail.ru', 'search', 'ya.ru')) return 'search'
    return ''
  }
  const byTag = byName(src)
  if (byTag) return byTag
  if (src) return 'other'
  const byRef = byName(ref_host)
  if (byRef) return byRef
  return ref_host ? 'referral' : 'direct'
}

/**
 * Источник из заявки или посещения → чистые поля. `raw` — объект, который собирает скрипт счётчика
 * (`window.nvAttribution()`): { utm_source, utm_medium, utm_campaign, ref_host, landing }.
 * Ничего не пришло — канал пустой («не указан»), а не «прямой заход»: старая версия сайта источник не передаёт.
 */
export function normalizeAttribution(raw) {
  const empty = { channel: '', utm_source: '', utm_medium: '', utm_campaign: '', ref_host: '', landing: '' }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty
  const a = {
    utm_source: cleanTag(raw.utm_source),
    utm_medium: cleanTag(raw.utm_medium),
    utm_campaign: cleanTag(raw.utm_campaign),
    ref_host: cleanHost(raw.ref_host),
    landing: cleanPath(raw.landing),
  }
  return { channel: channelOf(a), ...a }
}
