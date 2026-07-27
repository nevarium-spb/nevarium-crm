// @vitest-environment node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { hashPassword, resetThrottle } from './auth.js'
import { MIGRATIONS, now, openDb } from './db.js'
import { leadMessage, startOutboxWorker } from './telegram.js'

let app, cookie

async function login(email = 'a@a.ru', password = 'password123') {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } })
  return res
}

beforeEach(async () => {
  resetThrottle()
  app = buildApp({ secure: false })
  app.db
    .prepare('INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)')
    .run('Админ', 'a@a.ru', await hashPassword('password123'), 'admin', now())
  await app.ready()
  cookie = (await login()).headers['set-cookie']
})

afterEach(() => app.close())

describe('auth', () => {
  it('логин выдаёт cookie, /me работает, logout сбрасывает', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
    expect(me.statusCode).toBe(200)
    expect(JSON.parse(me.body).email).toBe('a@a.ru')
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } })
    expect(out.headers['set-cookie']).toMatch(/nv_session=;/)
  })

  it('verifyToken отклоняет подделку, просрочку и мусор', async () => {
    const { signToken, verifyToken } = await import('./auth.js')
    const good = signToken({ uid: 1, tokenVersion: 0 }, 'secret-a')
    expect(verifyToken(good, 'secret-a')).toMatchObject({ uid: 1 })
    expect(verifyToken(good, 'secret-b')).toBeNull() // чужой секрет
    const [payload] = good.split('.')
    expect(verifyToken(`${payload}.forged`, 'secret-a')).toBeNull()
    const expired = signToken({ uid: 1, tokenVersion: 0 }, 'secret-a', -1)
    expect(verifyToken(expired, 'secret-a')).toBeNull()
    expect(verifyToken('мусор', 'secret-a')).toBeNull()
    expect(verifyToken(null, 'secret-a')).toBeNull()
  })

  it('неверный пароль → 401 с обезличенной ошибкой', async () => {
    const res = await login('a@a.ru', 'wrong-password')
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).error).toBe('invalid_credentials')
  })

  it('троттлинг: после 5 неудач — 429', async () => {
    for (let i = 0; i < 5; i++) await login('a@a.ru', 'wrong-password')
    const res = await login('a@a.ru', 'wrong-password')
    expect(res.statusCode).toBe(429)
  })

  it('без cookie /api/crm/* → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/crm/contacts' })
    expect(res.statusCode).toBe(401)
  })

  it('смена пароля инвалидирует старую сессию (tokenVersion)', async () => {
    await app.inject({ method: 'PATCH', url: '/api/crm/users/1', payload: { password: 'newpassword1' }, headers: { cookie } })
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
    expect(me.statusCode).toBe(401)
  })

  it('Origin за прокси сверяется с X-Forwarded-Host', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/crm/contacts',
      payload: { name: 'Прокси' },
      headers: { cookie, origin: 'http://localhost:58959', host: 'localhost:3001', 'x-forwarded-host': 'localhost:58959' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('чужой Origin на мутации → 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/crm/contacts',
      payload: { name: 'X' },
      headers: { cookie, origin: 'https://evil.example', host: 'crm.nevarium.ru' },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('CRUD + конфликты', () => {
  it('создание контакта и сделки, перевод в терминальный этап ставит closed_at', async () => {
    const c = await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов' }, headers: { cookie } })
    expect(c.statusCode).toBe(200)
    const d = await app.inject({ method: 'POST', url: '/api/crm/deals', payload: { contact_id: 1, title: 'Пилот', amount: 5000 }, headers: { cookie } })
    expect(d.statusCode).toBe(200)
    const paid = await app.inject({ method: 'PATCH', url: '/api/crm/deals/1', payload: { stage: 'Оплачено' }, headers: { cookie } })
    expect(JSON.parse(paid.body).item.closed_at).toBeTruthy()
    const back = await app.inject({ method: 'PATCH', url: '/api/crm/deals/1', payload: { stage: 'Переговоры' }, headers: { cookie } })
    expect(JSON.parse(back.body).item.closed_at).toBeNull()
  })

  it('устаревший expectedUpdatedAt → 409 с актуальной записью', async () => {
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов' }, headers: { cookie } })
    const res = await app.inject({ method: 'PATCH', url: '/api/crm/contacts/1', payload: { note: 'x', expectedUpdatedAt: 'stale' }, headers: { cookie } })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).current.name).toBe('Иванов')
  })

  it('контакт со сделками не удаляется (архив), без сделок — удаляется', async () => {
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов' }, headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/crm/deals', payload: { contact_id: 1, title: 'Пилот' }, headers: { cookie } })
    const blocked = await app.inject({ method: 'DELETE', url: '/api/crm/contacts/1', headers: { cookie } })
    expect(blocked.statusCode).toBe(409)
    await app.inject({ method: 'DELETE', url: '/api/crm/deals/1', headers: { cookie } })
    const ok = await app.inject({ method: 'DELETE', url: '/api/crm/contacts/1', headers: { cookie } })
    expect(ok.statusCode).toBe(200)
  })

  it('дубликат по телефону/email даёт предупреждение', async () => {
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов', phone: '+7 999' }, headers: { cookie } })
    const dup = await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Другой', phone: '+7 999' }, headers: { cookie } })
    expect(JSON.parse(dup.body).duplicateOf?.name).toBe('Иванов')
  })

  it('неверный этап отклоняется', async () => {
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'X' }, headers: { cookie } })
    const res = await app.inject({ method: 'POST', url: '/api/crm/deals', payload: { contact_id: 1, title: 'X', stage: 'Выдумка' }, headers: { cookie } })
    expect(res.statusCode).toBe(400)
  })

  it('сделка на несуществующий контакт → 400, а не 500', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/crm/deals', payload: { contact_id: 999, title: 'X' }, headers: { cookie } })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('bad_reference')
  })

  it('нечисловой id → 400, а не 500', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/crm/contacts/abc', payload: { note: 'x' }, headers: { cookie } })
    expect(res.statusCode).toBe(400)
    const del = await app.inject({ method: 'DELETE', url: '/api/crm/contacts/abc', headers: { cookie } })
    expect(del.statusCode).toBe(400)
  })
})

