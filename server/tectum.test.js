// @vitest-environment node
// Сайт Nevarium Tectum (задание сайта 2026-11-19, ADR-032): проект, стенд, почта рядом с телефоном, потолок заметки.
import { newDb } from 'pg-mem'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { ensureSeedProjects } from './db.js'
import { resetThrottle } from './auth.js'
import { normalizeLeadEmail } from '../src/shared/lead-fields.js'

const STAND = 'https://tectum-stand.vercel.app'
let app

async function build(opts = {}) {
  resetThrottle()
  const pool = new (newDb().adapters.createPg()).Pool()
  app = await buildApp({ dbConfig: pool, secure: false, ...opts })
  await app.ready()
  return app
}
afterEach(async () => { await app?.close?.(); app = null })

const one = (sql, ...a) => app.db.prepare(sql).get(...a)
const all = (sql, ...a) => app.db.prepare(sql).all(...a)
let seq = 0
const lead = (body = {}, origin) => app.inject({
  method: 'POST', url: '/api/leads',
  headers: { ...(origin ? { origin } : {}), 'idempotency-key': `t-${++seq}` },
  payload: { project: 'nevarium-tectum', name: 'Анна', contact: '+79210000000', task: 'Расчёт проекта с сайта', source: 'form', ...body },
})

describe('проект nevarium-tectum', () => {
  it('на свежей базе есть три проекта, Tectum — третий, без доменов', async () => {
    await build()
    expect(await all('SELECT id, slug, display_name, origins FROM projects ORDER BY id')).toEqual([
      { id: 1, slug: 'nevarium1', display_name: 'Невариум Лаб ИИ', origins: expect.any(String) },
      { id: 2, slug: 'nevarium-vizor', display_name: 'Невариум Визор', origins: expect.any(String) },
      { id: 3, slug: 'nevarium-tectum', display_name: 'Nevarium Tectum', origins: '' },
    ])
  })

  it('на заполненной базе (как прод) недостающий проект добавляется, существующие не трогаются', async () => {
    await build()
    await app.db.prepare("UPDATE projects SET display_name = 'Переименован', origins = 'https://custom.example' WHERE slug = 'nevarium-vizor'").run()
    await app.db.prepare("DELETE FROM projects WHERE slug = 'nevarium-tectum'").run()
    expect(await ensureSeedProjects(app.db, app.db.pool)).toEqual(['nevarium-tectum'])
    expect(await one("SELECT id, display_name FROM projects WHERE slug = 'nevarium-tectum'")).toEqual({ id: 3, display_name: 'Nevarium Tectum' })
    expect(await one("SELECT display_name, origins FROM projects WHERE slug = 'nevarium-vizor'")).toEqual({ display_name: 'Переименован', origins: 'https://custom.example' })
    // Повторный запуск ничего не делает.
    expect(await ensureSeedProjects(app.db, app.db.pool)).toEqual([])
    expect(Number((await one('SELECT COUNT(*) c FROM projects')).c)).toBe(3)
  })

  it('id 3 уже занят другим проектом — Tectum получает следующий свободный, а не падает', async () => {
    await build()
    await app.db.prepare("DELETE FROM projects WHERE slug = 'nevarium-tectum'").run()
    await app.db.prepare("INSERT INTO projects (id, slug, display_name, origins, created_at) VALUES (3, 'other', 'Другой', '', 'x')").run()
    expect(await ensureSeedProjects(app.db, app.db.pool)).toEqual(['nevarium-tectum'])
    expect(await one("SELECT id FROM projects WHERE slug = 'nevarium-tectum'")).toEqual({ id: 4 })
  })

  it('архивный проект не воскрешается и не дублируется', async () => {
    await build()
    await app.db.prepare("UPDATE projects SET archived = 1 WHERE slug = 'nevarium-tectum'").run()
    expect(await ensureSeedProjects(app.db, app.db.pool)).toEqual([])
    expect(Number((await one("SELECT COUNT(*) c FROM projects WHERE slug = 'nevarium-tectum'")).c)).toBe(1)
  })
})

