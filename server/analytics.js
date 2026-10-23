// Свой счётчик посещений сайтов и отчёт «канал → посещения → заявки → оплаты» (ADR-027) — вместо Яндекс Метрики.
// Без cookie и без IP: скрипт /nv.js помнит источник захода в sessionStorage вкладки и шлёт только страницу и источник;
// сервер хранит СУММЫ за день (site_visits), а не отдельные заходы. Ничего из этого не относится к конкретному человеку,
// поэтому /api/collect не входит в INTAKE_ROUTES (ADR-026): режим «приём закрыт» его не трогает.
import { cleanPath, cleanTag, normalizeAttribution } from '../src/shared/attribution.js'

// Потолок строк на проект за день: случайные адреса и метки от бота не должны растить таблицу без предела.
// Сверх него новые сочетания складываются в одну строку «(прочее)».
export const MAX_ROWS_PER_DAY = 2000
export const OTHER_PATH = '(прочее)'
// Маршрут захода: не больше 10 шагов, шаги через « → ». Отметка сайта (window.nvMark('заявка')) — шаг «★ заявка».
export const ROUTE_MAX_STEPS = 10
export const ROUTE_SEP = ' → '
const BOT_UA = /bot|crawl|spider|slurp|headless|preview|lighthouse|monitor|curl|wget|python|java\/|go-http/i
const PERIODS = [7, 30, 90, 365]

/**
 * Скрипт для сайтов: `<script src="https://crm-nevarium.ru/nv.js" defer></script>`. window.nvAttribution() — источник для заявки,
 * window.nvMark('заявка') — отметить в маршруте захода успешную отправку формы. Маршрут вкладки — в её sessionStorage.
 */
export const COUNTER_JS = `/* Счётчик посещений Невариум CRM (ADR-027): без cookie и без IP-адресов. */
(function () {
  if (window.__nvCounter) return
  window.__nvCounter = true
  var me = document.currentScript
  var endpoint = (me && me.src ? new URL(me.src).origin : '') + '/api/collect'
  var KEY = 'nv_attr'
  function read() { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null') } catch (e) { return null } }
  function page() {
    var h = (location.hash || '').split('?')[0]
    if (/^#\\/c(\\/|$)/.test(h)) h = '#/c'
    return location.pathname + h
  }
  function params() {
    var q = location.search || ''
    var i = (location.hash || '').indexOf('?')
    if (i >= 0) q += '&' + location.hash.slice(i + 1)
    return new URLSearchParams(q)
  }
  var attr = read()
  var first = false
  if (!attr) {
    var p = params()
    var ref = ''
    try { if (document.referrer) { var r = new URL(document.referrer); if (r.hostname !== location.hostname) ref = r.hostname } } catch (e) {}
    attr = { utm_source: p.get('utm_source') || '', utm_medium: p.get('utm_medium') || '', utm_campaign: p.get('utm_campaign') || '', ref_host: ref, landing: page() }
    try { sessionStorage.setItem(KEY, JSON.stringify(attr)) } catch (e) {}
    first = true
  }
  window.nvAttribution = function () { return read() || attr }
  var RKEY = 'nv_route'
  var route = []
  try { route = JSON.parse(sessionStorage.getItem(RKEY) || '[]'); if (!Array.isArray(route)) route = [] } catch (e) { route = [] }
  // Новый шаг маршрута; null — маршрут не удлинился (та же страница или уже ${ROUTE_MAX_STEPS} шагов).
  function step(s) {
    if (route[route.length - 1] === s || route.length >= ${ROUTE_MAX_STEPS}) return null
    route.push(s)
    try { sessionStorage.setItem(RKEY, JSON.stringify(route)) } catch (e) {}
    return route.slice()
  }
  function send(o) {
    try { fetch(endpoint, { method: 'POST', body: JSON.stringify(o), mode: 'no-cors', keepalive: true, credentials: 'omit', headers: { 'content-type': 'text/plain' } }) } catch (e) {}
  }
  var last = ''
  function hit() {
    if (navigator.webdriver) return
    var path = page()
    if (path === last) return
    last = path
    send({ path: path, attribution: attr, first: first, route: step(path) })
    first = false
  }
  window.nvMark = function (name) {
    if (navigator.webdriver) return
    var r = step('★ ' + String(name || 'цель').slice(0, 40))
    if (r) send({ route: r, attribution: attr })
  }
  hit()
  window.addEventListener('hashchange', hit)
  window.addEventListener('popstate', hit)
  var push = history.pushState
  history.pushState = function () { var res = push.apply(this, arguments); setTimeout(hit, 0); return res }
})()
`

const KEY_COLS = 'project_id, day, path, channel, ref_host, utm_source, utm_campaign'
const KEY_WHERE = 'project_id = ? AND day = ? AND path = ? AND channel = ? AND ref_host = ? AND utm_source = ? AND utm_campaign = ?'