describe('приём лидов', () => {
  it('форма: контакт + сделка «Новый», Telegram в outbox', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/leads', payload: { task: 'внедрение ИИ', scale: 'отдел', name: 'Марина', contact: 'm@x.ru', note: 'срочно', source: 'start-wizard' } })
    expect(res.statusCode).toBe(204)
    const contact = app.db.prepare('SELECT * FROM contacts WHERE id = 1').get()
    expect(contact).toMatchObject({ name: 'Марина', email: 'm@x.ru', source: 'site-form', suspicious: 0 })
    const deal = app.db.prepare('SELECT * FROM deals WHERE id = 1').get()
    expect(deal.title).toContain('внедрение ИИ')
    expect(deal.stage).toBe('Новый')
    expect(app.db.prepare("SELECT COUNT(*) c FROM outbox WHERE kind = 'lead' AND sent_at IS NULL").get().c).toBe(1)
  })

  it('чат: detail → заметка сделки, handle → messenger и имя', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/leads', payload: { task: 'чат-бот', detail: 'для клиники', contact: '@tg_user', source: 'chat' } })
    expect(res.statusCode).toBe(204)
    const contact = app.db.prepare('SELECT * FROM contacts WHERE id = 1').get()
    expect(contact).toMatchObject({ name: '@tg_user', messenger: '@tg_user', source: 'site-chat' })
    expect(app.db.prepare('SELECT note FROM deals WHERE id = 1').get().note).toBe('для клиники')
  })

  it('honeypot принимается, но помечается подозрительным', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Бот', contact: 'bot@x.ru', website: 'spam.com' } })
    expect(res.statusCode).toBe(204)
    expect(app.db.prepare('SELECT suspicious FROM contacts WHERE id = 1').get().suspicious).toBe(1)
  })

  it('rate limit не отбрасывает: 5-й лид с одного IP — подозрительный', async () => {
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: `Гость ${i}`, contact: `g${i}@x.ru` }, remoteAddress: '10.1.1.1' })
    }
    expect(app.db.prepare('SELECT COUNT(*) c FROM contacts').get().c).toBe(5)
    expect(app.db.prepare('SELECT suspicious FROM contacts WHERE id = 5').get().suspicious).toBe(1)
  })

  it('пустой лид отбрасывается без записи', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: {} })
    expect(app.db.prepare('SELECT COUNT(*) c FROM contacts').get().c).toBe(0)
  })

  it('проект берётся из поля формы — контакт и сделка попадают в него', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Клиент', contact: 'k@x.ru', project: 'nevarium-vizor' } })
    expect(app.db.prepare('SELECT project_id FROM contacts WHERE id = 1').get().project_id).toBe(2)
    expect(app.db.prepare('SELECT project_id FROM deals WHERE id = 1').get().project_id).toBe(2)
  })

  it('без поля формы проект определяется по домену сайта', async () => {
    app.db.prepare("UPDATE projects SET origins = 'https://vizor.example.ru' WHERE slug = 'nevarium-vizor'").run()
    await app.inject({
      method: 'POST',
      url: '/api/leads',
      payload: { name: 'Клиент', contact: 'k@x.ru' },
      headers: { origin: 'https://vizor.example.ru' },
    })
    expect(app.db.prepare('SELECT project_id FROM contacts WHERE id = 1').get().project_id).toBe(2)
  })

  it('неизвестный проект не теряет заявку — уходит в проект по умолчанию', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Клиент', contact: 'k@x.ru', project: 'опечатка' } })
    expect(res.statusCode).toBe(204)
    expect(app.db.prepare('SELECT project_id FROM contacts WHERE id = 1').get().project_id).toBe(1)
  })

  it('CORS: чужой домен не проходит preflight, свой — проходит', async () => {
    app.db.prepare("UPDATE projects SET origins = 'https://vizor.example.ru' WHERE slug = 'nevarium-vizor'").run()
    const alien = await app.inject({ method: 'OPTIONS', url: '/api/leads', headers: { origin: 'https://evil.example' } })
    expect(alien.statusCode).toBe(403)
    expect(alien.headers['access-control-allow-origin']).toBeUndefined()
    const ours = await app.inject({ method: 'OPTIONS', url: '/api/leads', headers: { origin: 'https://vizor.example.ru' } })
    expect(ours.statusCode).toBe(204)
    expect(ours.headers['access-control-allow-origin']).toBe('https://vizor.example.ru')
  })
})

