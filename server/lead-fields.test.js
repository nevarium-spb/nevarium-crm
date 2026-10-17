// @vitest-environment node
// Тариф и контакт для счёта в заявке сайта Визора (задание сайта 2026-10-16, часть А).
import { newDb } from 'pg-mem'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { hashPassword, resetThrottle } from './auth.js'
import { now } from './db.js'
import { leadMessage } from './telegram.js'
import { PLANS } from './shared/plans.js'
import { LEAD_PLANS, normalizeLeadPlan, normalizeInvoice, invoiceMessengerValue, leadPlanTitle } from '../src/shared/lead-fields.js'

let app, cookie

beforeEach(async () => {
  resetThrottle()
  const pool = new (newDb().adapters.createPg()).Pool()
  app = await buildApp({ dbConfig: pool, secure: false })
  await app.db.prepare('INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)')
    .run('Владелец', 'owner@example.ru', await hashPassword('password123'), 'admin', now())
  await app.ready()
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@example.ru', password: 'password123' } })
  cookie = res.headers['set-cookie']
})
afterEach(async () => { await app?.close?.() })

const crm = (method, url, payload) => app.inject({ method, url, payload, headers: { cookie } })
const lead = (body) => app.inject({ method: 'POST', url: '/api/leads', payload: { project: 'nevarium-vizor', name: 'Иван', contact: '+79001234567', task: 'Проверка ремонта', ...body } })
const one = (sql, ...a) => app.db.prepare(sql).get(...a)

describe('поля заявки: нормализация (src/shared/lead-fields.js)', () => {
  it('коды тарифа — из общего файла цен плюс free/unknown; незнакомый — unknown с предупреждением', () => {
    for (const code of LEAD_PLANS.filter((c) => !['free', 'unknown'].includes(c))) expect(PLANS[code], code).toBeTruthy()
    expect(normalizeLeadPlan(undefined)).toEqual({ plan: '' })
    expect(normalizeLeadPlan(' Repair ')).toEqual({ plan: 'repair' })
    expect(normalizeLeadPlan('free')).toEqual({ plan: 'free' })
    expect(normalizeLeadPlan('vip')).toEqual({ plan: 'unknown', warn: 'vip' })
    expect(normalizeLeadPlan({ x: 1 })).toMatchObject({ plan: 'unknown' })
    expect(leadPlanTitle('repair')).toBe('Ремонт под контролем')
    expect(leadPlanTitle('unknown')).toBe('не выбран')
  })

  it('канал — только из списка, почта в нижнем регистре, длина до 120', () => {
    expect(normalizeInvoice(undefined, undefined)).toEqual({ channel: '', contact: '' })
    expect(normalizeInvoice('email', ' Ivan@Example.RU ')).toEqual({ channel: 'email', contact: 'ivan@example.ru' })
    expect(normalizeInvoice('pigeon', '@x')).toMatchObject({ channel: '', contact: '', warn: 'pigeon' })
    expect(normalizeInvoice('telegram', '')).toMatchObject({ channel: '', warn: 'empty_contact' })
    expect(normalizeInvoice('telegram', '@' + 'a'.repeat(300)).contact).toHaveLength(120)
    expect(invoiceMessengerValue('telegram', '@ivan')).toBe('Telegram: @ivan')
    expect(invoiceMessengerValue('max', '+79001234567')).toBe('MAX: +79001234567')
    expect(invoiceMessengerValue('email', 'a@b.ru')).toBe('')
  })
})