/** Плюс один просмотр (и заход, если это первая страница вкладки) в суммы дня. */
export async function recordVisit(db, { projectId, day, path, attribution, first }) {
  const a = attribution
  let key = [projectId, day, path, a.channel || 'direct', a.ref_host, a.utm_source, a.utm_campaign]
  if (!(await db.prepare(`SELECT 1 FROM site_visits WHERE ${KEY_WHERE}`).get(...key))) {
    const n = Number((await db.prepare('SELECT COUNT(*) c FROM site_visits WHERE project_id = ? AND day = ?').get(projectId, day)).c)
    if (n >= MAX_ROWS_PER_DAY) key = [projectId, day, OTHER_PATH, a.channel || 'direct', '', '', '']
  }
  await db.prepare(`INSERT INTO site_visits (${KEY_COLS}, views, visits) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT (${KEY_COLS}) DO UPDATE SET views = site_visits.views + 1, visits = site_visits.visits + EXCLUDED.visits`)
    .run(...key, first ? 1 : 0)
}

/** Маршрут из скрипта → строка «/ → /tariffs → ★ заявка» или '' (мусор не считаем вовсе). */
export function cleanRoute(v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > ROUTE_MAX_STEPS) return ''
  const steps = []
  for (const raw of v) {
    if (typeof raw !== 'string') return ''
    const step = raw.startsWith('★') ? (cleanTag(raw.slice(1)) ? `★ ${cleanTag(raw.slice(1))}` : '') : cleanPath(raw)
    if (!step) return ''
    steps.push(step)
  }
  return steps.join(ROUTE_SEP)
}

/** Плюс один заход, прошедший этот маршрут (как минимум до этого шага). */
export async function recordRoute(db, { projectId, day, route }) {
  let r = route
  if (!(await db.prepare('SELECT 1 FROM site_routes WHERE project_id = ? AND day = ? AND route = ?').get(projectId, day, r))) {
    const n = Number((await db.prepare('SELECT COUNT(*) c FROM site_routes WHERE project_id = ? AND day = ?').get(projectId, day)).c)
    if (n >= MAX_ROWS_PER_DAY) r = OTHER_PATH
  }
  await db.prepare('INSERT INTO site_routes (project_id, day, route, hits) VALUES (?, ?, ?, 1) ON CONFLICT (project_id, day, route) DO UPDATE SET hits = site_routes.hits + 1')
    .run(projectId, day, r)
}

/**
 * Суммы маршрутов → отчёты. Каждый заход дал +1 каждому своему началу, поэтому «закончились ровно здесь» = маршрут минус
 * его продолжения на один шаг; переход «A → B» — это последние два шага маршрута; вход — маршрут из одного шага.
 */
export function routeReport(rows, limit = 15) {
  const childSum = new Map()
  const transitions = new Map()
  const entries = new Map()
  const exits = new Map()
  const add = (m, k, n) => m.set(k, (m.get(k) || 0) + n)
  for (const { route, hits } of rows) {
    const steps = route.split(ROUTE_SEP)
    if (steps.length === 1) { add(entries, route, hits); continue }
    add(childSum, steps.slice(0, -1).join(ROUTE_SEP), hits)
    add(transitions, `${steps[steps.length - 2]}${ROUTE_SEP}${steps[steps.length - 1]}`, hits)
  }
  const routes = []
  for (const { route, hits } of rows) {
    const ended = Math.max(0, hits - (childSum.get(route) || 0))
    if (!ended) continue
    const steps = route.split(ROUTE_SEP)
    routes.push({ steps, count: ended })
    add(exits, steps[steps.length - 1], ended)
  }
  const top = (m, key) => [...m.entries()].map(([k, count]) => ({ [key]: k, count })).sort((a, b) => b.count - a.count || String(a[key]).localeCompare(String(b[key]))).slice(0, limit)
  return {
    routes: routes.sort((a, b) => b.count - a.count || a.steps.length - b.steps.length).slice(0, limit),
    transitions: top(transitions, 'pair').map(({ pair, count }) => ({ from: pair.split(ROUTE_SEP)[0], to: pair.split(ROUTE_SEP)[1], count })),
    entries: top(entries, 'path'),
    exits: top(exits, 'path'),
  }
}