describe('outbox: лид не теряется при падении Telegram', () => {
  it('ошибка отправки увеличивает attempts, успех ставит sent_at', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'm@x.ru' } })
    let calls = 0
    const failingSend = async () => {
      calls++
      if (calls === 1) throw new Error('Telegram down')
    }
    const worker = startOutboxWorker(app.db, { intervalMs: 10_000_000, send: failingSend, log: { warn() {} }, autoStart: false })
    worker.stop()
    await worker.tick()
    let row = app.db.prepare('SELECT * FROM outbox WHERE id = 1').get()
    expect(row.attempts).toBe(1)
    expect(row.sent_at).toBeNull()
    await worker.tick()
    row = app.db.prepare('SELECT * FROM outbox WHERE id = 1').get()
    expect(row.sent_at).toBeTruthy()
  })

  it('после 20 попыток запись не берётся в обработку (мёртвая, видна в очереди)', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'm@x.ru' } })
    app.db.prepare('UPDATE outbox SET attempts = 20 WHERE id = 1').run()
    let calls = 0
    const worker = startOutboxWorker(app.db, { send: async () => { calls++ }, log: { warn() {} }, autoStart: false })
    worker.stop()
    await worker.tick()
    expect(calls).toBe(0)
    expect(app.db.prepare('SELECT sent_at FROM outbox WHERE id = 1').get().sent_at).toBeNull()
  })

  it('leadMessage экранирует HTML', () => {
    expect(leadMessage({ projectName: '<script>' })).toContain('&lt;script&gt;')
  })

  it('уведомление не содержит персональных данных, только проект, источник и ссылку', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/leads',
      payload: { name: 'Марина Соколова', contact: '+7 921 555-14-88', task: 'секретная задача', note: 'подробности' },
    })
    const payload = JSON.parse(app.db.prepare('SELECT payload FROM outbox WHERE id = 1').get().payload)
    // в очереди не остаётся ПДн — она уедет в зарубежный Telegram
    expect(JSON.stringify(payload)).not.toMatch(/Марина|555-14-88|секретная|подробности/)
    const text = leadMessage(payload, { CRM_BASE_URL: 'https://crm.example.ru/' })
    expect(text).not.toMatch(/Марина|555-14-88|секретная|подробности/)
    expect(text).toContain('Невариум Лаб ИИ')
    expect(text).toContain('https://crm.example.ru/crm/contacts/1')
  })

  it('без CRM_BASE_URL уведомление всё равно уходит, просто без ссылки', () => {
    const text = leadMessage({ projectName: 'Невариум Визор', source: 'форма', contactId: 7 }, {})
    expect(text).toContain('Невариум Визор')
    expect(text).not.toContain('http')
  })
})

