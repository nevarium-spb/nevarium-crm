// Режим «приём закрыт» (ADR-026): пока три проекта (сайт, CRM, NVizor) не выложены вместе, в боевую CRM не должны
// попадать данные настоящих людей — иначе обработка ПДн уже идёт, а уведомление в РКН ещё не подано.
// INTAKE_MODE=closed — публичный приём (заявки, запросы по ПДн, фото заявок, загрузки клиента) принимает ТОЛЬКО запросы
// с доменов из INTAKE_ALLOWED_ORIGINS (стендовые сайты); остальным — 403 intake_closed, ничего не сохраняется.
// Вход сотрудников, кабинет клиента по ключу и маршруты NVizor режим не трогает.

/** Маршруты (шаблоны Fastify), которыми данные людей попадают в CRM. Новый публичный маршрут приёма — допиши сюда. */
export const INTAKE_ROUTES = new Set([
  '/api/leads',
  '/api/pd-requests',
  '/api/leads/:requestId/photos',
  '/api/client/upload/:id/photos',
  '/api/client/upload/:id/video-url',
  '/api/client/upload/:id/video-done',
])

const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/

const normalizeOrigin = (s) => String(s || '').trim().toLowerCase().replace(/\/+$/, '')

/**
 * «origin» или «origin=slug» через запятую → [{ origin, project }]. project — slug проекта, к которому относить заявки
 * с этого домена (как projects.origins); без него — проект по полю формы/по умолчанию. Кривая запись — ошибка запуска:
 * молча пропущенный домен стенда выглядел бы как «сайт не отправляет заявки».
 */
export function parseAllowedOrigins(raw) {
  const out = []
  for (const part of String(raw || '').split(',')) {
    const item = part.trim()
    if (!item) continue
    const [originRaw, slugRaw = ''] = item.split('=')
    const origin = normalizeOrigin(originRaw)
    if (!ORIGIN_RE.test(origin)) throw new Error(`INTAKE_ALLOWED_ORIGINS: «${item.slice(0, 80)}» — ожидается https://домен (без пути), при необходимости =slug проекта`)
    out.push({ origin, project: slugRaw.trim() || null })
  }
  return out
}

/** Режим из окружения. Пусто/open — открыт; closed — закрыт; любое другое значение — ошибка запуска (опечатка не должна молча открыть приём). */
export function parseIntakeMode(raw) {
  const v = String(raw ?? '').trim().toLowerCase()
  if (v === '' || v === 'open') return 'open'
  if (v === 'closed') return 'closed'
  throw new Error(`INTAKE_MODE: «${v.slice(0, 40)}» — допустимо только closed или пусто`)
}

export function createIntake({ mode, allowedRaw, devLocalhost = false } = {}) {
  const closed = parseIntakeMode(mode) === 'closed'
  const allowed = parseAllowedOrigins(allowedRaw)
  const byOrigin = new Map(allowed.map((a) => [a.origin, a]))
  const state = { refused: 0, lastRefused: null }

  return {
    closed,
    allowed,
    /** Запись о домене стенда (для CORS и проекта) — только в закрытом режиме; в открытом список не действует. */
    originEntry: (origin) => (closed ? byOrigin.get(normalizeOrigin(origin)) || null : null),
    /** Можно ли принимать данные с этого Origin. Открытый режим — всегда да. Без Origin в закрытом — нет. */
    accepts(origin) {
      if (!closed) return true
      const o = normalizeOrigin(origin)
      if (!o) return false
      if (devLocalhost && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) return true
      return byOrigin.has(o)
    },
    noteRefused(origin, at) {
      state.refused += 1
      state.lastRefused = { at, origin: String(origin || '').slice(0, 100) || null }
    },
    status: () => ({
      closed,
      allowedOrigins: allowed,
      refused: state.refused,
      lastRefused: state.lastRefused,
    }),
  }
}
