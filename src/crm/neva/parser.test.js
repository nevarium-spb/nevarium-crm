// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseCommand } from './parser.js'
import { extractRuDate, mskToday } from './ruDates.js'

// фиксированное «сейчас»: четверг 9 июля 2026, 12:00 МСК
const NOW = new Date('2026-07-09T09:00:00Z').getTime()

const CONTACTS = [
  { id: 1, name: 'Дмитрий Иванов', company: '«Балтика-Транс»' },
  { id: 2, name: 'Марина Соколова', company: 'ООО «Северный свет»' },
  { id: 3, name: 'Лидия Петрова', company: '' },
]

describe('parseCommand: лид', () => {
  it('разбирает имя, компанию, телефон и email', () => {
    const i = parseCommand('лид Марина, Северный свет, +7 921 555-14-88', { nowMs: NOW })
    expect(i).toMatchObject({ kind: 'lead', name: 'Марина', company: 'Северный свет', phone: '+7 921 555-14-88' })
    const j = parseCommand('лид Пётр, m@x.ru', { nowMs: NOW })
    expect(j).toMatchObject({ kind: 'lead', name: 'Пётр', email: 'm@x.ru', company: '' })
  })

  it('регистронезависим и требует слово целиком', () => {
    expect(parseCommand('ЛИД Анна', { nowMs: NOW })).toMatchObject({ kind: 'lead', name: 'Анна' })
    // «Лидия» — это поиск, не команда
    expect(parseCommand('Лидия', { contacts: CONTACTS, nowMs: NOW })).toBeNull()
    expect(parseCommand('лидер рынка', { nowMs: NOW })).toBeNull()
  })
})

describe('parseCommand: задача', () => {
  it('находит контакт и дату', () => {
    const i = parseCommand('задача: позвонить Иванову в пятницу', { contacts: CONTACTS, nowMs: NOW })
    expect(i.kind).toBe('task')
    expect(i.contact?.id).toBe(1)
    expect(i.dueDate).toBe('2026-07-10') // ближайшая пятница
    expect(i.title).toContain('позвонить')
  })

  it('работает без контакта и без даты', () => {
    const i = parseCommand('задача: подготовить отчёт', { contacts: CONTACTS, nowMs: NOW })
    expect(i).toMatchObject({ kind: 'task', title: 'подготовить отчёт', dueDate: null, contact: null })
  })

  it('контакт через тире', () => {
    const i = parseCommand('задача: отправить КП — Марина Соколова завтра', { contacts: CONTACTS, nowMs: NOW })
    expect(i.contact?.id).toBe(2)
    expect(i.dueDate).toBe(mskToday(1, NOW))
  })
})

describe('parseCommand: взаимодействия', () => {
  it('склонение имени: «с Ивановым»', () => {
    const i = parseCommand('звонок с Ивановым: обсудили пилот', { contacts: CONTACTS, nowMs: NOW })
    expect(i).toMatchObject({ kind: 'interaction', type: 'звонок', note: 'обсудили пилот' })
    expect(i.contact.id).toBe(1)
  })

  it('все четыре типа', () => {
    for (const t of ['звонок', 'встреча', 'письмо', 'сообщение']) {
      expect(parseCommand(`${t} с Мариной`, { contacts: CONTACTS, nowMs: NOW })?.type).toBe(t)
    }
  })

  it('неизвестный контакт → interaction-unmatched (фолбэк на форму)', () => {
    const i = parseCommand('звонок с Козловым: тест', { contacts: CONTACTS, nowMs: NOW })
    expect(i.kind).toBe('interaction-unmatched')
    expect(i.rawName).toBe('Козловым')
  })
})

describe('extractRuDate', () => {
  it('сегодня/завтра/послезавтра', () => {
    expect(extractRuDate('сделать сегодня', NOW)?.date).toBe(mskToday(0, NOW))
    expect(extractRuDate('сделать завтра', NOW)?.date).toBe(mskToday(1, NOW))
    expect(extractRuDate('послезавтра демо', NOW)?.date).toBe(mskToday(2, NOW))
  })

  it('день недели — следующее вхождение, сегодняшний день исключён', () => {
    // NOW — четверг; «в четверг» = через неделю
    expect(extractRuDate('созвон в четверг', NOW)?.date).toBe(mskToday(7, NOW))
    expect(extractRuDate('созвон в пятницу', NOW)?.date).toBe(mskToday(1, NOW))
    expect(extractRuDate('созвон в среду', NOW)?.date).toBe(mskToday(6, NOW))
  })

  it('DD.MM и DD.MM.YYYY; прошедшая дата уходит на следующий год', () => {
    expect(extractRuDate('оплата 15.08', NOW)?.date).toBe('2026-08-15')
    expect(extractRuDate('оплата 15.01', NOW)?.date).toBe('2027-01-15')
    expect(extractRuDate('оплата 15.01.2026', NOW)?.date).toBe('2026-01-15')
  })

  it('нераспознанное остаётся текстом', () => {
    expect(extractRuDate('когда-нибудь потом', NOW)).toBeNull()
  })

  it('вырезает дату из текста', () => {
    expect(extractRuDate('позвонить завтра клиенту', NOW)?.rest).toBe('позвонить клиенту')
  })
})