describe('экспорт / импорт / CSV', () => {
  it('раунд-трип: экспорт → wipe → импорт', async () => {
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов', phone: '+7 999' }, headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/crm/deals', payload: { contact_id: 1, title: 'Пилот', amount: 777 }, headers: { cookie } })
    const dump = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })).body)
    expect(dump.contacts).toHaveLength(1)
    const res = await app.inject({ method: 'POST', url: '/api/crm/import', payload: dump, headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(app.db.prepare('SELECT name FROM contacts WHERE id = 1').get().name).toBe('Иванов')
    expect(app.db.prepare('SELECT amount FROM deals WHERE id = 1').get().amount).toBe(777)
  })

  it('битый файл отклоняется атомарно', async () => {
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Живой' }, headers: { cookie } })
    const res = await app.inject({ method: 'POST', url: '/api/crm/import', payload: { version: 1, contacts: [{ nonsense: true }] }, headers: { cookie } })
    expect(res.statusCode).toBe(400)
    // старые данные не тронуты
    expect(app.db.prepare('SELECT COUNT(*) c FROM contacts').get().c).toBe(1)
  })

  it('файл новее версии приложения отклоняется', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/crm/import', payload: { version: 99, contacts: [] }, headers: { cookie } })
    expect(JSON.parse(res.body).error).toBe('newer_version')
  })

  it('импорт с чужеродным именем колонки отклоняется (не SQL-инъекция)', async () => {
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Живой' }, headers: { cookie } })
    const res = await app.inject({ method: 'POST', url: '/api/crm/import', payload: { version: 1, contacts: [{ 'name) VALUES (1); DROP TABLE contacts; --': 'x', name: 'Злой' }] }, headers: { cookie } })
    expect(res.statusCode).toBe(400)
    expect(app.db.prepare('SELECT COUNT(*) c FROM contacts').get().c).toBe(1)
  })

  it('CSV нейтрализует формулы из публичных лидов (=/+/-/@)', async () => {
    // имя приходит с публичного endpoint — Excel исполнил бы =HYPERLINK(...)
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: '=HYPERLINK("http://evil")', contact: 'e@x.ru' } })
    const csv = (await app.inject({ method: 'GET', url: '/api/crm/contacts.csv', headers: { cookie } })).body
    expect(csv).toContain("'=HYPERLINK")
    expect(csv).not.toMatch(/(^|;|")=HYPERLINK/)
  })

  it('демо-данные исключены из экспорта; CSV экранирует кавычки и точки с запятой', async () => {
    await app.inject({ method: 'POST', url: '/api/crm/demo-seed', headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'ООО "Ромашка"; и точка' }, headers: { cookie } })
    const dump = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })).body)
    expect(dump.contacts).toHaveLength(1)
    const csv = (await app.inject({ method: 'GET', url: '/api/crm/contacts.csv', headers: { cookie } })).body
    expect(csv).toContain('"ООО ""Ромашка""; и точка"')
    // демо-контактов в CSV нет
    expect(csv).not.toContain('Балтика')
  })

  it('очистка демо удаляет только помеченные записи', async () => {
    await app.inject({ method: 'POST', url: '/api/crm/demo-seed', headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Настоящий' }, headers: { cookie } })
    await app.inject({ method: 'DELETE', url: '/api/crm/demo', headers: { cookie } })
    const rows = app.db.prepare('SELECT name FROM contacts').all()
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Настоящий')
  })
})