describe('стенд Tectum на Vercel в закрытом режиме (INTAKE_ALLOWED_ORIGINS=…=nevarium-tectum)', () => {
  const closed = () => build({ intakeMode: 'closed', intakeAllowedOrigins: `${STAND}=nevarium-tectum` })

  it('заявка со стенда принята и попала в проект Tectum; повтор с тем же ключом — без второй карточки', async () => {
    await closed()
    const body = { request_id: 'same-key', consent: { version: '19.11.2026', text: 'Согласие Tectum', accepted_at: '2026-11-19T18:00:00.000Z' } }
    expect((await lead(body, STAND)).statusCode).toBeLessThan(300)
    expect((await lead(body, STAND)).statusCode).toBeLessThan(300)
    expect(Number((await one('SELECT COUNT(*) c FROM contacts')).c)).toBe(1)
    expect(await one("SELECT p.slug FROM contacts c JOIN projects p ON p.id = c.project_id")).toEqual({ slug: 'nevarium-tectum' })
    expect(await one('SELECT version, text, accepted_at FROM consents')).toEqual({ version: '19.11.2026', text: 'Согласие Tectum', accepted_at: '2026-11-19T18:00:00.000Z' })
  })

  it('предзапрос со стенда: 204, CORS и idempotency-key разрешены', async () => {
    await closed()
    const res = await app.inject({ method: 'OPTIONS', url: '/api/leads', headers: { origin: STAND, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,idempotency-key' } })
    expect(res.statusCode).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe(STAND)
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain('idempotency-key')
  })

  it('чужой домен в закрытом режиме — 403 intake_closed, ничего не сохранено', async () => {
    await closed()
    const res = await lead({}, 'https://evil.example')
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'intake_closed' })
    expect(Number((await one('SELECT COUNT(*) c FROM contacts')).c)).toBe(0)
  })
})

describe('почта рядом с телефоном (поле email)', () => {
  it('нормализация: нижний регистр, кривое значение отбрасывается с пометкой, длина до 254', () => {
    expect(normalizeLeadEmail(undefined)).toEqual({ email: '' })
    expect(normalizeLeadEmail(' Anna@Mail.RU ')).toEqual({ email: 'anna@mail.ru' })
    expect(normalizeLeadEmail('не почта')).toEqual({ email: '', warn: 'invalid_email' })
    expect(normalizeLeadEmail({ a: 1 })).toEqual({ email: '', warn: 'invalid_email' })
    expect(normalizeLeadEmail('a@' + 'b'.repeat(260) + '.ru').warn).toBe('invalid_email')
  })

  it('телефон в contact + email → почта в карточке, телефон остаётся телефоном', async () => {
    await build()
    expect((await lead({ email: 'Anna@Mail.ru' })).statusCode).toBeLessThan(300)
    expect(await one('SELECT phone, email, messenger FROM contacts')).toEqual({ phone: '+79210000000', email: 'anna@mail.ru', messenger: '' })
  })

  it('contact — другая почта: адрес из поля email не затирает её, уходит строкой в заметку сделки', async () => {
    await build()
    await lead({ contact: 'first@mail.ru', email: 'second@mail.ru', note: 'Коммент' })
    expect((await one('SELECT email FROM contacts')).email).toBe('first@mail.ru')
    expect((await one('SELECT note FROM deals')).note).toBe('Коммент\nE-mail: second@mail.ru')
  })

  it('повторная заявка заполняет пустую почту существующей карточки', async () => {
    await build()
    await lead({})
    expect((await one('SELECT email FROM contacts')).email).toBe('')
    await lead({ email: 'anna@mail.ru' })
    expect(Number((await one('SELECT COUNT(*) c FROM contacts')).c)).toBe(1)
    expect((await one('SELECT email FROM contacts')).email).toBe('anna@mail.ru')
  })

  it('кривая почта — заявка принята, поле отброшено', async () => {
    await build()
    expect((await lead({ email: 'не почта' })).statusCode).toBeLessThan(300)
    expect((await one('SELECT email FROM contacts')).email).toBe('')
  })

  it('почта не уходит в очередь уведомлений (Telegram/MAX без ПДн)', async () => {
    await build()
    await lead({ email: 'anna@mail.ru' })
    const raw = (await one("SELECT payload FROM outbox WHERE kind = 'lead'")).payload
    expect(raw).not.toContain('anna@mail.ru')
  })
})

describe('заметка заявки из формы', () => {
  it('2000 символов сохраняются целиком, сверх — обрезается', async () => {
    await build()
    await lead({ note: 'я'.repeat(2500) })
    expect((await one('SELECT note FROM deals')).note).toHaveLength(2000)
  })

  it('чат по-прежнему режется на 1000', async () => {
    await build()
    await lead({ source: 'chat', name: undefined, task: 'Чат', detail: 'я'.repeat(1500) })
    expect((await one('SELECT note FROM deals')).note).toHaveLength(1000)
  })
})