describe('приём заявки с тарифом и контактом для счёта', () => {
  it('новый клиент: тариф и счёт — в сделке, мессенджер для счёта — в пустое поле карточки', async () => {
    expect((await lead({ plan: 'repair', invoice_channel: 'telegram', invoice_contact: '@ivan_test' })).statusCode).toBe(204)
    const deal = await one('SELECT * FROM deals')
    expect(deal).toMatchObject({ plan: 'repair', invoice_channel: 'telegram', invoice_contact: '@ivan_test' })
    expect(deal.note).not.toContain('Счёт')
    const c = await one('SELECT * FROM contacts')
    expect(c).toMatchObject({ phone: '+79001234567', messenger: 'Telegram: @ivan_test', email: '' })
  })

  it('счёт на почту — в пустой email карточки', async () => {
    await lead({ plan: 'stage', invoice_channel: 'email', invoice_contact: 'Ivan@Example.ru' })
    expect((await one('SELECT email FROM contacts')).email).toBe('ivan@example.ru')
    expect((await one('SELECT invoice_contact FROM deals')).invoice_contact).toBe('ivan@example.ru')
  })

  it('поле карточки уже занято другим — не затираем, строка «Счёт:» уходит в заметку заявки', async () => {
    await lead({ contact: '@old_nick', invoice_channel: 'telegram', invoice_contact: '@new_nick', note: 'Комментарий' })
    expect((await one('SELECT messenger FROM contacts')).messenger).toBe('@old_nick')
    expect((await one('SELECT note FROM deals')).note).toBe('Комментарий\nСчёт: Telegram @new_nick')
  })

  it('незнакомый тариф и кривой канал — заявка всё равно принята', async () => {
    expect((await lead({ plan: 'platinum', invoice_channel: 'fax', invoice_contact: '123' })).statusCode).toBe(204)
    expect(await one('SELECT plan, invoice_channel, invoice_contact FROM deals')).toEqual({ plan: 'unknown', invoice_channel: '', invoice_contact: '' })
  })

  it('заявка без новых полей (старый клиент сайта, строки в note) работает как раньше', async () => {
    await lead({ note: 'Тариф: Ремонт под контролем — 19 900 ₽\nСчёт: Telegram @ivan' })
    expect(await one('SELECT plan, invoice_channel FROM deals')).toEqual({ plan: '', invoice_channel: '' })
    expect((await one('SELECT note FROM deals')).note).toContain('Тариф: Ремонт под контролем')
  })

  it('повторная заявка в открытую сделку: тариф обновлён, прежний — в истории, пустой email заполнен', async () => {
    await lead({ plan: 'stage' })
    await lead({ plan: 'house', invoice_channel: 'email', invoice_contact: 'ivan@example.ru' })
    expect(Number((await one('SELECT COUNT(*) c FROM deals')).c)).toBe(1)
    expect(await one('SELECT plan, invoice_channel, invoice_contact FROM deals')).toEqual({ plan: 'house', invoice_channel: 'email', invoice_contact: 'ivan@example.ru' })
    expect((await one('SELECT email FROM contacts')).email).toBe('ivan@example.ru')
    const hist = (await app.db.prepare('SELECT note FROM interactions').all()).map((r) => r.note).find((n) => n.startsWith('Повторная'))
    expect(hist).toContain('Тариф: Дом под контролем (в сделке был тариф: Проверка этапа)')
    expect(hist).toContain('Счёт: Почта ivan@example.ru')
  })

  it('уведомление: тариф есть, контакта для счёта нет ни в очереди, ни в тексте', async () => {
    await lead({ plan: 'repair', invoice_channel: 'telegram', invoice_contact: '@ivan_test' })
    const raw = (await one("SELECT payload FROM outbox WHERE kind = 'lead'")).payload
    expect(raw).not.toContain('ivan_test')
    const payload = JSON.parse(raw)
    expect(payload.plan).toBe('repair')
    const text = leadMessage(payload, {})
    expect(text).toContain('Тариф: Ремонт под контролем')
    expect(text).not.toContain('ivan')
  })
})

describe('тариф и счёт в CRM', () => {
  it('правка сделки: только коды из списка; дашборд показывает тариф новой заявки', async () => {
    await lead({ plan: 'repair' })
    const deal = await one('SELECT id, updated_at FROM deals')
    expect((await crm('PATCH', `/api/crm/deals/${deal.id}`, { plan: 'gold' })).json()).toEqual({ error: 'bad_plan' })
    expect((await crm('PATCH', `/api/crm/deals/${deal.id}`, { invoice_channel: 'fax' })).json()).toEqual({ error: 'bad_invoice_channel' })
    const ok = await crm('PATCH', `/api/crm/deals/${deal.id}`, { plan: 'monthly', invoice_channel: 'email', invoice_contact: 'A@B.RU' })
    expect(ok.statusCode).toBe(200)
    expect(await one('SELECT plan, invoice_contact FROM deals')).toEqual({ plan: 'monthly', invoice_contact: 'a@b.ru' })
    const dash = (await crm('GET', '/api/crm/dashboard?project=nevarium-vizor')).json()
    expect(dash.inbox[0].deal_plan).toBe('monthly')
  })

  it('обезличивание стирает контакт для счёта и канал, тариф остаётся', async () => {
    await lead({ plan: 'repair', invoice_channel: 'telegram', invoice_contact: '@ivan_test' })
    const c = await one('SELECT id FROM contacts')
    expect((await crm('POST', `/api/crm/contacts/${c.id}/anonymize`)).statusCode).toBe(200)
    expect(await one('SELECT plan, invoice_channel, invoice_contact FROM deals')).toEqual({ plan: 'repair', invoice_channel: '', invoice_contact: '' })
    expect((await one('SELECT messenger FROM contacts')).messenger).toBe('')
  })

  it('экспорт → импорт сохраняет тариф и счёт сделки', async () => {
    await lead({ plan: 'repair', invoice_channel: 'max', invoice_contact: '+79001234567' })
    const dump = (await crm('GET', '/api/crm/export')).json()
    expect(dump.deals[0]).toMatchObject({ plan: 'repair', invoice_channel: 'max', invoice_contact: '+79001234567' })
    await app.db.prepare("UPDATE deals SET plan = '', invoice_channel = '', invoice_contact = ''").run()
    expect((await crm('POST', '/api/crm/import', dump)).statusCode).toBe(200)
    expect(await one('SELECT plan, invoice_channel, invoice_contact FROM deals')).toEqual({ plan: 'repair', invoice_channel: 'max', invoice_contact: '+79001234567' })
  })
})