describe('дашборд', () => {
  it('воронка считает только открытые, терминальные отдельно, просрочка по МСК', async () => {
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов' }, headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/crm/deals', payload: { contact_id: 1, title: 'A', amount: 100, stage: 'Переговоры' }, headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/crm/deals', payload: { contact_id: 1, title: 'B', amount: 200 }, headers: { cookie } })
    await app.inject({ method: 'PATCH', url: '/api/crm/deals/2', payload: { stage: 'Оплачено' }, headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/crm/tasks', payload: { title: 'Просроченная', contact_id: 1, due_date: '2020-01-01' }, headers: { cookie } })
    const dash = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/dashboard', headers: { cookie } })).body)
    expect(dash.funnel.find((f) => f.stage === 'Переговоры').sum).toBe(100)
    expect(dash.funnel.some((f) => f.stage === 'Оплачено')).toBe(false)
    expect(dash.terminal.find((t) => t.stage === 'Оплачено').sum).toBe(200)
    expect(dash.counts.overdue).toBe(1)
    expect(dash.tasksToday[0].title).toBe('Просроченная')
  })

  it('граница суток считается по Москве, а не по UTC', async () => {
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'X' }, headers: { cookie } })
    // задача на 2026-07-10; момент времени 2026-07-09 22:00 UTC = уже 2026-07-10 01:00 МСК
    await app.inject({ method: 'POST', url: '/api/crm/tasks', payload: { title: 'Сегодня по МСК', contact_id: 1, due_date: '2026-07-10' }, headers: { cookie } })
    const nowMs = Date.parse('2026-07-09T22:00:00Z')
    const dash = JSON.parse((await app.inject({ method: 'GET', url: `/api/crm/dashboard?_now=${nowMs}`, headers: { cookie } })).body)
    expect(dash.today).toBe('2026-07-10')
    expect(dash.tasksToday.some((t) => t.title === 'Сегодня по МСК')).toBe(true)
  })

  it('экспорт и CSV доступны только админу', async () => {
    await app.inject({ method: 'POST', url: '/api/crm/users', payload: { name: 'Мария', email: 'm@a.ru', password: 'password123', role: 'member' }, headers: { cookie } })
    const memberCookie = (await login('m@a.ru', 'password123')).headers['set-cookie']
    expect((await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie: memberCookie } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/crm/contacts.csv', headers: { cookie: memberCookie } })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })).statusCode).toBe(200)
  })
})

