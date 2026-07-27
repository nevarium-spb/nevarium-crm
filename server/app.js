import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { DEFAULT_PROJECT_ID, openDb, now, STAGES, TERMINAL_STAGES } from './db.js'
import { hashPassword, verifyPassword, signToken, verifyToken, loginThrottle, loginFailed, loginSucceeded, SESSION_TTL_DAYS } from './auth.js'
import { enqueue } from './telegram.js'

const COOKIE = 'nv_session'
const MSK = 'Europe/Moscow'
const LIST_SCAN_LIMIT = 2000
const LIST_PAGE_SIZE = 500
const LEAD_WINDOW_MS = 60_000
const LEAD_MAX_PER_WINDOW = 3

export function mskToday(offsetDays = 0, nowMs = Date.now()) {
  const d = new Date(nowMs + offsetDays * 864e5)
  return new Intl.DateTimeFormat('sv-SE', { timeZone: MSK }).format(d) // YYYY-MM-DD
}

const trim = (v, max = 500) => String(v ?? '').trim().slice(0, max)

export function buildApp({ dbFile = ':memory:', secret = 'dev-secret', secure = true, logger = false } = {}) {
  const db = openDb(dbFile)
  const app = Fastify({ logger, trustProxy: true })
  app.register(cookie)
  app.decorate('db', db)

  // Скользящее окно per-IP для публичного приёма лидов: не отбрасываем,
  // а помечаем «подозрительный» (CGNAT в РФ делает ложные срабатывания реальными).
  // Map живёт в инстансе приложения; пустые ключи выметаются периодически,
  // иначе публичный endpoint растил бы память по одному ключу на IP.
  const leadHits = new Map()
  function leadSuspicious(ip) {
    const nowMs = Date.now()
    const list = (leadHits.get(ip) || []).filter((t) => nowMs - t < LEAD_WINDOW_MS)
    list.push(nowMs)
    leadHits.set(ip, list)
    return list.length > LEAD_MAX_PER_WINDOW
  }
  const leadSweep = setInterval(() => {
    const nowMs = Date.now()
    for (const [ip, list] of leadHits) {
      if (!list.length || nowMs - list[list.length - 1] > LEAD_WINDOW_MS) leadHits.delete(ip)
    }
  }, 5 * 60_000)
  leadSweep.unref?.()
  app.addHook('onClose', (_i, done) => {
    clearInterval(leadSweep)
    done()
  })

  const getUser = (req) => {
    const data = verifyToken(req.cookies?.[COOKIE], secret)
    if (!data) return null
    const user = db.prepare('SELECT id, name, email, role, token_version FROM users WHERE id = ?').get(data.uid)
    if (!user || user.token_version !== data.tv) return null
    return user
  }

  // Auth + Origin-проверка на мутациях для всего /api/crm/*
  app.addHook('preHandler', (req, reply, done) => {
    if (!req.url.startsWith('/api/crm/')) return done()
    const user = getUser(req)
    if (!user) return reply.code(401).send({ error: 'unauthorized' })
    if (req.method !== 'GET') {
      // за прокси (Caddy/Vite) реальный хост приходит в X-Forwarded-Host
      const origin = req.headers.origin
      const selfHost = req.headers['x-forwarded-host'] || req.headers.host
      if (origin && new URL(origin).host !== selfHost) {
        return reply.code(403).send({ error: 'forbidden' })
      }
    }
    req.user = user
    done()
  })

  const audit = (req, action, entity, id) =>
    app.log?.info?.({ user: req.user?.email, action, entity, id }, 'mutation')

  // ---------- auth ----------
  app.post('/api/auth/login', async (req, reply) => {
    const email = trim(req.body?.email, 200).toLowerCase()
    const password = String(req.body?.password ?? '')
    const key = `${req.ip}|${email}`
    const wait = loginThrottle(key)
    if (wait) return reply.code(429).send({ error: 'throttled', retryAfter: wait })
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email)
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      loginFailed(key)
      return reply.code(401).send({ error: 'invalid_credentials' })
    }
    loginSucceeded(key)
    const token = signToken({ uid: user.id, tokenVersion: user.token_version }, secret)
    reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: SESSION_TTL_DAYS * 86400 })
    return { id: user.id, name: user.name, email: user.email, role: user.role }
  })

  app.post('/api/auth/logout', async (req, reply) => {
    reply.clearCookie(COOKIE, { path: '/' })
    return { ok: true }
  })

  app.get('/api/auth/me', async (req, reply) => {
    const user = getUser(req)
    if (!user) return reply.code(401).send({ error: 'unauthorized' })
    return { id: user.id, name: user.name, email: user.email, role: user.role }
  })

  // ---------- generic CRUD ----------
  const ENTITIES = {
    contacts: {
      fields: ['name', 'company', 'phone', 'email', 'messenger', 'note', 'source', 'suspicious', 'archived', 'project_id'],
      required: ['name'],
    },
    deals: { fields: ['contact_id', 'title', 'stage', 'amount', 'note', 'project_id'], required: ['contact_id', 'title'] },
    tasks: { fields: ['title', 'contact_id', 'deal_id', 'due_date', 'done'], required: ['title'] },
    interactions: { fields: ['contact_id', 'deal_id', 'type', 'note', 'happened_at'], required: ['contact_id'] },
  }

  // Проект есть только у сущностей-носителей заявки; задачи и взаимодействия
  // наследуют его через контакт — иначе появился бы второй источник правды.
  const PROJECT_SCOPED = new Set(['contacts', 'deals'])

  /** Проект по origin сайта (см. колонку projects.origins). null — не наш домен. */
  function projectByOrigin(origin) {
    const o = trim(origin, 200).toLowerCase().replace(/\/+$/, '')
    if (!o) return null
    const rows = db.prepare("SELECT id, slug, display_name, origins FROM projects WHERE archived = 0 AND origins != ''").all()
    return (
      rows.find((p) =>
        p.origins
          .toLowerCase()
          .split(',')
          .map((s) => s.trim().replace(/\/+$/, ''))
          .filter(Boolean)
          .includes(o)
      ) || null
    )
  }

  /**
   * Проект по slug («nevarium1») или числовому id.
   * null — фильтр не запрошен; undefined — запрошен несуществующий проект (→ 400).
   */
  function resolveProjectId(value) {
    const raw = trim(value, 100)
    if (!raw || raw === 'all') return null
    const asId = Number(raw)
    const row =
      Number.isInteger(asId) && asId > 0
        ? db.prepare('SELECT id FROM projects WHERE id = ?').get(asId)
        : db.prepare('SELECT id FROM projects WHERE slug = ?').get(raw)
    return row ? row.id : undefined
  }

  function pick(body, spec) {
    const out = {}
    for (const f of spec.fields) {
      if (body[f] === undefined) continue
      out[f] = typeof body[f] === 'string' ? trim(body[f], 2000) : body[f]
    }
    return out
  }

  for (const [name, spec] of Object.entries(ENTITIES)) {
    app.get(`/api/crm/${name}`, async (req, reply) => {
      const q = trim(req.query?.q, 100).toLowerCase()
      const projectId = resolveProjectId(req.query?.project)
      if (projectId === undefined) return reply.code(400).send({ error: 'unknown_project' })
      const scoped = projectId !== null && PROJECT_SCOPED.has(name)
      let rows = db
        .prepare(
          `SELECT * FROM ${name} ${scoped ? 'WHERE project_id = ?' : ''} ORDER BY updated_at DESC LIMIT ${LIST_SCAN_LIMIT}`
        )
        .all(...(scoped ? [projectId] : []))
      if (q && name === 'contacts')
        rows = rows.filter((r) => [r.name, r.company, r.phone, r.email, r.messenger].join(' ').toLowerCase().includes(q))
      return { items: rows.slice(0, LIST_PAGE_SIZE), total: rows.length }
    })

    app.post(`/api/crm/${name}`, async (req, reply) => {
      const data = pick(req.body ?? {}, spec)
      for (const f of spec.required) if (!data[f]) return reply.code(400).send({ error: `field_required`, field: f })
      if (name === 'deals' && data.stage && !STAGES.includes(data.stage)) return reply.code(400).send({ error: 'bad_stage' })
      if (PROJECT_SCOPED.has(name)) {
        if (data.project_id !== undefined) {
          const pid = resolveProjectId(data.project_id)
          if (!pid) return reply.code(400).send({ error: 'bad_project' })
          data.project_id = pid
        } else if (name === 'deals') {
          // сделка наследует проект своего контакта — чтобы они не разъехались
          const owner = db.prepare('SELECT project_id FROM contacts WHERE id = ?').get(data.contact_id)
          if (owner) data.project_id = owner.project_id
        }
      }
      if (name === 'interactions') data.happened_at = data.happened_at || now()
      const ts = now()
      // предупреждение о дубликате контакта по телефону/email
      let duplicateOf = null
      if (name === 'contacts' && (data.phone || data.email)) {
        const dup = db
          .prepare("SELECT id, name FROM contacts WHERE archived = 0 AND ((phone != '' AND phone = ?) OR (email != '' AND email = ?)) LIMIT 1")
          .get(data.phone ?? '', data.email ?? '')
        if (dup) duplicateOf = dup
      }
      const cols = Object.keys(data)
      const stmt = db.prepare(
        `INSERT INTO ${name} (${cols.join(',')}, created_at, updated_at, created_by) VALUES (${cols.map(() => '?').join(',')}, ?, ?, ?)`
      )
      let info
      try {
        info = stmt.run(...cols.map((c) => data[c]), ts, ts, req.user.id)
      } catch (err) {
        if (String(err).includes('FOREIGN KEY')) return reply.code(400).send({ error: 'bad_reference' })
        throw err
      }
      audit(req, 'create', name, info.lastInsertRowid)
      const row = db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(info.lastInsertRowid)
      return { item: row, duplicateOf }
    })

    app.patch(`/api/crm/${name}/:id`, async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id' })
      const existing = db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(id)
      if (!existing) return reply.code(404).send({ error: 'not_found' })
      const expected = req.body?.expectedUpdatedAt
      if (expected && expected !== existing.updated_at)
        return reply.code(409).send({ error: 'conflict', current: existing })
      const data = pick(req.body ?? {}, spec)
      if (name === 'deals' && data.stage) {
        if (!STAGES.includes(data.stage)) return reply.code(400).send({ error: 'bad_stage' })
        data.closed_at = TERMINAL_STAGES.includes(data.stage) ? now() : null
      }
      if (PROJECT_SCOPED.has(name) && data.project_id !== undefined) {
        const pid = resolveProjectId(data.project_id)
        if (!pid) return reply.code(400).send({ error: 'bad_project' })
        data.project_id = pid
      }
      if (name === 'tasks' && data.done !== undefined) data.done_at = data.done ? now() : null
      const cols = Object.keys(data)
      if (!cols.length) return { item: existing }
      db.prepare(
        `UPDATE ${name} SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @updated_at WHERE id = @id`
      ).run({ ...data, updated_at: now(), id })
      audit(req, 'update', name, id)
      return { item: db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(id) }
    })

    app.delete(`/api/crm/${name}/:id`, async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id' })
      if (name === 'contacts') {
        const deals = db.prepare('SELECT COUNT(*) c FROM deals WHERE contact_id = ?').get(id).c
        if (deals > 0) return reply.code(409).send({ error: 'has_deals', hint: 'архивируйте контакт' })
        db.prepare('DELETE FROM tasks WHERE contact_id = ?').run(id)
        db.prepare('DELETE FROM interactions WHERE contact_id = ?').run(id)
      }
      if (name === 'deals') db.prepare('UPDATE tasks SET deal_id = NULL WHERE deal_id = ?').run(id)
      db.prepare(`DELETE FROM ${name} WHERE id = ?`).run(id)
      audit(req, 'delete', name, id)
      return { ok: true }
    })
  }

  app.get('/api/crm/contacts/:id', async (req, reply) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id' })
    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id)
    if (!contact) return reply.code(404).send({ error: 'not_found' })
    return {
      contact,
      deals: db.prepare('SELECT * FROM deals WHERE contact_id = ? ORDER BY updated_at DESC').all(id),
      tasks: db.prepare('SELECT * FROM tasks WHERE contact_id = ? ORDER BY done, due_date').all(id),
      interactions: db.prepare('SELECT * FROM interactions WHERE contact_id = ? ORDER BY happened_at DESC LIMIT 200').all(id),
    }
  })

  // ---------- проекты ----------
  // Только чтение: проекты заводятся миграцией. Удаление через API не даём —
  // осиротевшие контакты выпали бы из отфильтрованного инбокса.
  app.get('/api/crm/projects', async () => ({
    items: db.prepare('SELECT id, slug, display_name, archived FROM projects WHERE archived = 0 ORDER BY id').all(),
  }))

  // ---------- dashboard (агрегаты, время МСК) ----------
  // Фильтр по проекту прошивается во все запросы. У задач и взаимодействий своего
  // project_id нет — он берётся через контакт (ADR-005). Задачи без контакта —
  // общие: показываем их в любом проекте, потому что пропущенная задача хуже
  // лишней строки в списке.
  const STATS_DAYS = 30

  app.get('/api/crm/dashboard', async (req, reply) => {
    // _now: только для тестов границы суток МСК; в проде игнорируется
    const nowMs = Number(req.query?._now) || Date.now()
    const today = mskToday(0, nowMs)
    const pid = resolveProjectId(req.query?.project)
    if (pid === undefined) return reply.code(400).send({ error: 'unknown_project' })
    const pf = (sql) => (pid ? sql : '') // фрагмент включается только при фильтре
    const arg = pid ? [pid] : []
    const since = new Date(nowMs - STATS_DAYS * 864e5).toISOString()

    const termMarks = TERMINAL_STAGES.map(() => '?').join(',')
    const open = db
      .prepare(`SELECT stage, COUNT(*) n, SUM(COALESCE(amount,0)) sum, SUM(amount IS NULL) noAmount FROM deals WHERE stage NOT IN (${termMarks}) ${pf('AND project_id = ?')} GROUP BY stage`)
      .all(...TERMINAL_STAGES, ...arg)
    const closed = db
      .prepare(`SELECT stage, COUNT(*) n, SUM(COALESCE(amount,0)) sum FROM deals WHERE stage IN (${termMarks}) ${pf('AND project_id = ?')} GROUP BY stage`)
      .all(...TERMINAL_STAGES, ...arg)

    return {
      today,
      projectId: pid,
      inbox: db
        .prepare(`SELECT c.*, d.title deal_title, d.id deal_id FROM contacts c LEFT JOIN deals d ON d.contact_id = c.id AND d.stage = 'Новый' WHERE c.source IN ('site-form','site-chat') AND c.archived = 0 ${pf('AND c.project_id = ?')} ORDER BY c.created_at DESC LIMIT 8`)
        .all(...arg),
      tasksToday: db
        .prepare(`SELECT t.*, c.name contact_name FROM tasks t LEFT JOIN contacts c ON c.id = t.contact_id WHERE t.done = 0 AND t.due_date IS NOT NULL AND t.due_date <= ? ${pf('AND (t.contact_id IS NULL OR c.project_id = ?)')} ORDER BY t.due_date LIMIT 20`)
        .all(today, ...arg),
      funnel: STAGES.filter((s) => !TERMINAL_STAGES.includes(s)).map((s) => open.find((r) => r.stage === s) || { stage: s, n: 0, sum: 0, noAmount: 0 }),
      terminal: TERMINAL_STAGES.map((s) => closed.find((r) => r.stage === s) || { stage: s, n: 0, sum: 0 }),
      activity: db
        .prepare(`SELECT i.*, c.name contact_name, u.name user_name FROM interactions i LEFT JOIN contacts c ON c.id = i.contact_id LEFT JOIN users u ON u.id = i.created_by ${pf('WHERE c.project_id = ?')} ORDER BY i.happened_at DESC LIMIT 10`)
        .all(...arg),
      counts: {
        contacts: db.prepare(`SELECT COUNT(*) c FROM contacts WHERE archived = 0 ${pf('AND project_id = ?')}`).get(...arg).c,
        deals: db.prepare(`SELECT COUNT(*) c FROM deals ${pid ? 'WHERE project_id = ?' : ''}`).get(...arg).c,
        overdue: db
          .prepare(`SELECT COUNT(*) c FROM tasks t LEFT JOIN contacts c2 ON c2.id = t.contact_id WHERE t.done = 0 AND t.due_date < ? ${pf('AND (t.contact_id IS NULL OR c2.project_id = ?)')}`)
          .get(today, ...arg).c,
      },
      // Аналитика: сколько заявок пришло за период и откуда.
      stats: {
        days: STATS_DAYS,
        byProject: db
          .prepare(`SELECT p.id, p.display_name name, COUNT(*) n FROM contacts c JOIN projects p ON p.id = c.project_id WHERE c.created_at >= ? AND c.archived = 0 ${pf('AND c.project_id = ?')} GROUP BY p.id ORDER BY n DESC`)
          .all(since, ...arg),
        bySource: db
          .prepare(`SELECT source, COUNT(*) n FROM contacts WHERE created_at >= ? AND archived = 0 ${pf('AND project_id = ?')} GROUP BY source ORDER BY n DESC`)
          .all(since, ...arg),
      },
    }
  })

  // ---------- экспорт / импорт / CSV ----------
  const ENTITY_NAMES = Object.keys(ENTITIES)

  // экспорт всей базы и CSV — только админ (симметрично импорту): это выгрузка
  // всех клиентских данных и почт команды.
  app.get('/api/crm/export', async (req, reply) => {
    if (req.user.role !== 'admin') return reply.code(403).send({ error: 'admin_only' })
    const data = { version: 1, exportedAt: now() }
    for (const n of ENTITY_NAMES) data[n] = db.prepare(`SELECT * FROM ${n} WHERE demo = 0`).all()
    data.team = db.prepare('SELECT id, name, email, role FROM users').all()
    return data
  })

  app.post('/api/crm/import', async (req, reply) => {
    if (req.user.role !== 'admin') return reply.code(403).send({ error: 'admin_only' })
    const data = req.body
    if (!data || typeof data !== 'object' || !Array.isArray(data.contacts)) return reply.code(400).send({ error: 'bad_file' })
    if (data.version > 1) return reply.code(400).send({ error: 'newer_version' })
    // имена колонок из файла — недоверенный ввод; только известные схеме
    const EXTRA_COLS = {
      contacts: ['suspicious', 'archived'],
      deals: ['closed_at'],
      tasks: ['done', 'done_at'],
      interactions: ['happened_at'],
    }
    const allowedCols = (n) =>
      new Set([...ENTITIES[n].fields, ...(EXTRA_COLS[n] ?? []), 'demo', 'created_at', 'updated_at', 'created_by'])
    const counts = {}
    try {
      db.transaction(() => {
        // удаляем детей раньше родителей (FK), вставляем в прямом порядке
        for (const n of [...ENTITY_NAMES].reverse()) db.prepare(`DELETE FROM ${n}`).run()
        for (const n of ENTITY_NAMES) {
          const rows = data[n] || []
          const allowed = allowedCols(n)
          const stmtCache = new Map()
          for (const row of rows) {
            const cols = Object.keys(row).filter((c) => c !== 'id')
            const unknown = cols.find((c) => !allowed.has(c))
            if (unknown) throw new Error(`неизвестное поле «${unknown}» в ${n}`)
            const sig = cols.join(',')
            let stmt = stmtCache.get(sig)
            if (!stmt) {
              stmt = db.prepare(`INSERT INTO ${n} (id, ${sig}) VALUES (@id, ${cols.map((c) => '@' + c).join(',')})`)
              stmtCache.set(sig, stmt)
            }
            stmt.run(row)
          }
          counts[n] = rows.length
        }
      })()
    } catch (err) {
      return reply.code(400).send({ error: 'bad_file', detail: String(err) })
    }
    audit(req, 'import', 'all', 0)
    return { ok: true, counts }
  })

  app.get('/api/crm/contacts.csv', async (req, reply) => {
    if (req.user.role !== 'admin') return reply.code(403).send({ error: 'admin_only' })
    const rows = db.prepare('SELECT name, company, phone, email, messenger, source FROM contacts WHERE archived = 0 AND demo = 0 ORDER BY name').all()
    const esc = (v) => {
      let s = String(v ?? '')
      // защита от формул: имена приходят с публичной формы, Excel исполняет =/+/-/@
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const csv = ['Имя;Компания;Телефон;Email;Мессенджер;Источник', ...rows.map((r) => [r.name, r.company, r.phone, r.email, r.messenger, r.source].map(esc).join(';'))].join('\r\n')
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="contacts.csv"')
    return '﻿' + csv
  })

  // ---------- пользователи (admin) ----------
  app.get('/api/crm/users', async (req) =>
    ({ items: db.prepare('SELECT id, name, email, role, created_at FROM users').all() }))

  app.post('/api/crm/users', async (req, reply) => {
    if (req.user.role !== 'admin') return reply.code(403).send({ error: 'admin_only' })
    const { name, email, password, role } = req.body ?? {}
    if (!name || !email || !password || password.length < 8) return reply.code(400).send({ error: 'bad_input' })
    try {
      const info = db.prepare('INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)').run(trim(name, 100), trim(email, 200).toLowerCase(), await hashPassword(password), role === 'admin' ? 'admin' : 'member', now())
      audit(req, 'create', 'users', info.lastInsertRowid)
      return { ok: true, id: info.lastInsertRowid }
    } catch {
      return reply.code(400).send({ error: 'email_taken' })
    }
  })

  app.patch('/api/crm/users/:id', async (req, reply) => {
    if (req.user.role !== 'admin') return reply.code(403).send({ error: 'admin_only' })
    const id = Number(req.params.id)
    const { password, name } = req.body ?? {}
    if (name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(trim(name, 100), id)
    if (password) {
      if (password.length < 8) return reply.code(400).send({ error: 'bad_input' })
      // смена пароля инвалидирует все сессии пользователя
      db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(await hashPassword(password), id)
    }
    audit(req, 'update', 'users', id)
    return { ok: true }
  })

  app.delete('/api/crm/users/:id', async (req, reply) => {
    if (req.user.role !== 'admin') return reply.code(403).send({ error: 'admin_only' })
    const id = Number(req.params.id)
    if (id === req.user.id) return reply.code(400).send({ error: 'cannot_delete_self' })
    db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(id)
    db.prepare('DELETE FROM users WHERE id = ?').run(id)
    audit(req, 'delete', 'users', id)
    return { ok: true }
  })

  // ---------- демо-данные ----------
  app.post('/api/crm/demo-seed', async (req) => {
    const ts = now()
    const LAB = 1
    const VIZOR = 2
    const seed = db.transaction(() => {
      const c = (name, company, extra = {}) =>
        db.prepare("INSERT INTO contacts (name, company, phone, email, source, project_id, demo, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)")
          .run(name, company, extra.phone ?? '', extra.email ?? '', extra.source ?? 'manual', extra.project ?? LAB, ts, ts, req.user.id).lastInsertRowid
      const id1 = c('Марина Соколова', 'ООО «Северный свет»', { phone: '+7 921 555-14-88', source: 'site-form' })
      const id2 = c('Дмитрий Иванов', '«Балтика-Транс»', { email: 'd.ivanov@baltika.ru' })
      const id3 = c('Арсений', '', { source: 'site-chat' })
      const id4 = c('Ольга Р.', 'ЖК «Приморский»', { phone: '+7 911 204-77-31', source: 'site-form', project: VIZOR })
      const d = (cid, title, stage, amount, project = LAB) =>
        db.prepare('INSERT INTO deals (contact_id, title, stage, amount, project_id, demo, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)').run(cid, title, stage, amount, project, ts, ts, req.user.id).lastInsertRowid
      d(id1, 'Внедрение ИИ в документооборот', 'Новый', 340000)
      const deal2 = d(id2, 'Пилот: ассистент для логистики', 'Переговоры', 780000)
      d(id3, 'Чат-бот для клиники', 'Контакт', 210000)
      d(id4, 'Контроль отделки квартиры по фото', 'Новый', 45000, VIZOR)
      db.prepare('INSERT INTO tasks (title, contact_id, deal_id, due_date, demo, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, 1, ?, ?, ?)').run('Позвонить Иванову по пилоту', id2, deal2, mskToday(-1), ts, ts, req.user.id)
      db.prepare('INSERT INTO tasks (title, contact_id, due_date, demo, created_at, updated_at, created_by) VALUES (?, ?, ?, 1, ?, ?, ?)').run('Отправить КП «Северный свет»', id1, mskToday(), ts, ts, req.user.id)
      db.prepare('INSERT INTO interactions (contact_id, deal_id, type, note, happened_at, demo, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)').run(id2, deal2, 'звонок', 'Обсудили пилот, ждёт КП до пятницы', ts, ts, ts, req.user.id)
    })
    seed()
    audit(req, 'demo-seed', 'all', 0)
    return { ok: true }
  })

  app.delete('/api/crm/demo', async (req) => {
    db.transaction(() => {
      for (const n of ['interactions', 'tasks', 'deals', 'contacts']) db.prepare(`DELETE FROM ${n} WHERE demo = 1`).run()
    })()
    audit(req, 'demo-clear', 'all', 0)
    return { ok: true }
  })

  // ---------- диагностика ----------
  app.get('/api/crm/diagnostics', async () => ({
    schemaVersion: db.pragma('user_version', { simple: true }),
    counts: Object.fromEntries(ENTITY_NAMES.map((n) => [n, db.prepare(`SELECT COUNT(*) c FROM ${n}`).get().c])),
    outboxPending: db.prepare('SELECT COUNT(*) c FROM outbox WHERE sent_at IS NULL').get().c,
    serverTimeMsk: mskToday(),
  }))

  // ---------- публичный приём лидов ----------
  // Единственная точка без авторизации, поэтому CORS ровно для неё и строго по
  // списку origins проектов (+ localhost в dev). Без этого браузер не даст сайтам
  // отправить форму на другой домен.
  function leadOriginAllowed(origin) {
    const o = trim(origin, 200)
    if (!o) return false
    if (!secure && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(o)) return true
    return Boolean(projectByOrigin(o))
  }

  function applyLeadCors(req, reply) {
    reply.header('vary', 'Origin')
    if (leadOriginAllowed(req.headers.origin)) reply.header('access-control-allow-origin', req.headers.origin)
  }

  app.options('/api/leads', async (req, reply) => {
    if (!leadOriginAllowed(req.headers.origin)) return reply.header('vary', 'Origin').code(403).send()
    return reply
      .header('vary', 'Origin')
      .header('access-control-allow-origin', req.headers.origin)
      .header('access-control-allow-methods', 'POST, OPTIONS')
      .header('access-control-allow-headers', 'content-type')
      .header('access-control-max-age', '86400')
      .code(204)
      .send()
  })

  app.post('/api/leads', async (req, reply) => {
    applyLeadCors(req, reply)
    const b = req.body ?? {}
    // honeypot: боты заполняют поле website — принимаем, но помечаем
    const suspicious = Boolean(b.website) || leadSuspicious(req.ip)
    const contactInfo = trim(b.contact, 300)
    const isChat = b.source === 'chat' || (!b.name && b.detail !== undefined)
    const name = trim(b.name, 200) || (contactInfo ? contactInfo.split(/[,;]/)[0].trim() : '') || 'Без имени'
    const title = isChat ? trim(b.task, 300) || 'Заявка из чата' : [trim(b.task, 200), b.scale ? `масштаб: ${trim(b.scale, 100)}` : ''].filter(Boolean).join(', ') || 'Заявка с сайта'
    const note = isChat ? trim(b.detail, 1000) : trim(b.note, 1000)
    if (!contactInfo && name === 'Без имени') return reply.code(204).send()

    // Проект: явное поле формы → домен сайта → проект по умолчанию.
    // Заявку не отвергаем никогда: потерянный лид хуже, чем лид не в том проекте —
    // второе видно в CRM и правится одним кликом, первое не восстановить.
    const byOrigin = projectByOrigin(req.headers.origin)
    let projectId = byOrigin ? byOrigin.id : DEFAULT_PROJECT_ID
    const asked = trim(b.project, 100)
    if (asked) {
      const pid = resolveProjectId(asked)
      if (pid) projectId = pid
      else app.log?.warn?.({ asked, origin: req.headers.origin }, 'lead: неизвестный проект, беру запасной')
    }

    const ts = now()
    const contactId = db.transaction(() => {
      const isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactInfo)
      const email = isEmail ? contactInfo : ''
      const messenger = isEmail ? '' : contactInfo
      const cid = db.prepare('INSERT INTO contacts (name, email, messenger, note, source, suspicious, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(name, email, messenger, '', isChat ? 'site-chat' : 'site-form', suspicious ? 1 : 0, projectId, ts, ts).lastInsertRowid
      db.prepare('INSERT INTO deals (contact_id, title, stage, note, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(cid, title, 'Новый', note, projectId, ts, ts)
      return cid
    })()

    // В уведомление кладём только обезличенное: проект, источник, ссылку на карточку.
    // Имя, контакт и текст заявки остаются в CRM на российском сервере — Telegram
    // зарубежный, и отправка туда ПДн была бы трансграничной передачей (152-ФЗ).
    const project = db.prepare('SELECT display_name FROM projects WHERE id = ?').get(projectId)
    enqueue(db, 'lead', {
      projectName: project?.display_name || '',
      source: isChat ? 'чат' : 'форма',
      contactId,
      suspicious,
    })
    app.log?.info?.({ contactId, projectId, suspicious }, 'lead accepted')
    return reply.code(204).send()
  })

  app.get('/api/health', async () => ({ ok: true }))

  return app
}
