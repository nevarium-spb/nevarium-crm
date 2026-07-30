// @vitest-environment node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, mskToday } from './app.js'
import { hashPassword, resetThrottle, verifyPassword } from './auth.js'
import { bootstrapAdmin } from './bootstrap.js'
import { runBackup } from './backup.js'
import { MIGRATIONS, addWorkdays, now, openDb } from './db.js'
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
    expect(app.db.prepare("SELECT COUNT(*) c FROM outbox WHERE kind = 'lead' AND tg_sent_at IS NULL AND max_sent_at IS NULL").get().c).toBe(1)
  })

  it('чат: detail → заметка сделки, handle → messenger и имя', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/leads', payload: { task: 'чат-бот', detail: 'для клиники', contact: '@tg_user', source: 'chat' } })
    expect(res.statusCode).toBe(204)
    const contact = app.db.prepare('SELECT * FROM contacts WHERE id = 1').get()
    expect(contact).toMatchObject({ name: '@tg_user', messenger: '@tg_user', source: 'site-chat' })
    expect(app.db.prepare('SELECT note FROM deals WHERE id = 1').get().note).toBe('для клиники')
  })

  it('чат: transcript → полная переписка во взаимодействиях, а не в note сделки', async () => {
    const transcript = 'Нева: Здравствуйте!\nКлиент: хочу чат-бота\nНева: на какой масштаб?'
    const res = await app.inject({ method: 'POST', url: '/api/leads', payload: { task: 'чат-бот', detail: 'для клиники', transcript, contact: '@tg_user', source: 'chat' } })
    expect(res.statusCode).toBe(204)
    expect(app.db.prepare('SELECT note FROM deals WHERE id = 1').get().note).toBe('для клиники')
    const interaction = app.db.prepare('SELECT * FROM interactions WHERE contact_id = 1').get()
    expect(interaction).toMatchObject({ type: 'сообщение', note: transcript })
  })

  it('форма без transcript не создаёт взаимодействие', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Клиент', contact: 'k@x.ru' } })
    expect(app.db.prepare('SELECT COUNT(*) c FROM interactions').get().c).toBe(0)
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

  describe('дубли: тот же человек не заводит вторую карточку', () => {
    const lead = (payload) => app.inject({ method: 'POST', url: '/api/leads', payload })
    const count = (t) => app.db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c

    it('форма, потом чат с тем же адресом — один контакт и одна сделка', async () => {
      await lead({ name: 'Марина', contact: 'm@x.ru', task: 'внедрение ИИ' })
      await lead({ contact: 'M@X.RU', task: 'уточняю по чат-боту', detail: 'ещё вопрос', source: 'chat' })
      expect(count('contacts')).toBe(1)
      expect(count('deals')).toBe(1)
      // текст второго обращения не потерялся — он в истории
      const notes = app.db.prepare('SELECT note FROM interactions WHERE contact_id = 1').all().map((r) => r.note).join('\n')
      expect(notes).toContain('Повторная заявка')
      expect(notes).toContain('уточняю по чат-боту')
    })

    it('телефон опознаётся в разных записях: +7, 8 и без кода', async () => {
      await lead({ name: 'Марина', contact: '+7 921 555-14-88' })
      await lead({ name: 'Марина', contact: '8 (921) 555-14-88' })
      await lead({ name: 'Марина', contact: '9215551488' })
      expect(count('contacts')).toBe(1)
    })

    it('разные люди не склеиваются', async () => {
      await lead({ name: 'Марина', contact: 'm@x.ru' })
      await lead({ name: 'Пётр', contact: 'p@x.ru' })
      await lead({ name: 'Иван', contact: '+7 921 000-00-01' })
      expect(count('contacts')).toBe(3)
    })

    it('совпадение имени без совпадения контакта не склеивает', async () => {
      await lead({ name: 'Иван Иванов', contact: 'ivan1@x.ru' })
      await lead({ name: 'Иван Иванов', contact: 'ivan2@x.ru' })
      expect(count('contacts')).toBe(2)
    })

    it('одинаковый контакт в разных проектах — разные карточки: это разные бизнесы', async () => {
      await lead({ name: 'Марина', contact: 'm@x.ru', project: 'nevarium1' })
      await lead({ name: 'Марина', contact: 'm@x.ru', project: 'nevarium-vizor' })
      expect(count('contacts')).toBe(2)
    })

    it('обезличенный контакт не подхватывается — новое обращение это новое согласие', async () => {
      await lead({ name: 'Марина', contact: 'm@x.ru' })
      await app.inject({ method: 'POST', url: '/api/crm/contacts/1/anonymize', headers: { cookie } })
      await lead({ name: 'Марина', contact: 'm@x.ru' })
      expect(count('contacts')).toBe(2)
    })

    it('если все сделки закрыты — заводится новая, а не переиспользуется', async () => {
      await lead({ name: 'Марина', contact: 'm@x.ru', task: 'первый проект' })
      await app.inject({ method: 'PATCH', url: '/api/crm/deals/1', payload: { stage: 'Оплачено' }, headers: { cookie } })
      await lead({ name: 'Марина', contact: 'm@x.ru', task: 'второй проект' })
      expect(count('contacts')).toBe(1)
      expect(count('deals')).toBe(2)
      expect(app.db.prepare('SELECT stage FROM deals WHERE id = 2').get().stage).toBe('Новый')
    })

    it('вернувшийся клиент снимает напоминания воронки возврата', async () => {
      await lead({ name: 'Марина', contact: 'm@x.ru' })
      await app.inject({ method: 'PATCH', url: '/api/crm/deals/1', payload: { stage: 'Проиграно', reason: 'дорого' }, headers: { cookie } })
      expect(app.db.prepare('SELECT COUNT(*) c FROM tasks WHERE done = 0').get().c).toBe(3)

      await lead({ name: 'Марина', contact: 'm@x.ru', task: 'всё-таки решились' })
      expect(app.db.prepare('SELECT COUNT(*) c FROM tasks WHERE done = 0').get().c).toBe(0)
      expect(app.db.prepare('SELECT status FROM winback_sequences WHERE id = 1').get().status).toBe('cancelled')
      // и уведомление говорит именно о возврате, а не о «новой заявке»
      const payload = JSON.parse(app.db.prepare('SELECT payload FROM outbox ORDER BY id DESC LIMIT 1').get().payload)
      expect(leadMessage(payload)).toContain('Клиент вернулся сам')
    })

    it('архивный контакт возвращается из архива, иначе заявка пропала бы из инбокса', async () => {
      await lead({ name: 'Марина', contact: 'm@x.ru' })
      await app.inject({ method: 'PATCH', url: '/api/crm/contacts/1', payload: { archived: 1 }, headers: { cookie } })
      await lead({ name: 'Марина', contact: 'm@x.ru' })
      expect(app.db.prepare('SELECT archived FROM contacts WHERE id = 1').get().archived).toBe(0)
      const dash = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/dashboard', headers: { cookie } })).body)
      expect(dash.inbox.some((c) => c.id === 1)).toBe(true)
    })

    it('повторная заявка помечена в уведомлении, но ПДн в Telegram по-прежнему нет', async () => {
      await lead({ name: 'Марина Соколова', contact: 'm@x.ru' })
      await lead({ name: 'Марина Соколова', contact: 'm@x.ru', task: 'секретная задача' })
      const payload = JSON.parse(app.db.prepare('SELECT payload FROM outbox ORDER BY id DESC LIMIT 1').get().payload)
      const text = leadMessage(payload)
      expect(text).toContain('Повторная заявка')
      expect(text).not.toMatch(/Марина|секретная/)
    })
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

describe('outbox: лид не теряется при падении Telegram или MAX', () => {
  it('ошибка отправки увеличивает attempts, успех ставит sent_at — независимо по каналам', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'm@x.ru' } })
    let tgCalls = 0
    const failingTg = async () => {
      tgCalls++
      if (tgCalls === 1) throw new Error('Telegram down')
    }
    const okMax = async () => {}
    const worker = startOutboxWorker(app.db, { intervalMs: 10_000_000, senders: { tg: failingTg, max: okMax }, log: { warn() {} }, autoStart: false })
    worker.stop()
    await worker.tick()
    let row = app.db.prepare('SELECT * FROM outbox WHERE id = 1').get()
    expect(row.tg_attempts).toBe(1)
    expect(row.tg_sent_at).toBeNull()
    // MAX не зависит от Telegram — уже отправлено с первой попытки
    expect(row.max_sent_at).toBeTruthy()
    await worker.tick()
    row = app.db.prepare('SELECT * FROM outbox WHERE id = 1').get()
    expect(row.tg_sent_at).toBeTruthy()
  })

  it('после 20 попыток запись не берётся в обработку по этому каналу (мёртвая, видна в очереди)', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'm@x.ru' } })
    app.db.prepare('UPDATE outbox SET tg_attempts = 20 WHERE id = 1').run()
    let tgCalls = 0
    let maxCalls = 0
    const worker = startOutboxWorker(app.db, { senders: { tg: async () => { tgCalls++ }, max: async () => { maxCalls++ } }, log: { warn() {} }, autoStart: false })
    worker.stop()
    await worker.tick()
    expect(tgCalls).toBe(0)
    expect(app.db.prepare('SELECT tg_sent_at FROM outbox WHERE id = 1').get().tg_sent_at).toBeNull()
    // MAX не исчерпал попытки — продолжает отправляться
    expect(maxCalls).toBe(1)
    expect(app.db.prepare('SELECT max_sent_at FROM outbox WHERE id = 1').get().max_sent_at).toBeTruthy()
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

  it('условный заказ клиента: в MAX уходит с ФИО и контактом, в Telegram — обезличено', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/leads',
      payload: { task: 'внедрение чат-бота', name: 'Марина Соколова', contact: '+7 921 555-14-88', note: 'нужен запуск до конца месяца' },
    })
    let tgText = ''
    let maxText = ''
    const worker = startOutboxWorker(app.db, {
      senders: {
        tg: async (text) => { tgText = text },
        max: async (text) => { maxText = text },
      },
      log: { warn() {} },
      autoStart: false,
    })
    worker.stop()
    await worker.tick()

    expect(tgText).not.toMatch(/Марина|555-14-88|внедрение чат-бота|нужен запуск/)
    expect(maxText).toContain('Марина Соколова')
    expect(maxText).toContain('555-14-88')
    expect(maxText).toContain('внедрение чат-бота')
    expect(maxText).toContain('нужен запуск до конца месяца')
  })
})

