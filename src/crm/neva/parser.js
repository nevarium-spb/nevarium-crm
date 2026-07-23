import { extractRuDate } from './ruDates.js'

// Чистая функция: строка → intent | null. Ничего не пишет — только предлагает.
// Грамматика (нормативная, см. docs/designs/nevarium-crm.md):
//  1. лид <Имя>[, <компания>][, <телефон|email>]
//  2. задача: <текст>[ — <контакт>][ <дата>]
//  3. звонок|встреча|письмо|сообщение с <Имя>[: <заметка>]
const PHONE_RE = /^\+?[\d\s()-]{6,}$/
const INTERACTION_RE = /^(звонок|встреча|письмо|сообщение)\s+(?:с|со)\s+([^:]+?)(?:\s*:\s*(.+))?$/iu

export function parseCommand(input, { contacts = [], nowMs = Date.now() } = {}) {
  const text = input.trim()
  if (!text) return null

  // 1) лид — только слово целиком («Лидия» не должна срабатывать)
  const leadMatch = text.match(/^лид\s+(.+)$/iu)
  if (leadMatch) {
    const parts = leadMatch[1].split(',').map((p) => p.trim()).filter(Boolean)
    if (!parts.length) return null
    const intent = { kind: 'lead', name: parts[0], company: '', phone: '', email: '' }
    for (const part of parts.slice(1)) {
      if (PHONE_RE.test(part)) intent.phone = part
      else if (part.includes('@')) intent.email = part
      else if (!intent.company) intent.company = part
    }
    return intent
  }

  // 2) задача:
  const taskMatch = text.match(/^задача\s*:\s*(.+)$/iu)
  if (taskMatch) {
    let body = taskMatch[1].trim()
    let due = null
    const dated = extractRuDate(body, nowMs)
    if (dated) {
      due = dated.date
      body = dated.rest
    }
    let contact = null
    const dashMatch = body.match(/^(.*?)\s+[—-]\s+(.+)$/u)
    if (dashMatch) {
      const candidate = matchContact(dashMatch[2], contacts)
      if (candidate) {
        contact = candidate
        body = dashMatch[1].trim()
      }
    }
    if (!contact) {
      // fuzzy-поиск имени контакта внутри текста — по основе любого слова имени
      outer: for (const c of contacts) {
        for (const stem of nameStems(c.name)) {
          if (stem && new RegExp(`(^|\\s)${escapeRe(stem)}[а-яё]*`, 'iu').test(body)) {
            contact = c
            break outer
          }
        }
      }
    }
    if (!body) return null
    return { kind: 'task', title: body, dueDate: due, contact }
  }

  // 3) взаимодействие
  const im = text.match(INTERACTION_RE)
  if (im) {
    const contact = matchContact(im[2].trim(), contacts)
    if (!contact) return { kind: 'interaction-unmatched', type: im[1].toLowerCase(), rawName: im[2].trim(), note: im[3]?.trim() || '' }
    return { kind: 'interaction', type: im[1].toLowerCase(), contact, note: im[3]?.trim() || '' }
  }

  return null
}

// Терпимость к склонениям: сравниваем основы (обрезаем окончание до 2 букв)
// для КАЖДОГО слова имени — «Ивановым» должно найти «Дмитрий Иванов».
function stemWord(word) {
  if (!word || word.length < 3) return word || ''
  return word.length <= 5 ? word.slice(0, -1) : word.slice(0, -2)
}

function nameStems(name) {
  return (name || '').split(/\s+/).filter((w) => w.length >= 3).map(stemWord)
}

function matchContact(raw, contacts) {
  const norm = raw.toLowerCase().trim()
  if (!norm) return null
  // точное вхождение имени или компании
  for (const c of contacts) {
    if (c.name.toLowerCase() === norm || (c.company && c.company.toLowerCase() === norm)) return c
  }
  // по основам слов (Иванов ~ Ивановым, Марина ~ Мариной)
  const rawStems = norm.split(/\s+/).map((w) => stemWord(w.replace(/[а-яё]{1,2}$/u, '')))
  for (const c of contacts) {
    for (const stem of nameStems(c.name)) {
      const s = stem.toLowerCase()
      if (s && rawStems.some((r) => r && (r.startsWith(s) || s.startsWith(r)))) return c
    }
  }
  // подстрока
  for (const c of contacts) {
    if (c.name.toLowerCase().includes(norm)) return c
  }
  return null
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
