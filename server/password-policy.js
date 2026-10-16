// Правила для НОВОГО пароля сотрудника (ADR-020): смена в профиле и восстановление по почте.
// Минимум 12 символов (решение владельца 2026-10-15) + проверка по ЛОКАЛЬНОМУ списку
// распространённых паролей (server/common-passwords.txt, без запросов во внешние сервисы).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const MIN_ACCOUNT_PASSWORD_LENGTH = 12
export const MAX_ACCOUNT_PASSWORD_LENGTH = 200

const here = path.dirname(fileURLToPath(import.meta.url))
let common = null
function commonSet() {
  if (!common) {
    const text = fs.readFileSync(path.join(here, 'common-passwords.txt'), 'utf8')
    common = new Set(text.split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')))
  }
  return common
}

const TRAILING = /[\d\p{P}\p{S}\s]+$/u
const LEADING = /^[\d\p{P}\p{S}\s]+/u

/** Пароль из списка распространённых — сам по себе или без цифр/знаков в начале и в конце. */
export function isCommonPassword(password) {
  const set = commonSet()
  const p = String(password).toLowerCase().normalize('NFC')
  if (set.has(p)) return true
  const noTail = p.replace(TRAILING, '')
  if (noTail.length >= 4 && set.has(noTail)) return true
  const core = noTail.replace(LEADING, '')
  return core.length >= 4 && set.has(core)
}

/**
 * null — пароль годится; иначе причина: too_short | too_long | repetitive | personal | common.
 * `email`/`name` — данные самой учётной записи: пароль, из них составленный, отклоняется.
 */
export function checkNewPassword(password, { email = '', name = '' } = {}) {
  if (typeof password !== 'string') return 'too_short'
  const chars = [...password]
  if (chars.length < MIN_ACCOUNT_PASSWORD_LENGTH) return 'too_short'
  if (chars.length > MAX_ACCOUNT_PASSWORD_LENGTH) return 'too_long'
  if (new Set(chars).size <= 2) return 'repetitive'
  const low = password.toLowerCase()
  const local = String(email).split('@')[0].toLowerCase()
  if (local.length >= 4 && low.includes(local)) return 'personal'
  const first = String(name).trim().toLowerCase()
  if (first.length >= 4 && low.includes(first)) return 'personal'
  if (isCommonPassword(password)) return 'common'
  return null
}

export const PASSWORD_REASON_TEXT = {
  too_short: `Минимум ${MIN_ACCOUNT_PASSWORD_LENGTH} символов.`,
  too_long: 'Слишком длинный пароль.',
  repetitive: 'Пароль слишком однообразный.',
  personal: 'Пароль содержит ваш email или имя.',
  common: 'Это слишком распространённый пароль — выберите другой.',
}