describe('экспорт / импорт / CSV', () => {
  // Раунд-трип обязан покрывать ВСЕ четыре сущности: экспорт отдаёт `SELECT *`, а импорт
  // сверяет колонки с белым списком, поэтому забытая в списке колонка ломает импорт
  // своего же экспорта. Так уже случалось дважды — с `winback_sequence_id` (Веха 7)
  // и `anonymized_at` (права ПДн), и оба раза только на задачах/контактах.
  it('раунд-трип: экспорт → wipe → импорт, все сущности и все колонки', async () => {
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов', phone: '+7 999' }, headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/crm/deals', payload: { contact_id: 1, title: 'Пилот', amount: 777 }, headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/crm/tasks', payload: { title: 'Позвонить', contact_id: 1, due_date: '2026-08-01' }, headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/crm/interactions', payload: { contact_id: 1, type: 'звонок', note: 'обсудили' }, headers: { cookie } })
    const dump = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })).body)
    expect(dump.contacts).toHaveLength(1)
    expect(dump.tasks).toHaveLength(1)
    expect(dump.interactions).toHaveLength(1)
    const res = await app.inject({ method: 'POST', url: '/api/crm/import', payload: dump, headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(app.db.prepare('SELECT name FROM contacts WHERE id = 1').get().name).toBe('Иванов')
    expect(app.db.prepare('SELECT amount FROM deals WHERE id = 1').get().amount).toBe(777)
    expect(app.db.prepare('SELECT title FROM tasks WHERE id = 1').get().title).toBe('Позвонить')
    expect(app.db.prepare('SELECT note FROM interactions WHERE id = 1').get().note).toBe('обсудили')
  })

  // На App Platform нет shell — файл базы туда не положить, и «Импорт JSON» остаётся
  // единственным путём восстановления. Всё, чего нет в дампе, при потере диска
  // исчезает навсегда, поэтому записи об исполнении запросов ПДн и журнал обязаны
  // в нём быть: именно ими это исполнение доказывают.
  it('запросы ПДн и журнал действий переживают экспорт → wipe → импорт', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'm@x.ru' } })
    await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'm@x.ru', kind: 'delete', note: 'прошу удалить' } })
    await app.inject({ method: 'PATCH', url: '/api/crm/pd-requests/1', payload: { status: 'done', anonymize: true }, headers: { cookie } })

    const dump = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })).body)
    expect(dump.version).toBe(2)
    expect(dump.pd_requests).toHaveLength(1)
    expect(dump.audit_log.some((a) => a.action === 'anonymize')).toBe(true)

    app.db.exec('DELETE FROM pd_requests; DELETE FROM audit_log')
    const res = await app.inject({ method: 'POST', url: '/api/crm/import', payload: dump, headers: { cookie } })
    expect(res.statusCode).toBe(200)

    const restored = app.db.prepare('SELECT * FROM pd_requests WHERE id = 1').get()
    expect(restored).toMatchObject({ kind: 'delete', status: 'done', requester: 'm@x.ru', contact_id: 1 })
    expect(app.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'anonymize'").get().c).toBe(1)
  })

  it('старый дамп (v1) не стирает сегодняшние записи о ПДн, но рвёт их привязку к контактам', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'm@x.ru' } })
    await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'm@x.ru' } })
    expect(app.db.prepare('SELECT contact_id FROM pd_requests WHERE id = 1').get().contact_id).toBe(1)

    // дамп в старом формате: без pd_requests и audit_log
    const dump = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })).body)
    const legacy = { version: 1, contacts: dump.contacts, deals: dump.deals, tasks: dump.tasks, interactions: dump.interactions }
    const res = await app.inject({ method: 'POST', url: '/api/crm/import', payload: legacy, headers: { cookie } })
    expect(res.statusCode).toBe(200)

    // запрос жив — это юридический след, стирать его старым файлом нельзя
    const row = app.db.prepare('SELECT * FROM pd_requests WHERE id = 1').get()
    expect(row.requester).toBe('m@x.ru')
    // но привязку разорвали: контакты заменены целиком, id мог достаться другому человеку
    expect(row.contact_id).toBeNull()
  })

  it('дамп из будущей версии отклоняется', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/crm/import', payload: { version: 99, contacts: [] }, headers: { cookie } })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('newer_version')
  })

  it('раунд-трип переживает обезличенный контакт и задачу из воронки возврата', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'm@x.ru' } })
    await app.inject({ method: 'PATCH', url: '/api/crm/deals/1', payload: { stage: 'Проиграно', reason: 'дорого' }, headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Пётр' }, headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/crm/contacts/2/anonymize', headers: { cookie } })
    expect(app.db.prepare('SELECT COUNT(*) c FROM tasks WHERE winback_sequence_id IS NOT NULL').get().c).toBe(3)

    const dump = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })).body)
    const res = await app.inject({ method: 'POST', url: '/api/crm/import', payload: dump, headers: { cookie } })
    expect(res.statusCode).toBe(200)
    // признак обезличивания сохранился — восстановление не «расконсервирует» человека
    expect(app.db.prepare('SELECT name, anonymized_at FROM contacts WHERE id = 2').get().anonymized_at).toBeTruthy()
    // задачи серии на месте, но ссылка на серию обнулена: самих серий в дампе нет
    expect(app.db.prepare('SELECT COUNT(*) c FROM tasks').get().c).toBe(3)
    expect(app.db.prepare('SELECT COUNT(*) c FROM tasks WHERE winback_sequence_id IS NOT NULL').get().c).toBe(0)
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

  describe('«остывают» — сделки, о которых забыли', () => {
    // Сделку «состариваем» прямой правкой created_at: через API этого не сделать,
    // а ждать трое суток в тесте не вариант.
    const age = (table, id, daysAgo) =>
      app.db.prepare(`UPDATE ${table} SET created_at = ? WHERE id = ?`)
        .run(new Date(Date.now() - daysAgo * 864e5).toISOString(), id)

    const cooling = async () =>
      JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/dashboard', headers: { cookie } })).body).cooling

    it('сделка без единого взаимодействия попадает в блок, свежая — нет', async () => {
      await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Забытый' }, headers: { cookie } })
      await app.inject({ method: 'POST', url: '/api/crm/deals', payload: { contact_id: 1, title: 'Тихая' }, headers: { cookie } })
      age('deals', 1, 5)
      await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Свежий' }, headers: { cookie } })
      await app.inject({ method: 'POST', url: '/api/crm/deals', payload: { contact_id: 2, title: 'Свежая' }, headers: { cookie } })

      const rows = await cooling()
      expect(rows.map((r) => r.title)).toEqual(['Тихая'])
      expect(rows[0].no_touch).toBe(1)
      expect(rows[0].contact_name).toBe('Забытый')
    })

    it('свежее взаимодействие снимает сделку с «остывающих»', async () => {
      await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Клиент' }, headers: { cookie } })
      await app.inject({ method: 'POST', url: '/api/crm/deals', payload: { contact_id: 1, title: 'Сделка' }, headers: { cookie } })
      age('deals', 1, 5)
      expect((await cooling())).toHaveLength(1)
      await app.inject({ method: 'POST', url: '/api/crm/interactions', payload: { contact_id: 1, type: 'звонок', note: 'связались' }, headers: { cookie } })
      expect((await cooling())).toHaveLength(0)
    })

    it('открытая задача означает «договорились» — сделка не остывает, закрытая не спасает', async () => {
      await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Клиент' }, headers: { cookie } })
      await app.inject({ method: 'POST', url: '/api/crm/deals', payload: { contact_id: 1, title: 'Сделка' }, headers: { cookie } })
      age('deals', 1, 5)
      await app.inject({ method: 'POST', url: '/api/crm/tasks', payload: { title: 'Позвонить в среду', contact_id: 1 }, headers: { cookie } })
      expect((await cooling())).toHaveLength(0)
      await app.inject({ method: 'PATCH', url: '/api/crm/tasks/1', payload: { done: 1 }, headers: { cookie } })
      expect((await cooling())).toHaveLength(1)
    })

    it('закрытые и обезличенные в блок не попадают', async () => {
      await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Выигранный' }, headers: { cookie } })
      await app.inject({ method: 'POST', url: '/api/crm/deals', payload: { contact_id: 1, title: 'Оплаченная' }, headers: { cookie } })
      await app.inject({ method: 'PATCH', url: '/api/crm/deals/1', payload: { stage: 'Оплачено' }, headers: { cookie } })
      age('deals', 1, 5)

      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Ушедший', contact: 'u@x.ru' } })
      age('deals', 2, 5)
      await app.inject({ method: 'POST', url: '/api/crm/contacts/2/anonymize', headers: { cookie } })

      expect((await cooling())).toHaveLength(0)
    })

    it('блок уважает фильтр по проекту', async () => {
      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Лаб', contact: 'l@x.ru', project: 'nevarium1' } })
      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Визор', contact: 'v@x.ru', project: 'nevarium-vizor' } })
      age('deals', 1, 5)
      age('deals', 2, 5)
      const all = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/dashboard?project=all', headers: { cookie } })).body).cooling
      expect(all).toHaveLength(2)
      const vizor = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/dashboard?project=nevarium-vizor', headers: { cookie } })).body).cooling
      expect(vizor.map((r) => r.contact_name)).toEqual(['Визор'])
    })
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

describe('воронка возврата после отказа', () => {
  // создаём контакт + сделку, возвращаем id сделки
  async function makeDeal() {
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Отказавшийся' }, headers: { cookie } })
    const res = await app.inject({ method: 'POST', url: '/api/crm/deals', payload: { contact_id: 1, title: 'Пилот' }, headers: { cookie } })
    return JSON.parse(res.body).item.id
  }
  const toStage = (id, stage, extra = {}) =>
    app.inject({ method: 'PATCH', url: `/api/crm/deals/${id}`, payload: { stage, ...extra }, headers: { cookie } })

  it('перевод в «Проиграно» заводит серию задач на два месяца', async () => {
    const id = await makeDeal()
    const res = await toStage(id, 'Проиграно', { lostReason: 'дорого' })
    expect(JSON.parse(res.body).winback).toMatchObject({ started: true, tasks: 3 })

    const seq = app.db.prepare('SELECT * FROM winback_sequences').get()
    expect(seq).toMatchObject({ deal_id: id, contact_id: 1, reason: 'дорого', status: 'active' })

    const tasks = app.db.prepare('SELECT * FROM tasks WHERE winback_sequence_id = ? ORDER BY due_date').all(seq.id)
    expect(tasks).toHaveLength(3)
    // задачи привязаны к клиенту и сделке, а сроки — в будущем и по возрастанию
    expect(tasks.every((t) => t.contact_id === 1 && t.deal_id === id && t.done === 0)).toBe(true)
    const today = mskToday()
    expect(tasks[0].due_date > today).toBe(true)
    expect(tasks[2].due_date > tasks[0].due_date).toBe(true)
  })

  it('возврат сделки в работу отменяет незакрытые напоминания, выполненные оставляет', async () => {
    const id = await makeDeal()
    await toStage(id, 'Проиграно')
    const seqId = app.db.prepare('SELECT id FROM winback_sequences').get().id
    // менеджер успел закрыть первую задачу до возврата сделки
    const firstTask = app.db.prepare('SELECT id FROM tasks WHERE winback_sequence_id = ? ORDER BY due_date').get(seqId)
    await app.inject({ method: 'PATCH', url: `/api/crm/tasks/${firstTask.id}`, payload: { done: 1 }, headers: { cookie } })

    const res = await toStage(id, 'Переговоры')
    expect(JSON.parse(res.body).winback).toMatchObject({ cancelled: true, tasks: 2 })

    const left = app.db.prepare('SELECT * FROM tasks WHERE winback_sequence_id = ?').all(seqId)
    expect(left).toHaveLength(1) // осталась только выполненная — это история работы
    expect(left[0].done).toBe(1)
    expect(app.db.prepare('SELECT status FROM winback_sequences WHERE id = ?').get(seqId).status).toBe('cancelled')
  })

  it('повторный перевод в «Проиграно» не плодит дубли задач', async () => {
    const id = await makeDeal()
    await toStage(id, 'Проиграно')
    await toStage(id, 'Проиграно') // тот же статус — смены стадии нет
    expect(app.db.prepare('SELECT COUNT(*) c FROM winback_sequences').get().c).toBe(1)
    expect(app.db.prepare('SELECT COUNT(*) c FROM tasks WHERE winback_sequence_id IS NOT NULL').get().c).toBe(3)
  })

  it('другие терминальные стадии воронку не запускают', async () => {
    const id = await makeDeal()
    const res = await toStage(id, 'Оплачено')
    expect(JSON.parse(res.body).winback).toBeNull()
    expect(app.db.prepare('SELECT COUNT(*) c FROM winback_sequences').get().c).toBe(0)
  })

  it('удаление сделки с воронкой не падает и убирает её задачи', async () => {
    const id = await makeDeal()
    await toStage(id, 'Проиграно')
    const del = await app.inject({ method: 'DELETE', url: `/api/crm/deals/${id}`, headers: { cookie } })
    expect(del.statusCode).toBe(200)
    expect(app.db.prepare('SELECT COUNT(*) c FROM winback_sequences').get().c).toBe(0)
    expect(app.db.prepare('SELECT COUNT(*) c FROM tasks WHERE winback_sequence_id IS NOT NULL').get().c).toBe(0)
  })

  it('обычные задачи серией не помечены и живут своей жизнью', async () => {
    const id = await makeDeal()
    await app.inject({ method: 'POST', url: '/api/crm/tasks', payload: { title: 'Обычная задача', contact_id: 1 }, headers: { cookie } })
    await toStage(id, 'Проиграно')
    await toStage(id, 'Контакт') // отмена серии не должна задеть обычную задачу
    const plain = app.db.prepare("SELECT * FROM tasks WHERE title = 'Обычная задача'").get()
    expect(plain.winback_sequence_id).toBeNull()
  })
})

describe('bootstrapAdmin — первый админ без shell-доступа', () => {
  const silent = { warn() {}, error() {}, info() {} }

  it('без переменных окружения ничего не делает', async () => {
    const created = await bootstrapAdmin(app.db, { log: silent, env: {} })
    expect(created).toBe(false)
  })

  it('создаёт админа на пустой базе и пароль реально проверяется', async () => {
    app.db.exec('DELETE FROM users') // beforeEach уже создал тестового пользователя
    const env = { BOOTSTRAP_ADMIN_EMAIL: 'Boss@Example.ru', BOOTSTRAP_ADMIN_PASSWORD: 'supersecret1' }
    const created = await bootstrapAdmin(app.db, { log: silent, env })
    expect(created).toBe(true)
    const user = app.db.prepare('SELECT * FROM users WHERE email = ?').get('boss@example.ru')
    expect(user).toMatchObject({ role: 'admin', name: 'Админ' })
    expect(await verifyPassword('supersecret1', user.password_hash)).toBe(true)
  })

  it('не трогает базу, если пользователи уже есть', async () => {
    const before = app.db.prepare('SELECT COUNT(*) c FROM users').get().c
    const created = await bootstrapAdmin(app.db, {
      log: silent,
      env: { BOOTSTRAP_ADMIN_EMAIL: 'x@x.ru', BOOTSTRAP_ADMIN_PASSWORD: 'supersecret1' },
    })
    expect(created).toBe(false)
    expect(app.db.prepare('SELECT COUNT(*) c FROM users').get().c).toBe(before)
  })

  it('слишком короткий пароль — админ не создаётся', async () => {
    app.db.exec('DELETE FROM users')
    const created = await bootstrapAdmin(app.db, {
      log: silent,
      env: { BOOTSTRAP_ADMIN_EMAIL: 'x@x.ru', BOOTSTRAP_ADMIN_PASSWORD: 'short' },
    })
    expect(created).toBe(false)
    expect(app.db.prepare('SELECT COUNT(*) c FROM users').get().c).toBe(0)
  })
})

describe('права субъекта ПДн (152-ФЗ)', () => {
  it('дедлайн считается в рабочих днях, выходные пропускаются', () => {
    // 2026-07-30 — четверг; +10 рабочих дней = 2026-08-13 (два уик-энда позади)
    expect(addWorkdays('2026-07-30', 10)).toBe('2026-08-13')
    // пятница +1 рабочий день = понедельник, а не суббота
    expect(addWorkdays('2026-07-31', 1)).toBe('2026-08-03')
  })

  it('запрос с сайта регистрируется, сам находит клиента по email и ставит срок', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'marina@x.ru' } })
    const res = await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'marina@x.ru', kind: 'delete' } })
    expect(res.statusCode).toBe(204)
    const row = app.db.prepare('SELECT * FROM pd_requests WHERE id = 1').get()
    expect(row).toMatchObject({ contact_id: 1, kind: 'delete', status: 'new', source: 'site-form' })
    expect(row.due_date).toBe(addWorkdays(mskToday()))
  })

  it('незнакомый адрес не теряется — запрос заводится без привязки к контакту', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'кто-то@ещё.ru' } })
    expect(res.statusCode).toBe(204)
    expect(app.db.prepare('SELECT contact_id FROM pd_requests WHERE id = 1').get().contact_id).toBeNull()
  })

  it('уведомление о запросе обезличено для обоих каналов', async () => {
    await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'marina@secret.ru', note: 'прошу удалить всё' } })
    const payload = JSON.parse(app.db.prepare("SELECT payload FROM outbox WHERE kind = 'text' ORDER BY id DESC LIMIT 1").get().payload)
    expect(payload.text).not.toMatch(/marina@secret\.ru|прошу удалить/)
    expect(payload.text).toContain('Запрос по персональным данным')
  })

  it('без контакта запрос не принимается', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { note: 'без адреса' } })
    expect(res.statusCode).toBe(400)
  })

  it('обезличивание стирает ПДн, но сохраняет сделку и её стадию', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/leads',
      payload: { name: 'Марина Соколова', contact: '+7 921 555-14-88', task: 'внедрение ИИ', note: 'звонить после 18', transcript: 'Клиент: меня зовут Марина, телефон 555-14-88', source: 'chat' },
    })
    app.db.prepare("INSERT INTO tasks (title, contact_id, created_at, updated_at) VALUES ('Позвонить Марине', 1, ?, ?)").run(now(), now())
    const res = await app.inject({ method: 'POST', url: '/api/crm/contacts/1/anonymize', headers: { cookie } })
    expect(res.statusCode).toBe(200)

    const contact = app.db.prepare('SELECT * FROM contacts WHERE id = 1').get()
    expect(contact.name).toBe('Удалённый контакт #1')
    expect([contact.phone, contact.email, contact.messenger, contact.note]).toEqual(['', '', '', ''])
    expect(contact.anonymized_at).toBeTruthy()

    // сделка на месте — воронка за прошлые периоды не поехала
    const deal = app.db.prepare('SELECT * FROM deals WHERE contact_id = 1').get()
    expect(deal.stage).toBe('Новый')
    expect(deal.note).toBe('')
    // транскрипт затёрт, но строка взаимодействия осталась для статистики активности
    const inter = app.db.prepare('SELECT * FROM interactions WHERE contact_id = 1').get()
    expect(inter.note).toBe('')
    // задачи удалены: обработку требовали прекратить
    expect(app.db.prepare('SELECT COUNT(*) c FROM tasks WHERE contact_id = 1').get().c).toBe(0)
    // и всё это попало в журнал
    expect(app.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'anonymize'").get().c).toBe(1)
  })

  it('обезличивание отменяет активную воронку возврата', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Пётр', contact: 'p@x.ru' } })
    await app.inject({ method: 'PATCH', url: '/api/crm/deals/1', payload: { stage: 'Проиграно', reason: 'дорого' }, headers: { cookie } })
    expect(app.db.prepare("SELECT COUNT(*) c FROM winback_sequences WHERE status = 'active'").get().c).toBe(1)
    await app.inject({ method: 'POST', url: '/api/crm/contacts/1/anonymize', headers: { cookie } })
    expect(app.db.prepare("SELECT status FROM winback_sequences WHERE id = 1").get().status).toBe('cancelled')
    expect(app.db.prepare('SELECT COUNT(*) c FROM tasks WHERE contact_id = 1').get().c).toBe(0)
  })

  it('повторное обезличивание безвредно и не портит заглушку', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'm@x.ru' } })
    await app.inject({ method: 'POST', url: '/api/crm/contacts/1/anonymize', headers: { cookie } })
    const first = app.db.prepare('SELECT anonymized_at FROM contacts WHERE id = 1').get().anonymized_at
    const res = await app.inject({ method: 'POST', url: '/api/crm/contacts/1/anonymize', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(app.db.prepare('SELECT name, anonymized_at FROM contacts WHERE id = 1').get())
      .toEqual({ name: 'Удалённый контакт #1', anonymized_at: first })
  })

  it('исполнение запроса из списка: статус done + обезличивание одним действием', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'marina@x.ru' } })
    await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'marina@x.ru' } })
    const res = await app.inject({ method: 'PATCH', url: '/api/crm/pd-requests/1', payload: { status: 'done', anonymize: true }, headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).anonymized.name).toBe('Удалённый контакт #1')
    const row = app.db.prepare('SELECT * FROM pd_requests WHERE id = 1').get()
    expect(row.status).toBe('done')
    expect(row.resolved_at).toBeTruthy()
  })

  it('на запрос «узнать, какие данные есть» обезличивание не срабатывает', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'marina@x.ru' } })
    await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'marina@x.ru', kind: 'access' } })
    const res = await app.inject({ method: 'PATCH', url: '/api/crm/pd-requests/1', payload: { anonymize: true }, headers: { cookie } })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('kind_not_erasable')
    expect(app.db.prepare('SELECT anonymized_at FROM contacts WHERE id = 1').get().anonymized_at).toBeNull()
  })

  it('обезличенный контакт не подхватывается новым запросом по старому адресу', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'marina@x.ru' } })
    await app.inject({ method: 'POST', url: '/api/crm/contacts/1/anonymize', headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'marina@x.ru' } })
    expect(app.db.prepare('SELECT contact_id FROM pd_requests WHERE id = 1').get().contact_id).toBeNull()
  })

  it('журнал действий пишется в базу и доступен только администратору', async () => {
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Тест' }, headers: { cookie } })
    const row = app.db.prepare("SELECT * FROM audit_log WHERE entity = 'contacts' ORDER BY id DESC LIMIT 1").get()
    expect(row).toMatchObject({ action: 'create', entity: 'contacts', user_email: 'a@a.ru' })

    const asAdmin = await app.inject({ method: 'GET', url: '/api/crm/audit', headers: { cookie } })
    expect(asAdmin.statusCode).toBe(200)
    expect(JSON.parse(asAdmin.body).items.length).toBeGreaterThan(0)

    app.db.prepare('INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)')
      .run('Участник', 'm@m.ru', app.db.prepare('SELECT password_hash h FROM users WHERE id = 1').get().h, 'member', now())
    const memberCookie = (await login('m@m.ru', 'password123')).headers['set-cookie']
    const asMember = await app.inject({ method: 'GET', url: '/api/crm/audit', headers: { cookie: memberCookie } })
    expect(asMember.statusCode).toBe(403)
  })
})