export function registerAnalyticsRoutes(app, { db, audit, mskToday, hardRateLimited, projectByOrigin, resolveProjectId, paidStage }) {
  app.get('/nv.js', async (req, reply) => reply
    .header('content-type', 'application/javascript; charset=utf-8')
    .header('cache-control', 'public, max-age=3600')
    .send(COUNTER_JS))

  // Скрипт шлёт text/plain в режиме no-cors (без предварительного запроса), ответ ему не нужен — всегда 204.
  // Чужой домен, бот, мусор — молча не считаем. Проект — только по Origin (projects.origins или стенд, ADR-026).
  app.post('/api/collect', { bodyLimit: 4096 }, async (req, reply) => {
    reply.code(204)
    if (hardRateLimited('site_visits', req.ip)) return reply.send()
    const project = projectByOrigin(req.headers.origin)
    if (!project || BOT_UA.test(String(req.headers['user-agent'] || ''))) return reply.send()
    let b = req.body
    if (typeof b === 'string') { try { b = JSON.parse(b) } catch { return reply.send() } }
    if (!b || typeof b !== 'object' || Array.isArray(b)) return reply.send()
    const path = b.path === undefined ? '' : cleanPath(b.path)
    const route = cleanRoute(b.route)
    const day = mskToday()
    // Просмотр — только со страницей; отметка (nvMark) приходит без страницы и удлиняет только маршрут.
    if (path) await recordVisit(db, { projectId: project.id, day, path, attribution: normalizeAttribution(b.attribution), first: b.first === true })
    if (route) await recordRoute(db, { projectId: project.id, day, route })
    return reply.send()
  })

  // Отчёт за период: посещения по дням, каналам, страницам, сайтам-источникам и меткам + заявки и оплаты по каналам сделок.
  app.get('/api/crm/analytics', async (req, reply) => {
    const days = PERIODS.includes(Number(req.query.days)) ? Number(req.query.days) : 30
    const pid = await resolveProjectId(req.query.project)
    if (pid === undefined) return reply.code(400).send({ error: 'unknown_project' })
    const fromDay = mskToday(-(days - 1))
    // Начало дня по Москве в том же виде, что created_at (ISO, UTC).
    const fromIso = new Date(`${fromDay}T00:00:00+03:00`).toISOString()
    const pf = pid ? ' AND project_id = ?' : ''
    const args = (first) => (pid ? [first, pid] : [first])
    const num = (rows, ...cols) => rows.map((r) => ({ ...r, ...Object.fromEntries(cols.map((c) => [c, Number(r[c] || 0)])) }))

    const byDay = num(await db.prepare(`SELECT day, SUM(views) views, SUM(visits) visits FROM site_visits WHERE day >= ?${pf} GROUP BY day ORDER BY day`).all(...args(fromDay)), 'views', 'visits')
    const visitsByChannel = num(await db.prepare(`SELECT channel, SUM(visits) visits, SUM(views) views FROM site_visits WHERE day >= ?${pf} GROUP BY channel`).all(...args(fromDay)), 'visits', 'views')
    const pages = num(await db.prepare(`SELECT path, SUM(views) views FROM site_visits WHERE day >= ?${pf} GROUP BY path ORDER BY views DESC, path LIMIT 15`).all(...args(fromDay)), 'views')
    const refs = num(await db.prepare(`SELECT ref_host, SUM(visits) visits FROM site_visits WHERE day >= ?${pf} AND ref_host != '' GROUP BY ref_host ORDER BY visits DESC, ref_host LIMIT 10`).all(...args(fromDay)), 'visits')
    const campaigns = num(await db.prepare(`SELECT utm_source, utm_campaign, SUM(visits) visits FROM site_visits WHERE day >= ?${pf} AND utm_source != '' GROUP BY utm_source, utm_campaign ORDER BY visits DESC, utm_source LIMIT 10`).all(...args(fromDay)), 'visits')
    const routes = routeReport(num(await db.prepare(`SELECT route, SUM(hits) hits FROM site_routes WHERE day >= ?${pf} GROUP BY route`).all(...args(fromDay)), 'hits'))
    const leadsByChannel = num(await db.prepare(`SELECT COALESCE(channel, '') channel, COUNT(*) leads,
        SUM(CASE WHEN stage = ? THEN 1 ELSE 0 END) paid, SUM(CASE WHEN stage = ? THEN COALESCE(amount, 0) ELSE 0 END) revenue
      FROM deals WHERE demo = 0 AND created_at >= ?${pf} GROUP BY COALESCE(channel, '')`).all(paidStage, paidStage, ...args(fromIso)), 'leads', 'paid', 'revenue')

    // Одна строка на канал: и посещения, и заявки. Порядок — по заходам, потом по заявкам.
    const rows = new Map()
    const row = (ch) => rows.get(ch) || rows.set(ch, { channel: ch, visits: 0, views: 0, leads: 0, paid: 0, revenue: 0 }).get(ch)
    for (const r of visitsByChannel) Object.assign(row(r.channel), { visits: r.visits, views: r.views })
    for (const r of leadsByChannel) Object.assign(row(r.channel), { leads: r.leads, paid: r.paid, revenue: r.revenue })
    const channels = [...rows.values()].sort((x, y) => y.visits - x.visits || y.leads - x.leads)
    const sum = (k) => channels.reduce((s, r) => s + r[k], 0)
    return {
      days, fromDay,
      totals: { visits: sum('visits'), views: sum('views'), leads: sum('leads'), paid: sum('paid'), revenue: sum('revenue') },
      byDay, channels, pages, refs, campaigns, ...routes,
    }
  })

  // Очистить статистику посещений и маршрутов — на общем запуске (тестовые заходы со стендов) или по желанию. Заявки не трогает.
  app.delete('/api/crm/analytics/visits', async (req, reply) => {
    if (req.user.role !== 'admin') return reply.code(403).send({ error: 'admin_only' })
    const n = Number((await db.prepare('SELECT COUNT(*) c FROM site_visits').get()).c)
    await db.prepare('DELETE FROM site_visits').run()
    await db.prepare('DELETE FROM site_routes').run()
    await audit(req, 'delete', 'site_visits', null, `строк: ${n}`)
    return { ok: true, removed: n }
  })
}
