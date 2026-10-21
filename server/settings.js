// Настройки CRM (ADR-020): таблица `settings` (ключ → значение JSON), значения по
// умолчанию равны прежним константам кода — пустая таблица ведёт себя, как раньше.
// Секретов здесь нет и быть не должно (SMTP и ключи — только переменные окружения).
//
// Ключи плоские — так их проще писать в журнал «было → стало» и класть в дамп:
//   notify.telegram / notify.max          — канал уведомлений включён (true/false)
//   reminder_days.<тариф>                 — за сколько дней напоминать о конце срока
//   free_link_days                        — срок личной ссылки кабинета Free, дней

import { PLANS } from './shared/plans.js'

/** Тарифы, у которых бывает срок, — для них настраивается напоминание (у `recheck` срока нет). */
export const REMINDER_PLANS = Object.keys(PLANS).filter((p) => p !== 'recheck')

export const DEFAULTS = {
  'notify.telegram': true,
  'notify.max': true,
  // Письма КЛИЕНТАМ (ADR-025) — ВЫКЛЮЧЕНЫ, пока сайт не подтвердит, что новая политика ПДн выложена; включает владелец.
  'client_mail.enabled': false,
  'reminder_days.stage': 30,
  'reminder_days.repair': 30,
  'reminder_days.house': 30,
  'reminder_days.monthly': 7,
  'reminder_days.company': 7,
  free_link_days: 7,
}

const RANGES = { reminder_days: [1, 365], free_link_days: [1, 90] }

/** Проверка одного значения: возвращает приведённое значение или `undefined`, если оно недопустимо. */
export function normalizeSetting(key, value) {
  if (!(key in DEFAULTS)) return undefined
  if (key.startsWith('notify.') || key.startsWith('client_mail.')) return typeof value === 'boolean' ? value : undefined
  const [min, max] = key.startsWith('reminder_days.') ? RANGES.reminder_days : RANGES[key]
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined
}

/** Все настройки с учётом умолчаний. `runner` — db или tx. */
export async function loadSettings(runner) {
  const out = { ...DEFAULTS }
  const rows = await runner.prepare('SELECT key, value FROM settings').all()
  for (const r of rows) {
    if (!(r.key in DEFAULTS)) continue
    let v
    try { v = JSON.parse(r.value) } catch { continue }
    const ok = normalizeSetting(r.key, v)
    if (ok !== undefined) out[r.key] = ok
  }
  return out
}

/** То же, но без падения: для горячих путей (очередь уведомлений), где сбой чтения не должен их останавливать. */
export async function loadSettingsSafe(runner) {
  try { return await loadSettings(runner) } catch { return { ...DEFAULTS } }
}

/** Настройки в виде, который отдаёт API и принимает форма. */
export function settingsView(s) {
  return {
    notify: { telegram: s['notify.telegram'], max: s['notify.max'] },
    clientMail: { enabled: s['client_mail.enabled'] },
    reminderDays: Object.fromEntries(REMINDER_PLANS.map((p) => [p, s[`reminder_days.${p}`]])),
    freeLinkDays: s.free_link_days,
  }
}

/**
 * Разбор тела PATCH /api/crm/settings → плоские изменения. Неизвестные поля и
 * недопустимые значения — ошибка целиком (частичная запись молча была бы хуже).
 */
export function parseSettingsPatch(body) {
  const changes = {}
  const bad = () => ({ error: 'bad_input' })
  const b = body && typeof body === 'object' ? body : {}
  if (b.notify !== undefined) {
    if (!b.notify || typeof b.notify !== 'object') return bad()
    for (const [ch, v] of Object.entries(b.notify)) {
      const key = `notify.${ch}`
      if (normalizeSetting(key, v) === undefined) return bad()
      changes[key] = v
    }
  }
  if (b.clientMail !== undefined) {
    if (!b.clientMail || typeof b.clientMail !== 'object') return bad()
    for (const [k, v] of Object.entries(b.clientMail)) {
      const key = `client_mail.${k}`
      if (normalizeSetting(key, v) === undefined) return bad()
      changes[key] = v
    }
  }
  if (b.reminderDays !== undefined) {
    if (!b.reminderDays || typeof b.reminderDays !== 'object') return bad()
    for (const [plan, v] of Object.entries(b.reminderDays)) {
      const key = `reminder_days.${plan}`
      const n = normalizeSetting(key, v)
      if (n === undefined) return bad()
      changes[key] = n
    }
  }
  if (b.freeLinkDays !== undefined) {
    const n = normalizeSetting('free_link_days', b.freeLinkDays)
    if (n === undefined) return bad()
    changes.free_link_days = n
  }
  if (!Object.keys(changes).length) return { error: 'nothing_to_update' }
  return { changes }
}