describe('пользователи', () => {
  it('не-админ не управляет пользователями (create/patch/delete)', async () => {
    await app.inject({ method: 'POST', url: '/api/crm/users', payload: { name: 'Мария', email: 'm@a.ru', password: 'password123', role: 'member' }, headers: { cookie } })
    const memberCookie = (await login('m@a.ru', 'password123')).headers['set-cookie']
    const create = await app.inject({ method: 'POST', url: '/api/crm/users', payload: { name: 'X', email: 'x@a.ru', password: 'password123' }, headers: { cookie: memberCookie } })
    expect(create.statusCode).toBe(403)
    const patch = await app.inject({ method: 'PATCH', url: '/api/crm/users/1', payload: { password: 'newpassword1' }, headers: { cookie: memberCookie } })
    expect(patch.statusCode).toBe(403)
    const del = await app.inject({ method: 'DELETE', url: '/api/crm/users/1', headers: { cookie: memberCookie } })
    expect(del.statusCode).toBe(403)
  })

  it('удаление пользователя закрывает его сессии', async () => {
    await app.inject({ method: 'POST', url: '/api/crm/users', payload: { name: 'Мария', email: 'm@a.ru', password: 'password123' }, headers: { cookie } })
    const memberCookie = (await login('m@a.ru', 'password123')).headers['set-cookie']
    await app.inject({ method: 'DELETE', url: '/api/crm/users/2', headers: { cookie } })
    const res = await app.inject({ method: 'GET', url: '/api/crm/contacts', headers: { cookie: memberCookie } })
    expect(res.statusCode).toBe(401)
  })

  it('нельзя удалить себя', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/crm/users/1', headers: { cookie } })
    expect(res.statusCode).toBe(400)
  })
})