describe('бэкап: файл базы уходит в MAX, но никогда в Telegram', () => {
  const silent = { warn() {}, error() {}, info() {} }
  const maxEnv = { MAX_BOT_TOKEN: 'max-token', MAX_CHAT_ID: '42' }
  let dir

  beforeEach(() => {
    dir = path.join(os.tmpdir(), `nv-backup-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('в MAX уходят обе копии: JSON для восстановления и файл базы', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина Соколова', contact: '+7 921 555-14-88' } })
    const sent = []
    const { file, jsonFile } = await runBackup(app.db, {
      dir,
      env: maxEnv,
      log: silent,
      sendDocument: async (f, caption) => sent.push({ f, caption }),
      sendStatus: async () => { throw new Error('статус не нужен, когда всё прошло') },
    })
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.existsSync(jsonFile)).toBe(true)
    // JSON первым: именно им восстанавливаются там, где нет shell
    expect(sent.map((s) => s.f)).toEqual([jsonFile, file])
    expect(sent[0].caption).toContain('Импорт JSON')

    // в копиях действительно лежат ПДн — именно поэтому их нельзя в Telegram
    const copy = new Database(file, { readonly: true })
    expect(copy.prepare('SELECT name FROM contacts WHERE id = 1').get().name).toBe('Марина Соколова')
    copy.close()
    expect(JSON.parse(fs.readFileSync(jsonFile, 'utf8')).contacts[0].name).toBe('Марина Соколова')
  })

  it('ночной JSON пригоден для восстановления: его принимает «Импорт JSON»', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'm@x.ru' } })
    await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'm@x.ru', kind: 'delete' } })
    const { jsonFile } = await runBackup(app.db, { dir, env: {}, log: silent, sendDocument: async () => {}, sendStatus: async () => {} })

    // катастрофа: база опустела
    app.db.exec('DELETE FROM pd_requests; DELETE FROM interactions; DELETE FROM tasks; DELETE FROM deals; DELETE FROM contacts')
    const dump = JSON.parse(fs.readFileSync(jsonFile, 'utf8'))
    const res = await app.inject({ method: 'POST', url: '/api/crm/import', payload: dump, headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(app.db.prepare('SELECT name FROM contacts WHERE id = 1').get().name).toBe('Марина')
    expect(app.db.prepare('SELECT COUNT(*) c FROM pd_requests').get().c).toBe(1)
  })

  it('если MAX не настроен — копии остаются на сервере, статус обезличен, файлы никуда не уходят', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина Соколова', contact: '+7 921 555-14-88' } })
    const docs = []
    const statuses = []
    const { file } = await runBackup(app.db, {
      dir,
      env: {},
      log: silent,
      sendDocument: async (f) => docs.push(f),
      sendStatus: async (text) => statuses.push(text),
    })
    expect(fs.existsSync(file)).toBe(true)
    expect(docs).toHaveLength(0)
    expect(statuses).toHaveLength(1)
    expect(statuses[0]).not.toMatch(/Марина|555-14-88/)
  })

  it('ошибка отправки не теряет копию и сообщает обезличенным статусом', async () => {
    const statuses = []
    const { file } = await runBackup(app.db, {
      dir,
      env: maxEnv,
      log: silent,
      sendDocument: async () => { throw new Error('MAX недоступен') },
      sendStatus: async (text) => statuses.push(text),
    })
    expect(fs.existsSync(file)).toBe(true)
    expect(statuses[0]).toContain('не отправился')
  })

  it('ротация оставляет 7 последних дат, обе копии каждой', async () => {
    fs.mkdirSync(dir, { recursive: true })
    for (const d of ['01', '02', '03', '04', '05', '06', '07', '08', '09']) {
      fs.writeFileSync(path.join(dir, `crm-2026-01-${d}.sqlite`), 'старая копия')
      fs.writeFileSync(path.join(dir, `crm-2026-01-${d}.json`), '{}')
    }
    await runBackup(app.db, { dir, env: {}, log: silent, sendDocument: async () => {}, sendStatus: async () => {} })
    const stamps = [...new Set(fs.readdirSync(dir).filter((f) => f.startsWith('crm-')).map((f) => f.slice(4, 14)))]
    expect(stamps).toHaveLength(7)
    expect(stamps).not.toContain('2026-01-01')
    expect(stamps).toContain(new Date().toISOString().slice(0, 10))
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
