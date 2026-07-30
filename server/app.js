import fs from 'node:fs'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import staticPlugin from '@fastify/static'
import { DEFAULT_PROJECT_ID, PD_REQUEST_KINDS, WINBACK_STEPS, addWorkdays, openDb, now, STAGES, TERMINAL_STAGES } from './db.js'
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

export function buildApp({ dbFile = ':memory:', secret = 'dev-secret', secure = true, logger = false, staticDir = null } = {}) {
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

  // Пишем и в лог процесса (удобно смотреть вживую), и в таблицу — логи контейнера
  // на App Platform теряются при передеплое, а след нужен для проверки РКН (ADR-011).
  const audit = (req, action, entity, id, detail = '') => {
    app.log?.info?.({ user: req.user?.email, action, entity, id, detail }, 'mutation')
    try {
      db.prepare('INSERT INTO audit_log (user_id, user_email, action, entity, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(req.user?.id ?? null, req.user?.email ?? '', action, entity, id ?? null, trim(detail, 500), now())
    } catch (err) {
      // Журнал не должен ломать сам запрос: потерянная строка аудита хуже, чем
      // упавшее сохранение контакта, но не настолько, чтобы отменять операцию.
      app.log?.warn?.(`audit: не удалось записать: ${err}`)
    }
  }

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

  const LOST_STAGE = 'Проиграно'

  /**
   * Воронка возврата: сделка ушла в «Проиграно» — заводим серию задач-напоминаний
   * на 2 месяца. Отказ сегодня не значит отказ навсегда, но без напоминаний о таких
   * клиентах просто забывают.
   * Повторно серию не создаём: если активная уже есть, значит сделку уже отказывали.
   */
  function startWinback(dealId, userId, reason = '') {
    const deal = db.prepare('SELECT contact_id FROM deals WHERE id = ?').get(dealId)
    if (!deal) return null
    const active = db.prepare("SELECT id FROM winback_sequences WHERE deal_id = ? AND status = 'active'").get(dealId)
    if (active) return active.id

    const ts = now()
    return db.transaction(() => {
      const seqId = db
        .prepare('INSERT INTO winback_sequences (deal_id, contact_id, reason, started_at, created_by) VALUES (?, ?, ?, ?, ?)')
        .run(dealId, deal.contact_id, trim(reason, 500), ts, userId ?? null).lastInsertRowid
      const insert = db.prepare(
        'INSERT INTO tasks (title, contact_id, deal_id, due_date, winback_sequence_id, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      for (const step of WINBACK_STEPS) {
        insert.run(step.title, deal.contact_id, dealId, mskToday(step.days), seqId, ts, ts, userId ?? null)
      }
      return seqId
    })()
  }

  /**
   * Сделку вернули из «Проиграно» в работу — незакрытые напоминания больше не нужны.
   * Выполненные задачи не трогаем: это уже история работы с клиентом.
   */
  function cancelWinback(dealId) {
    const active = db.prepare("SELECT id FROM winback_sequences WHERE deal_id = ? AND status = 'active'").all(dealId)
    if (!active.length) return 0
    return db.transaction(() => {
      let removed = 0
      for (const seq of active) {
        removed += db.prepare('DELETE FROM tasks WHERE winback_sequence_id = ? AND done = 0').run(seq.id).changes
        db.prepare("UPDATE winback_sequences SET status = 'cancelled', finished_at = ? WHERE id = ?").run(now(), seq.id)
      }
      return removed
    })()
  }

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

      // Воронка возврата — только на смене стадии сделки, и только когда стадия
      // действительно поменялась (повторный PATCH тем же значением ничего не заводит).
      let winback = null
      if (name === 'deals' && data.stage && data.stage !== existing.stage) {
        if (data.stage === LOST_STAGE) {
          const seqId = startWinback(id, req.user.id, req.body?.lostReason)
          if (seqId) winback = { started: true, tasks: WINBACK_STEPS.length }
        } else if (existing.stage === LOST_STAGE) {
          const removed = cancelWinback(id)
          if (removed) winback = { cancelled: true, tasks: removed }
        }
      }
      return { item: db.prepare(`SELECT * FROM ${name} WHERE id = ?`).get(id), winback }
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
      if (name === 'deals') {
        // Серии возврата ссылаются на сделку внешним ключом — без этой уборки
        // удаление сделки упало бы на FOREIGN KEY.
        db.prepare('DELETE FROM tasks WHERE winback_sequence_id IN (SELECT id FROM winback_sequences WHERE deal_id = ?)').run(id)
        db.prepare('DELETE FROM winback_sequences WHERE deal_id = ?').run(id)
        db.prepare('UPDATE tasks SET deal_id = NULL WHERE deal_id = ?').run(id)
      }
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
  // Сколько дней тишины по сделке считаем «остыванием». Дни календарные, не рабочие:
  // клиенту, написавшему в пятницу, наши выходные безразличны — к утру понедельника
  // он уже три дня без ответа.
  const COOLING_DAYS = 3

  app.get('/api/crm/dashboard', async (req, reply) => {
    // _now: только для тестов границы суток МСК; в проде игнорируется
    const nowMs = Number(req.query?._now) || Date.now()
    const today = mskToday(0, nowMs)
    const pid = resolveProjectId(req.query?.project)
    if (pid === undefined) return reply.code(400).send({ error: 'unknown_project' })
    const pf = (sql) => (pid ? sql : '') // фрагмент включается только при фильтре
    const arg = pid ? [pid] : []
    const since = new Date(nowMs - STATS_DAYS * 864e5).toISOString()
    const coolingBefore = new Date(nowMs - COOLING_DAYS * 864e5).toISOString()

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
      // «Остывают»: живые сделки, по которым давно ничего не происходило. Точка отсчёта —
      // последнее взаимодействие, а если их не было ни одного, то создание сделки.
      // Сделки с открытой задачей сюда НЕ попадают: про них не забыли, о них
      // договорились — иначе блок быстро превратился бы в шум, который перестают читать.
      // Обезличенные контакты исключены: человек потребовал прекратить обработку,
      // напоминать о нём нельзя (ADR-011).
      cooling: db
        .prepare(`SELECT d.id, d.title, d.stage, d.amount, d.created_at, d.project_id, c.id contact_id, c.name contact_name, c.source,
            COALESCE(MAX(i.happened_at), d.created_at) last_touch,
            MAX(i.happened_at) IS NULL no_touch
          FROM deals d
          JOIN contacts c ON c.id = d.contact_id
          LEFT JOIN interactions i ON i.contact_id = c.id
          WHERE d.stage NOT IN (${termMarks})
            AND c.archived = 0
            AND c.anonymized_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.contact_id = c.id AND t.done = 0)
            ${pf('AND d.project_id = ?')}
          GROUP BY d.id
          HAVING last_touch < ?
          ORDER BY last_touch
          LIMIT 8`)
        .all(...TERMINAL_STAGES, ...arg, coolingBefore),
      coolingDays: COOLING_DAYS,
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
    // имена колонок из файла — недоверенный ввод; только известные схеме.
    // ВАЖНО: экспорт отдаёт `SELECT *`, поэтому любая новая колонка обязана попасть
    // сюда, иначе импорт своего же экспорта падает с «bad_file». Добавляя колонку
    // в миграции — дописывай её и здесь (и в тест раунд-трипа).
    const EXTRA_COLS = {
      contacts: ['suspicious', 'archived', 'anonymized_at'],
      deals: ['closed_at'],
      tasks: ['done', 'done_at', 'winback_sequence_id'],
      interactions: ['happened_at'],
    }
    const allowedCols = (n) =>
      new Set([...ENTITIES[n].fields, ...(EXTRA_COLS[n] ?? []), 'demo', 'created_at', 'updated_at', 'created_by'])
    const counts = {}
    try {
      db.transaction(() => {
        // winback_sequences ссылается на deals и contacts НАСТОЯЩИМ внешним ключом и в
        // дамп не входит — без этой очистки его строки блокируют `DELETE FROM deals`
        // и импорт падает с «FOREIGN KEY constraint failed» на любой базе, где хоть
        // одна сделка проигрывалась. Серии восстановлению не подлежат: они выводятся
        // из стадии сделки, а стадия в дампе есть.
        db.prepare('DELETE FROM winback_sequences').run()
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
            // Сами серии возврата в дамп не входят (это не сущность CRUD), поэтому
            // ссылка на них после импорта указывала бы в пустоту. Обнуляем: задача
            // остаётся обычной, с прежним заголовком и датой. Стадия «Проиграно»
            // у сделки сохраняется, так что смысл не теряется — теряется только
            // авто-снятие напоминаний при возврате сделки в работу.
            if (n === 'tasks' && row.winback_sequence_id != null) row.winback_sequence_id = null
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
        // Запросы по ПДн — юридический след, их не удаляем. Но привязку к контакту
        // рвём: контакты только что заменены целиком, и ссылка могла бы указать на
        // ДРУГОГО человека с тем же id. Сам запрос остаётся читаемым — в нём есть
        // адрес заявителя, вид запроса, срок и статус.
        db.prepare('UPDATE pd_requests SET contact_id = NULL, updated_at = ? WHERE contact_id IS NOT NULL').run(now())
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

  // ---------- права субъекта ПДн (152-ФЗ) ----------
  // Политика на сайтах обещает исполнить запрос за 10 рабочих дней. Здесь механизм,
  // который это обещание выполняет: регистрация запроса → дедлайн → обезличивание.
  //
  // Обезличиваем, а не удаляем: сделка со стадией остаётся, чтобы воронка и выручка
  // за прошлые периоды не поехали задним числом, но опознать человека по базе больше
  // нельзя. Что именно затирается — в anonymizeContact ниже (ADR-011).
  const PD_STATUSES = ['new', 'done', 'rejected']

  function anonymizeContact(contactId, req) {
    const contact = db.prepare('SELECT id, anonymized_at FROM contacts WHERE id = ?').get(contactId)
    if (!contact) return null
    if (contact.anonymized_at) return contact // повторный вызов безвреден

    const ts = now()
    db.transaction(() => {
      // 1. Сам контакт: имя-заглушка, все опознающие поля пусты
      db.prepare(`UPDATE contacts SET name = ?, company = '', phone = '', email = '', messenger = '',
        note = '', anonymized_at = ?, updated_at = ? WHERE id = ?`)
        .run(`Удалённый контакт #${contactId}`, ts, ts, contactId)
      // 2. Взаимодействия: текст затираем (там транскрипты переписок), но строки
      //    оставляем — по ним считается активность на дашборде
      db.prepare("UPDATE interactions SET note = '', updated_at = ? WHERE contact_id = ?").run(ts, contactId)
      // 3. Сделки: заметки могут содержать ПДн, затираем; стадия и сумма остаются
      db.prepare("UPDATE deals SET note = '', updated_at = ? WHERE contact_id = ?").run(ts, contactId)
      // 4. Задачи удаляем целиком: во-первых, в заголовке может стоять имя, во-вторых,
      //    человек потребовал прекратить обработку — напоминание «позвонить ему» этому
      //    прямо противоречит. Вместе с ними закрываем воронку возврата.
      db.prepare('DELETE FROM tasks WHERE contact_id = ?').run(contactId)
      db.prepare("UPDATE winback_sequences SET status = 'cancelled', finished_at = ? WHERE contact_id = ? AND status = 'active'")
        .run(ts, contactId)
    })()
    audit(req, 'anonymize', 'contacts', contactId, 'исполнение запроса субъекта ПДн')
    return db.prepare('SELECT id, name, anonymized_at FROM contacts WHERE id = ?').get(contactId)
  }

  app.get('/api/crm/pd-requests', async (req) => {
    const status = trim(req.query?.status, 20)
    const where = PD_STATUSES.includes(status) ? 'WHERE r.status = ?' : ''
    const args = where ? [status] : []
    const items = db
      .prepare(`SELECT r.*, c.name contact_name, c.anonymized_at, p.display_name project_name
        FROM pd_requests r
        LEFT JOIN contacts c ON c.id = r.contact_id
        LEFT JOIN projects p ON p.id = r.project_id
        ${where} ORDER BY r.status = 'new' DESC, r.due_date, r.id DESC LIMIT 500`)
      .all(...args)
    return { items, kinds: PD_REQUEST_KINDS, today: mskToday() }
  })

  app.post('/api/crm/pd-requests', async (req, reply) => {
    const b = req.body ?? {}
    const kind = PD_REQUEST_KINDS[b.kind] ? b.kind : 'delete'
    const requester = trim(b.requester, 300)
    const contactId = b.contact_id === undefined || b.contact_id === null || b.contact_id === '' ? null : Number(b.contact_id)
    if (contactId !== null && !Number.isInteger(contactId)) return reply.code(400).send({ error: 'bad_input' })
    if (!requester && contactId === null) return reply.code(400).send({ error: 'bad_input' })
    if (contactId !== null && !db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(contactId)) {
      return reply.code(400).send({ error: 'bad_reference' })
    }
    const projectId = contactId !== null
      ? db.prepare('SELECT project_id FROM contacts WHERE id = ?').get(contactId).project_id
      : resolveProjectId(b.project) || DEFAULT_PROJECT_ID
    const ts = now()
    const info = db.prepare(`INSERT INTO pd_requests (contact_id, kind, requester, note, source, project_id, due_date, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(contactId, kind, requester, trim(b.note, 1000), 'manual', projectId, addWorkdays(mskToday()), ts, ts)
    audit(req, 'create', 'pd_requests', info.lastInsertRowid, kind)
    return { ok: true, id: info.lastInsertRowid, due_date: addWorkdays(mskToday()) }
  })

  app.patch('/api/crm/pd-requests/:id', async (req, reply) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_input' })
    const row = db.prepare('SELECT * FROM pd_requests WHERE id = ?').get(id)
    if (!row) return reply.code(404).send({ error: 'not_found' })
    const b = req.body ?? {}
    const ts = now()

    // Привязка к контакту: запрос с сайта приходит без неё, сотрудник находит человека
    if (b.contact_id !== undefined) {
      const cid = b.contact_id === null || b.contact_id === '' ? null : Number(b.contact_id)
      if (cid !== null && !db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(cid)) {
        return reply.code(400).send({ error: 'bad_reference' })
      }
      db.prepare('UPDATE pd_requests SET contact_id = ?, updated_at = ? WHERE id = ?').run(cid, ts, id)
    }
    if (b.note !== undefined) db.prepare('UPDATE pd_requests SET note = ?, updated_at = ? WHERE id = ?').run(trim(b.note, 1000), ts, id)

    if (b.status !== undefined) {
      if (!PD_STATUSES.includes(b.status)) return reply.code(400).send({ error: 'bad_input' })
      db.prepare('UPDATE pd_requests SET status = ?, resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ?')
        .run(b.status, b.status === 'new' ? null : ts, b.status === 'new' ? null : req.user.id, ts, id)
      audit(req, 'update', 'pd_requests', id, `статус: ${b.status}`)
    }

    // Обезличивание — только по явному запросу и только для «удалить»/«прекратить»:
    // на «узнать, какие данные есть» стирать ничего не надо.
    let anonymized = null
    if (b.anonymize === true) {
      const target = db.prepare('SELECT contact_id, kind FROM pd_requests WHERE id = ?').get(id)
      if (!target.contact_id) return reply.code(400).send({ error: 'no_contact' })
      if (!['delete', 'stop'].includes(target.kind)) return reply.code(400).send({ error: 'kind_not_erasable' })
      anonymized = anonymizeContact(target.contact_id, req)
    }
    return { ok: true, anonymized }
  })

  // Обезличивание прямо из карточки контакта — без регистрации запроса это делать
  // нельзя: нужен след, по которому видно основание. Поэтому только admin.
  app.post('/api/crm/contacts/:id/anonymize', async (req, reply) => {
    if (req.user.role !== 'admin') return reply.code(403).send({ error: 'admin_only' })
    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_input' })
    const result = anonymizeContact(id, req)
    if (!result) return reply.code(404).send({ error: 'not_found' })
    return { ok: true, contact: result }
  })

  app.get('/api/crm/audit', async (req, reply) => {
    if (req.user.role !== 'admin') return reply.code(403).send({ error: 'admin_only' })
    const items = db
      .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 300')
      .all()
    return { items }
  })

  // ---------- диагностика ----------
  app.get('/api/crm/diagnostics', async () => ({
    schemaVersion: db.pragma('user_version', { simple: true }),
    counts: Object.fromEntries(ENTITY_NAMES.map((n) => [n, db.prepare(`SELECT COUNT(*) c FROM ${n}`).get().c])),
    outboxPending: {
      tg: db.prepare('SELECT COUNT(*) c FROM outbox WHERE tg_sent_at IS NULL').get().c,
      max: db.prepare('SELECT COUNT(*) c FROM outbox WHERE max_sent_at IS NULL').get().c,
    },
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
    // Полная переписка с «Невой» — отдельной записью во взаимодействия, а не в note
    // сделки: так карточка сделки остаётся короткой сутью, а весь диалог всё равно
    // виден на карточке контакта. ПДн тут можно — CRM на РФ-сервере, доступ только у сотрудников.
    const transcript = isChat ? trim(b.transcript, 4000) : ''
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
      if (transcript) {
        db.prepare('INSERT INTO interactions (contact_id, type, note, happened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(cid, 'сообщение', transcript, ts, ts, ts)
      }
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

  // ---------- публичный приём запросов по персональным данным ----------
  // Форма на сайтах: человек может сам потребовать удалить данные, не дожидаясь письма.
  // Тот же CORS и та же философия, что у лидов: запрос не отвергаем никогда — потерянный
  // запрос это просроченное обязательство и повод для жалобы в РКН (ADR-011).
  app.options('/api/pd-requests', async (req, reply) => {
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

  app.post('/api/pd-requests', async (req, reply) => {
    applyLeadCors(req, reply)
    const b = req.body ?? {}
    const requester = trim(b.contact, 300)
    if (!requester) return reply.code(400).send({ error: 'contact_required' })
    const kind = PD_REQUEST_KINDS[b.kind] ? b.kind : 'delete'
    const suspicious = Boolean(b.website) || leadSuspicious(req.ip)

    const byOrigin = projectByOrigin(req.headers.origin)
    let projectId = byOrigin ? byOrigin.id : DEFAULT_PROJECT_ID
    const asked = trim(b.project, 100)
    if (asked) projectId = resolveProjectId(asked) || projectId

    // Ищем человека в базе сами — по точному совпадению почты или мессенджера.
    // Не нашли — оставляем contact_id пустым: сотрудник сопоставит вручную, а срок
    // уже идёт, поэтому запрос всё равно должен быть зарегистрирован.
    const found = db
      .prepare('SELECT id FROM contacts WHERE anonymized_at IS NULL AND (lower(email) = lower(?) OR lower(messenger) = lower(?) OR phone = ?) ORDER BY id DESC LIMIT 1')
      .get(requester, requester, requester)

    const dueDate = addWorkdays(mskToday())
    const ts = now()
    const note = [trim(b.note, 800), suspicious ? '⚠️ подозрительная отправка (ловушка или частые обращения с одного адреса)' : '']
      .filter(Boolean).join('\n')
    const info = db.prepare(`INSERT INTO pd_requests (contact_id, kind, requester, note, source, project_id, due_date, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(found?.id ?? null, kind, requester, note, 'site-form', projectId, dueDate, ts, ts)

    // Уведомление обезличено для ОБОИХ каналов, в отличие от заявок: здесь ПДн не нужны
    // по существу — важны вид запроса и срок, а кто именно, видно в CRM по ссылке.
    const base = String(process.env.CRM_BASE_URL || '').trim().replace(/\/+$/, '')
    enqueue(db, 'text', {
      text: [
        '⚠️ <b>Запрос по персональным данным</b>',
        `Вид: ${PD_REQUEST_KINDS[kind]}`,
        `Исполнить до: <b>${dueDate}</b>`,
        found ? 'Клиент найден в базе автоматически.' : 'Клиента в базе не нашли — сопоставить вручную.',
        base ? `Открыть: ${base}/crm/privacy` : 'Открыть раздел «Права ПДн» в CRM',
      ].join('\n'),
    })
    app.log?.info?.({ id: info.lastInsertRowid, kind, projectId, matched: Boolean(found), suspicious }, 'pd request accepted')
    return reply.code(204).send()
  })

  app.get('/api/health', async () => ({ ok: true }))

  // ---------- статика фронта (для App Platform: один контейнер вместо app+Caddy) ----------
  // staticDir передаётся только в проде (server/index.js), когда dist/ реально собран —
  // на тестах и в dev-режиме (Vite proxy) эта ветка не активируется вообще.
  if (staticDir && fs.existsSync(staticDir)) {
    app.register(staticPlugin, { root: staticDir })
    app.setNotFoundHandler((req, reply) => {
      // /api/* без совпавшего роута — настоящий 404, не отдаём под него HTML
      if (req.raw.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' })
      // SPA-роутинг (react-router): любой другой путь — index.html, дальше решает браузер
      reply.sendFile('index.html')
    })
  }

  return app
}