describe('мультипроектность', () => {
  it('миграция на существующей базе не теряет данные и проставляет проект по умолчанию', () => {
    const file = path.join(os.tmpdir(), `nv-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`)
    try {
      // база в состоянии «до мультипроектности»: применяем только v1 и v2
      const old = new Database(file)
      old.pragma('foreign_keys = ON')
      old.exec(MIGRATIONS[0])
      old.exec(MIGRATIONS[1])
      old.pragma('user_version = 2')
      const ts = now()
      old.prepare('INSERT INTO contacts (name, source, created_at, updated_at) VALUES (?,?,?,?)').run('Старый лид', 'site-form', ts, ts)
      old.prepare('INSERT INTO deals (contact_id, title, created_at, updated_at) VALUES (?,?,?,?)').run(1, 'Старая сделка', ts, ts)
      old.close()

      // открываем актуальным кодом — должна догнаться только недостающая миграция
      const db = openDb(file)
      expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
      expect(db.prepare('SELECT name, project_id FROM contacts').get()).toEqual({ name: 'Старый лид', project_id: 1 })
      expect(db.prepare('SELECT title, project_id FROM deals').get()).toEqual({ title: 'Старая сделка', project_id: 1 })
      expect(db.prepare('SELECT slug FROM projects ORDER BY id').all().map((p) => p.slug)).toEqual(['nevarium1', 'nevarium-vizor'])
      db.close()
    } finally {
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true })
    }
  })

  it('список проектов отдаёт оба бизнеса', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/crm/projects', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).items.map((p) => p.slug)).toEqual(['nevarium1', 'nevarium-vizor'])
  })

  it('фильтр отдаёт только свой проект, «all» — всё', async () => {
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Клиент Лаба' }, headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Клиент Визора', project_id: 'nevarium-vizor' }, headers: { cookie } })
    const vizor = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/contacts?project=nevarium-vizor', headers: { cookie } })).body)
    expect(vizor.items.map((c) => c.name)).toEqual(['Клиент Визора'])
    const lab = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/contacts?project=nevarium1', headers: { cookie } })).body)
    expect(lab.items.map((c) => c.name)).toEqual(['Клиент Лаба'])
    const all = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/contacts?project=all', headers: { cookie } })).body)
    expect(all.items).toHaveLength(2)
  })

  it('неизвестный проект в фильтре — 400, а не тихий показ чужих заявок', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/crm/contacts?project=нет-такого', headers: { cookie } })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('unknown_project')
  })

  it('сделка наследует проект своего контакта', async () => {
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Клиент Визора', project_id: 2 }, headers: { cookie } })
    const res = await app.inject({ method: 'POST', url: '/api/crm/deals', payload: { contact_id: 1, title: 'Осмотр объекта' }, headers: { cookie } })
    expect(JSON.parse(res.body).item.project_id).toBe(2)
  })

  it('несуществующий проект при создании — 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'X', project_id: 999 }, headers: { cookie } })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('bad_project')
  })

  it('дашборд считает только выбранный проект', async () => {
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Лаб', source: 'site-form' }, headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Визор', source: 'site-form', project_id: 2 }, headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/crm/deals', payload: { contact_id: 1, title: 'Сделка Лаба', amount: 100 }, headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/crm/deals', payload: { contact_id: 2, title: 'Сделка Визора', amount: 700 }, headers: { cookie } })

    const vizor = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/dashboard?project=nevarium-vizor', headers: { cookie } })).body)
    expect(vizor.counts).toMatchObject({ contacts: 1, deals: 1 })
    expect(vizor.inbox.map((c) => c.name)).toEqual(['Визор'])
    expect(vizor.funnel.find((f) => f.stage === 'Новый').sum).toBe(700)

    const all = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/dashboard', headers: { cookie } })).body)
    expect(all.counts).toMatchObject({ contacts: 2, deals: 2 })
    expect(all.funnel.find((f) => f.stage === 'Новый').sum).toBe(800)
  })

  it('задачи фильтруются через контакт, а общие видны в любом проекте', async () => {
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Лаб' }, headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Визор', project_id: 2 }, headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/crm/tasks', payload: { title: 'Позвонить в Лаб', contact_id: 1, due_date: '2020-01-01' }, headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/crm/tasks', payload: { title: 'Позвонить в Визор', contact_id: 2, due_date: '2020-01-01' }, headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/crm/tasks', payload: { title: 'Общая задача', due_date: '2020-01-01' }, headers: { cookie } })

    const vizor = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/dashboard?project=nevarium-vizor', headers: { cookie } })).body)
    // чужая задача скрыта, своя и общая — на месте (пропущенная задача хуже лишней строки)
    expect(vizor.tasksToday.map((t) => t.title).sort()).toEqual(['Общая задача', 'Позвонить в Визор'])
    expect(vizor.counts.overdue).toBe(2)

    const lab = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/dashboard?project=nevarium1', headers: { cookie } })).body)
    expect(lab.tasksToday.map((t) => t.title).sort()).toEqual(['Общая задача', 'Позвонить в Лаб'])
  })

  it('аналитика: разбивка заявок по проектам и источникам', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'A', contact: 'a@x.ru', project: 'nevarium1' } })
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'B', contact: 'b@x.ru', project: 'nevarium-vizor' } })
    await app.inject({ method: 'POST', url: '/api/leads', payload: { task: 'из чата', detail: 'подробности', contact: '@tg', source: 'chat', project: 'nevarium-vizor' } })

    const all = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/dashboard', headers: { cookie } })).body)
    expect(all.stats.days).toBe(30)
    expect(all.stats.byProject.map((r) => [r.name, r.n])).toEqual([
      ['Невариум Визор', 2],
      ['Невариум Лаб ИИ', 1],
    ])
    expect(Object.fromEntries(all.stats.bySource.map((r) => [r.source, r.n]))).toEqual({ 'site-form': 2, 'site-chat': 1 })

    const vizor = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/dashboard?project=nevarium-vizor', headers: { cookie } })).body)
    expect(vizor.stats.byProject.map((r) => r.n)).toEqual([2])
  })

  it('дашборд с неизвестным проектом — 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/crm/dashboard?project=нет-такого', headers: { cookie } })
    expect(res.statusCode).toBe(400)
  })

  it('контакт можно перенести в другой проект', async () => {
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Ошибочно в Лабе' }, headers: { cookie } })
    const res = await app.inject({ method: 'PATCH', url: '/api/crm/contacts/1', payload: { project_id: 'nevarium-vizor' }, headers: { cookie } })
    expect(JSON.parse(res.body).item.project_id).toBe(2)
  })
})
