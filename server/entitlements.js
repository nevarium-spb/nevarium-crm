// Тарифы клиентов (ADR-019): учёт оплаченного права на проверки, правила-предупреждения
// для эксперта, данные для приложения NVizor и кабинета клиента на сайте.
//
// Контракт — `G:\nevarium_vizor\docs\SUBSCRIPTIONS.md` (ADR-016 сайта, 2026-10-10).
// Коды тарифов и этапов общие для CRM, NVizor и сайта — меняются только вместе с ним.
//
// Главные решения владельца, на которых держится код:
// - источник правды — CRM, клиент определяется по телефону (ключ — последние 10 цифр);
// - оплата вносится вручную, каждое изменение — в журнал действий;
// - НИЧЕГО НЕ БЛОКИРУЕТСЯ: нарушение — только предупреждение эксперту;
// - правила считает только CRM (evaluateCheck), приложение и кабинет их не дублируют;
// - в мессенджеры — ничего с ПДн (ADR-018), в кабинет — без телефона/почты/id.
//
// Free сюда не относится: его учёт — nvizor_free_reports (ADR-016 CRM), не трогаем.

import crypto from 'node:crypto'
import { nvizorPhoneKey } from './nvizor.js'

// ---------- справочники контракта (раздел 2) ----------

export const PLANS = {
  stage: { title: 'Проверка этапа', price: 4990 },
  repair: { title: 'Ремонт под контролем', price: 19900 },
  house: { title: 'Дом под контролем', price: 29900 },
  monthly: { title: 'Объект помесячно', price: 14900 },
  company: { title: 'Компания', price: 11900 },
  recheck: { title: 'Повторная проверка', price: 1990 },
}
export const PACKAGE_PLANS = ['repair', 'house']
export const PERIOD_PLANS = ['monthly', 'company']

export const STAGES = {
  repair: [
    ['electrical', 'электрика'], ['plumbing', 'сантехника'], ['waterproofing', 'гидроизоляция'],
    ['screed', 'стяжка'], ['plaster', 'штукатурка'],
  ],
  house: [
    ['base', 'основание'], ['foundation_rebar', 'армирование фундамента'],
    ['foundation', 'фундамент после распалубки'], ['walls', 'стены'], ['floors', 'перекрытия'],
    ['roof', 'кровля'], ['windows', 'окна и утепление'], ['engineering', 'инженерные системы'],
  ],
}
const STAGE_TITLE = Object.fromEntries([...STAGES.repair, ...STAGES.house])
const stageTitle = (code) => STAGE_TITLE[code] || code

export const LIMITS = { photos: 30, recheckPhotos: 10, videos: 2, recheckWorkdays: 3, expiringSoonDays: 3, checksPerPeriod: 4, periodDays: 30 }
// За сколько дней до конца срока CRM ставит задачу «продлить / связаться» (раздел 4).
export const REMINDER_DAYS = { monthly: 7, company: 7, stage: 30, repair: 30, house: 30 }

// ---------- даты: всё в МСК, строки YYYY-MM-DD ----------

const MSK_OFFSET_MS = 3 * 3600 * 1000
/** Дата в МСК для момента времени (ISO-строка или мс). */
export function mskDateOf(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(ms)) return null
  return new Date(ms + MSK_OFFSET_MS).toISOString().slice(0, 10)
}
const toUtc = (d) => Date.parse(`${d}T00:00:00Z`)
export function addDays(date, n) {
  return new Date(toUtc(date) + n * 86400000).toISOString().slice(0, 10)
}
export function daysBetween(from, to) {
  return Math.round((toUtc(to) - toUtc(from)) / 86400000)
}
/** Год с даты оплаты включительно: 2026-10-10 → 2027-10-09 (пример контракта, 5.1). */
export function addYearInclusive(date) {
  const d = new Date(toUtc(date))
  d.setUTCFullYear(d.getUTCFullYear() + 1)
  return addDays(d.toISOString().slice(0, 10), -1)
}
/** Рабочих дней (пн–пт, без праздников — известное упрощение контракта) после from до to включительно. */
export function workdaysAfter(from, to) {
  let n = 0
  for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) {
    const wd = new Date(toUtc(d)).getUTCDay()
    if (wd !== 0 && wd !== 6) n++
  }
  return n
}
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(toUtc(s))
const ru = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : '')
const ruShort = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : '')

/** Срок по умолчанию: пакеты и разовая — год с оплаты, помесячные — 30 дней, повторная — без срока. */
export function defaultExpiry(plan, startsOn) {
  if (PERIOD_PLANS.includes(plan)) return addDays(startsOn, LIMITS.periodDays - 1)
  if (plan === 'recheck') return null
  return addYearInclusive(startsOn)
}

// ---------- разбор строк БД ----------

const parseList = (v) => {
  if (Array.isArray(v)) return v
  try { const x = JSON.parse(v || '[]'); return Array.isArray(x) ? x : [] } catch { return [] }
}
export function rowToEntitlement(r) {
  return {
    id: r.id, contactId: r.contact_id, projectId: r.project_id, plan: r.plan,
    startsOn: r.starts_on, expiresOn: r.expires_on || null,
    periodDays: r.period_days ?? null, checksPerPeriod: r.checks_per_period ?? null,
    objects: parseList(r.objects).map(String), stages: parseList(r.stages).map(String),
    urgent: Boolean(r.urgent), weekend: Boolean(r.weekend), parentReport: r.parent_report || '',
    paidAmount: r.paid_amount ?? null, creditedFrom: parseList(r.credited_from).map(Number),
    status: r.status, note: r.note || '', createdAt: r.created_at,
  }
}
export function rowToCheck(r) {
  return {
    id: r.id, entitlementId: r.entitlement_id ?? null, contactId: r.contact_id ?? null,
    recordId: r.record_id, objectRef: r.object_ref || '', stageCode: r.stage_code || '',
    kind: r.kind, photos: r.photos ?? 0, videos: r.videos ?? 0,
    reportNumber: r.report_number || '', parentReportNumber: r.parent_report_number || '',
    urgent: Boolean(r.urgent), weekend: Boolean(r.weekend), issuedAt: r.issued_at,
  }
}

const norm = (s) => String(s ?? '').trim().toLowerCase()

// ---------- состояние права ----------

/** Проверки, засчитанные праву: свои + проверки разовых, засчитанных в пакет. */
function checksOf(ent, checks) {
  const ids = new Set([ent.id, ...ent.creditedFrom])
  return checks.filter((c) => c.entitlementId !== null && ids.has(c.entitlementId))
}

/** Текущий период помесячного тарифа: окна по periodDays от даты оплаты. */
function currentPeriod(ent, today) {
  const len = ent.periodDays || LIMITS.periodDays
  let ref = today
  if (ent.expiresOn && ref > ent.expiresOn) ref = ent.expiresOn
  if (ref < ent.startsOn) ref = ent.startsOn
  const idx = Math.floor(daysBetween(ent.startsOn, ref) / len)
  const start = addDays(ent.startsOn, idx * len)
  return { start, end: addDays(start, len - 1) }
}

function periodUsage(ent, checks, today, objectRef = null) {
  if (!PERIOD_PLANS.includes(ent.plan)) return null
  const { start, end } = currentPeriod(ent, today)
  const own = checksOf(ent, checks).filter((c) => {
    const d = mskDateOf(c.issuedAt)
    if (c.kind !== 'primary' || !d || d < start || d > end) return false
    return objectRef === null || norm(c.objectRef) === norm(objectRef)
  })
  const perObject = ent.checksPerPeriod || LIMITS.checksPerPeriod
  // У «Компании» лимит на объект; в сводке (без конкретного объекта) — на все объекты сразу.
  const limit = ent.plan === 'company' && objectRef === null ? perObject * Math.max(1, ent.objects.length) : perObject
  return { used: own.length, limit, endsOn: end }
}

function stageList(ent, checks) {
  if (!PACKAGE_PLANS.includes(ent.plan)) return []
  const own = checksOf(ent, checks)
  return ent.stages.map((code) => ({
    code,
    title: stageTitle(code),
    checked: own.some((c) => c.kind === 'primary' && c.stageCode === code),
    recheckUsed: own.some((c) => c.kind === 'recheck' && c.stageCode === code),
  }))
}

const isActiveOn = (ent, today) => ent.status === 'active' && ent.startsOn <= today && (!ent.expiresOn || today <= ent.expiresOn)
const daysLeftOf = (ent, today) => (ent.expiresOn ? daysBetween(today, ent.expiresOn) : null)

/** Как право показывается эксперту и клиенту (без внутренних полей). */
export function describeEntitlement(ent, checks, today) {
  return {
    plan: ent.plan,
    title: PLANS[ent.plan]?.title || ent.plan,
    status: ent.status,
    startsOn: ent.startsOn,
    expiresOn: ent.expiresOn,
    daysLeft: daysLeftOf(ent, today),
    stages: stageList(ent, checks),
    period: periodUsage(ent, checks, today),
  }
}

/** Предупреждения уровня «состояние тарифа» — для значков в списках CRM. */
export function statusWarnings(ent, checks, today) {
  const out = []
  const left = daysLeftOf(ent, today)
  if (ent.expiresOn && left < 0) out.push(warn('expired', ent))
  else if (ent.expiresOn && left <= LIMITS.expiringSoonDays) out.push(warn('expiring_soon', ent, { left }))
  const p = periodUsage(ent, checks, today)
  if (p && (left === null || left >= 0) && p.used >= p.limit) out.push(warn('period_limit', ent, { period: p }))
  return out
}

// ---------- тексты предупреждений (раздел 4) ----------

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}
const q = (s) => `„${s}“`

function warn(code, ent, x = {}) {
  const title = ent ? PLANS[ent.plan]?.title || ent.plan : ''
  const texts = {
    no_entitlement: () => 'Оплаченного тарифа нет',
    expired: () => `Тариф ${q(title)} истёк ${ru(ent.expiresOn)}`,
    expiring_soon: () => (x.left === 0
      ? `Тариф истекает ${ru(ent.expiresOn)} — сегодня`
      : `Тариф истекает ${ru(ent.expiresOn)} — через ${x.left} ${plural(x.left, 'день', 'дня', 'дней')}`),
    period_limit: () => `Лимит периода исчерпан: ${x.period.used} из ${x.period.limit} (период до ${ruShort(x.period.endsOn)})`,
    object_not_in_plan: () => 'Объект не входит в тариф',
    stage_not_in_package: () => `Этап ${q(stageTitle(x.stage))} не входит в ${q(title)}`,
    stage_already_checked: () => (ent.plan === 'stage'
      ? `Разовая проверка уже использована ${ruShort(x.date)} — это повторная?`
      : `Этап ${q(stageTitle(x.stage))} уже проверен ${ruShort(x.date)} — это повторная?`),
    recheck_used: () => 'Повторная по этапу уже использована',
    recheck_window: () => `С отчёта ${x.report} прошло ${x.days} ${plural(x.days, 'рабочий день', 'рабочих дня', 'рабочих дней')} (лимит ${LIMITS.recheckWorkdays})`,
    photo_limit: () => `${x.count} фото при лимите ${x.limit}`,
    video_limit: () => `${x.count} видео при лимите ${x.limit}`,
    urgent_not_paid: () => 'Срочность не оплачена (+2 000 ₽)',
    weekend_not_paid: () => 'Проверка в выходной не оплачена (+2 000 ₽)',
  }
  return { code, text: texts[code]() }
}

// ---------- правила (раздел 4) ----------

/**
 * Насколько право подходит проверке: 2 — действует и подходит по объекту/этапу,
 * 1 — подходит по смыслу (тот же тип проверки), 0 — не подходит вовсе.
 */
function fitness(ent, input, checks, today) {
  const own = checksOf(ent, checks)
  const kind = input.kind === 'recheck' ? 'recheck' : 'primary'
  let fits
  if (kind === 'recheck') {
    if (ent.plan === 'recheck') fits = !own.length && (!ent.parentReport || !input.parentReportNumber || norm(ent.parentReport) === norm(input.parentReportNumber))
    else if (PACKAGE_PLANS.includes(ent.plan)) fits = ent.stages.includes(input.stageCode) && !own.some((c) => c.kind === 'recheck' && c.stageCode === input.stageCode)
    else return 0
  } else {
    if (ent.plan === 'recheck') return 0
    if (ent.plan === 'stage') fits = !own.some((c) => c.kind === 'primary')
    else if (PACKAGE_PLANS.includes(ent.plan)) fits = ent.stages.includes(input.stageCode) && !own.some((c) => c.kind === 'primary' && c.stageCode === input.stageCode)
    else fits = !ent.objects.length || ent.objects.some((o) => norm(o) === norm(input.objectRef))
  }
  if (fits && isActiveOn(ent, today)) return 2
  return 1
}

/**
 * Единственная функция правил (контракт, раздел 4). Чистая: всё нужное — в аргументах,
 * поэтому каждое правило проверяется тестом без базы. Ничего не блокирует — возвращает
 * сопоставленное право, вердикт и готовые к показу тексты предупреждений.
 *
 * @param {object} args.entitlements — права клиента (rowToEntitlement)
 * @param {object} args.checks — выданные проверки клиента (rowToCheck), включая «вне тарифа»
 * @param {object} args.input — { objectRef, stageCode, kind, photos, videos, parentReportNumber, urgent, weekend }
 * @param {string} args.today — дата в МСК, YYYY-MM-DD
 */
export function evaluateCheck({ entitlements, checks, input, today }) {
  const kind = input.kind === 'recheck' ? 'recheck' : 'primary'
  // Сопоставление: действующее и подходящее → иначе ближайшее по смыслу (чтобы
  // предупреждение было конкретным) → иначе no_entitlement. Отменённые и засчитанные
  // в пакет права в сопоставлении не участвуют.
  const live = entitlements.filter((e) => e.status === 'active')
  const ranked = live
    .map((e) => ({ e, fit: fitness(e, input, checks, today), active: isActiveOn(e, today) }))
    .filter((x) => x.fit > 0)
    .sort((a, b) => b.fit - a.fit || Number(b.active) - Number(a.active) || (b.e.startsOn || '').localeCompare(a.e.startsOn || '') || b.e.id - a.e.id)
  const ent = ranked[0]?.e || null

  const warnings = []
  if (!ent) {
    warnings.push(warn('no_entitlement'))
  } else {
    const left = daysLeftOf(ent, today)
    if (ent.expiresOn && left < 0) warnings.push(warn('expired', ent))
    else if (ent.expiresOn && left <= LIMITS.expiringSoonDays) warnings.push(warn('expiring_soon', ent, { left }))
    const own = checksOf(ent, checks)

    if (PERIOD_PLANS.includes(ent.plan) && kind === 'primary') {
      if (ent.objects.length && !ent.objects.some((o) => norm(o) === norm(input.objectRef))) warnings.push(warn('object_not_in_plan', ent))
      const p = periodUsage(ent, checks, today, ent.plan === 'company' ? input.objectRef ?? '' : null)
      if (p.used >= p.limit) warnings.push(warn('period_limit', ent, { period: p }))
    }
    if (PACKAGE_PLANS.includes(ent.plan)) {
      if (!ent.stages.includes(input.stageCode)) {
        warnings.push(warn('stage_not_in_package', ent, { stage: input.stageCode }))
      } else if (kind === 'primary') {
        const done = own.find((c) => c.kind === 'primary' && c.stageCode === input.stageCode)
        if (done) warnings.push(warn('stage_already_checked', ent, { stage: input.stageCode, date: mskDateOf(done.issuedAt) }))
      } else if (own.some((c) => c.kind === 'recheck' && c.stageCode === input.stageCode)) {
        warnings.push(warn('recheck_used', ent))
      }
    }
    if (ent.plan === 'stage' && kind === 'primary') {
      const done = own.find((c) => c.kind === 'primary')
      if (done) warnings.push(warn('stage_already_checked', ent, { stage: done.stageCode, date: mskDateOf(done.issuedAt) }))
    }
    if (ent.plan === 'recheck' && own.length) warnings.push(warn('recheck_used', ent))
    if (input.urgent && !ent.urgent) warnings.push(warn('urgent_not_paid', ent))
    if (input.weekend && !ent.weekend) warnings.push(warn('weekend_not_paid', ent))
  }

  // Окно повторной и лимиты вложений не зависят от права — считаются всегда.
  if (kind === 'recheck' && input.parentReportNumber) {
    const parent = checks.find((c) => norm(c.reportNumber) === norm(input.parentReportNumber))
    const from = parent && mskDateOf(parent.issuedAt)
    if (from) {
      const days = workdaysAfter(from, today)
      if (days > LIMITS.recheckWorkdays) warnings.push(warn('recheck_window', ent, { report: input.parentReportNumber, days }))
    }
  }
  const photoLimit = kind === 'recheck' ? LIMITS.recheckPhotos : LIMITS.photos
  if (Number(input.photos) > photoLimit) warnings.push(warn('photo_limit', ent, { count: Number(input.photos), limit: photoLimit }))
  if (Number(input.videos) > LIMITS.videos) warnings.push(warn('video_limit', ent, { count: Number(input.videos), limit: LIMITS.videos }))

  let match = null
  if (ent) {
    const d = describeEntitlement(ent, checks, today)
    match = { id: ent.id, plan: d.plan, title: d.title, expiresOn: d.expiresOn, daysLeft: d.daysLeft, stages: d.stages, period: d.period }
  }
  const verdict = !ent ? 'none' : warnings.length ? 'warning' : 'ok'
  return { match, verdict, warnings }
}

/**
 * УТП пакета для кабинета (раздел 5.2): только когда у клиента есть лишь разовые
 * «Проверки этапа» и нет действующего пакета или помесячного тарифа. Пакет — по типу
 * объекта (дом ИЖС → «Дом под контролем», иначе «Ремонт под контролем»).
 */
export function computeOffer(entitlements, today, objectType = '') {
  const live = entitlements.filter((e) => e.status === 'active')
  const stages = live.filter((e) => e.plan === 'stage')
  if (!stages.length) return null
  if (live.some((e) => (PACKAGE_PLANS.includes(e.plan) || PERIOD_PLANS.includes(e.plan)) && isActiveOn(e, today))) return null
  const plan = /ИЖС|частный дом/i.test(objectType) ? 'house' : 'repair'
  const price = PLANS[plan].price
  const credit = Math.min(price, stages.reduce((s, e) => s + (e.paidAmount ?? PLANS.stage.price), 0))
  return { plan, title: PLANS[plan].title, price, credit, toPay: price - credit }
}

// ---------- доступ к данным ----------

/** Контакты клиента по телефону — тем же ключом, что дедуп заявок (phone и старый messenger). */
export async function contactsByPhone(runner, phone, projectId) {
  const key = nvizorPhoneKey(phone)
  if (!key) return []
  const rows = await runner
    .prepare('SELECT id, name, phone, messenger FROM contacts WHERE project_id = ? AND anonymized_at IS NULL ORDER BY id DESC')
    .all(projectId)
  return rows.filter((c) => [c.phone, c.messenger].some((v) => nvizorPhoneKey(v) === key))
}

export async function loadClientState(runner, contactIds) {
  if (!contactIds.length) return { entitlements: [], checks: [] }
  const marks = contactIds.map(() => '?').join(',')
  const ents = await runner.prepare(`SELECT * FROM entitlements WHERE contact_id IN (${marks}) ORDER BY id`).all(...contactIds)
  const checks = await runner.prepare(`SELECT * FROM entitlement_checks WHERE contact_id IN (${marks}) ORDER BY issued_at, id`).all(...contactIds)
  return { entitlements: ents.map(rowToEntitlement), checks: checks.map(rowToCheck) }
}

/** Тип объекта клиента — из названия последней сделки (сайт Визора шлёт его полем task). */
async function objectTypeOf(runner, contactId) {
  const row = await runner.prepare('SELECT title FROM deals WHERE contact_id = ? ORDER BY id DESC LIMIT 1').get(contactId)
  return row?.title || ''
}

export const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex')
export const newToken = () => crypto.randomBytes(32).toString('base64url')

/** Удаление вместе с контактом (152-ФЗ): вызывается внутри транзакции удаления/обезличивания. */
export async function deleteEntitlementsForContact(tx, contactId, phones = []) {
  await tx.prepare('DELETE FROM client_links WHERE contact_id = ?').run(contactId)
  await tx.prepare('DELETE FROM entitlement_checks WHERE contact_id = ? OR entitlement_id IN (SELECT id FROM entitlements WHERE contact_id = ?)').run(contactId, contactId)
  // Проверки «вне тарифа», пришедшие до того, как клиента завели в CRM: привязаны только ключом телефона.
  for (const key of new Set(phones.map(nvizorPhoneKey).filter(Boolean))) {
    await tx.prepare('DELETE FROM entitlement_checks WHERE contact_id IS NULL AND phone_key = ?').run(key)
  }
  await tx.prepare('DELETE FROM entitlements WHERE contact_id = ?').run(contactId)
}

// ---------- разбор входа ----------

const str = (v, max) => String(v ?? '').trim().slice(0, max)
const int = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.max(0, Math.trunc(Number(v))) : 0)
function checkInput(b) {
  return {
    objectRef: str(b.objectRef, 200),
    stageCode: str(b.stageCode, 60),
    kind: b.kind === 'recheck' ? 'recheck' : 'primary',
    photos: int(b.photos),
    videos: int(b.videos),
    parentReportNumber: str(b.parentReportNumber, 60),
    urgent: b.urgent === true,
    weekend: b.weekend === true,
  }
}

// ---------- роуты ----------

/**
 * @param deps.mskToday — () => 'YYYY-MM-DD' в МСК (app.js)
 * @param deps.projectId — async () => id проекта nevarium-vizor
 * @param deps.cabinetBaseUrl — база ссылки кабинета (без «/#/c/…»)
 */
export function registerEntitlementRoutes(app, deps) {
  const { db, withMutation, audit, now, mskToday, projectId, cabinetBaseUrl, hardRateLimited, applyCors, corsPreflight } = deps

  async function resolveClient(runner, phone) {
    const pid = await projectId()
    const contacts = await contactsByPhone(runner, phone, pid)
    return { contacts, primary: contacts[0] || null }
  }

  // ---- 5.1 NVizor → CRM (ключ приложения проверяет хук /api/nvizor/ в nvizor.js) ----

  app.post('/api/nvizor/entitlements/evaluate', { bodyLimit: 16 * 1024 }, async (req, reply) => {
    const b = req.body || {}
    if (!nvizorPhoneKey(str(b.phone, 40))) return reply.code(400).send({ error: 'bad_phone' })
    const { contacts, primary } = await resolveClient(db, str(b.phone, 40))
    const state = await loadClientState(db, contacts.map((c) => c.id))
    const result = evaluateCheck({ ...state, input: checkInput(b), today: mskToday() })
    return { client: primary ? { name: primary.name } : null, ...result }
  })

  app.post('/api/nvizor/entitlements/usage', { bodyLimit: 16 * 1024 }, async (req, reply) => {
    const b = req.body || {}
    const recordId = str(b.recordId, 100)
    const issuedAt = str(b.issuedAt, 40)
    if (!recordId || !Number.isFinite(Date.parse(issuedAt))) return reply.code(400).send({ error: 'bad_request' })
    const input = checkInput(b)
    const phone = str(b.phone, 40)
    const phoneKey = nvizorPhoneKey(phone)
    await withMutation(async (tx) => {
      let entitlementId = b.entitlementId === null || b.entitlementId === undefined ? null : Number(b.entitlementId)
      let contactId = null
      if (entitlementId !== null) {
        const ent = Number.isInteger(entitlementId) ? await tx.prepare('SELECT id, contact_id FROM entitlements WHERE id = ?').get(entitlementId) : null
        if (ent) contactId = ent.contact_id
        else entitlementId = null
      }
      if (contactId === null && phoneKey) contactId = (await resolveClient(tx, phone)).primary?.id ?? null
      await tx.prepare(`INSERT INTO entitlement_checks (entitlement_id, contact_id, phone_key, record_id, object_ref, stage_code, kind, photos, videos,
          report_number, parent_report_number, urgent, weekend, issued_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (record_id) DO NOTHING`)
        .run(entitlementId, contactId, phoneKey, recordId, input.objectRef, input.stageCode, input.kind, input.photos, input.videos,
          str(b.reportNumber, 60), input.parentReportNumber, input.urgent ? 1 : 0, input.weekend ? 1 : 0, issuedAt, now())
    })
    return reply.code(201).send({ ok: true })
  })

  app.post('/api/nvizor/client-link', { bodyLimit: 4 * 1024 }, async (req, reply) => {
    const phone = str(req.body?.phone, 40)
    if (!nvizorPhoneKey(phone)) return reply.code(400).send({ error: 'bad_phone' })
    const token = newToken()
    const created = await withMutation(async (tx) => {
      const { primary } = await resolveClient(tx, phone)
      if (!primary) return false
      await tx.prepare('INSERT INTO client_links (contact_id, token_hash, created_at) VALUES (?, ?, ?)').run(primary.id, hashToken(token), now())
      return true
    })
    // Ссылку привязать не к кому — клиента с таким телефоном в CRM нет. Не заводим
    // карточку молча: её заводит заявка с сайта или сотрудник.
    if (!created) return reply.code(404).send({ error: 'client_not_found' })
    return { url: `${cabinetBaseUrl}/#/c/${token}` }
  })

  // ---- 5.2 Кабинет на сайте → CRM (публично) ----

  app.options('/api/client/summary', corsPreflight)
  app.post('/api/client/summary', { bodyLimit: 4 * 1024 }, async (req, reply) => {
    await applyCors(req, reply)
    if (hardRateLimited('client_summary', req.ip)) return reply.code(429).send()
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : ''
    // Неверный, отозванный и чужой ключ — один и тот же 404: ответ не подсказывает,
    // существовал ли ключ (не оракул).
    const notFound = () => reply.code(404).send({ error: 'not_found' })
    if (!token || token.length > 200) return notFound()
    const link = await db.prepare(`SELECT l.id, l.contact_id, c.name FROM client_links l JOIN contacts c ON c.id = l.contact_id
      WHERE l.token_hash = ? AND l.revoked_at IS NULL AND c.anonymized_at IS NULL`).get(hashToken(token))
    if (!link) return notFound()
    await db.prepare('UPDATE client_links SET last_used_at = ? WHERE id = ?').run(now(), link.id)
    const today = mskToday()
    const { entitlements, checks } = await loadClientState(db, [link.contact_id])
    const shown = entitlements.filter((e) => e.status === 'active')
    return {
      client: { name: link.name },
      entitlements: shown.map((e) => describeEntitlement(e, checks, today)),
      offer: computeOffer(entitlements, today, await objectTypeOf(db, link.contact_id)),
    }
  })

  // ---- CRM: блок «Тариф» в карточке клиента ----

  const PLAN_CODES = Object.keys(PLANS)

  async function contactState(runner, contactId) {
    const today = mskToday()
    const { entitlements, checks } = await loadClientState(runner, [contactId])
    const links = await runner.prepare('SELECT COUNT(*) c, MAX(created_at) last FROM client_links WHERE contact_id = ? AND revoked_at IS NULL').get(contactId)
    return {
      today,
      entitlements: entitlements.map((e) => ({
        id: e.id, note: e.note, paidAmount: e.paidAmount, objects: e.objects, urgent: e.urgent, weekend: e.weekend,
        parentReport: e.parentReport, creditedFrom: e.creditedFrom, createdAt: e.createdAt,
        ...describeEntitlement(e, checks, today),
        warnings: e.status === 'active' ? statusWarnings(e, checks, today) : [],
      })),
      checks: checks.slice().reverse(),
      links: { active: Number(links?.c || 0), lastCreatedAt: links?.last || null },
      offer: computeOffer(entitlements, today, await objectTypeOf(runner, contactId)),
      plans: PLANS,
      stages: STAGES,
    }
  }

  const summaryOf = (e) => `${e.plan} ${e.starts_on}…${e.expires_on || '∞'} ${e.status}${e.paid_amount != null ? ` ${e.paid_amount}₽` : ''}`

  app.get('/api/crm/contacts/:id/entitlements', async (req, reply) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id' })
    const contact = await db.prepare('SELECT id FROM contacts WHERE id = ?').get(id)
    if (!contact) return reply.code(404).send({ error: 'not_found' })
    return contactState(db, id)
  })

  // Значки для списков: только контакты, у которых есть право. Маленькая таблица —
  // один запрос на всё, без N+1 со стороны списка.
  app.get('/api/crm/entitlements/badges', async () => {
    const today = mskToday()
    const ents = (await db.prepare("SELECT * FROM entitlements WHERE status = 'active' ORDER BY id").all()).map(rowToEntitlement)
    const checks = (await db.prepare('SELECT * FROM entitlement_checks WHERE entitlement_id IS NOT NULL').all()).map(rowToCheck)
    const out = {}
    for (const e of ents) {
      const d = { plan: e.plan, title: PLANS[e.plan]?.title || e.plan, expiresOn: e.expiresOn, warnings: statusWarnings(e, checks, today) }
      const prev = out[e.contactId]
      // Показываем «главное» право: действующее раньше истёкшего, свежее раньше старого.
      if (!prev || (!d.warnings.some((w) => w.code === 'expired') || prev.warnings.some((w) => w.code === 'expired'))) out[e.contactId] = d
    }
    return { items: out }
  })

  function parseFields(b, plan) {
    const f = {}
    if (b.starts_on !== undefined) { if (!isDate(b.starts_on)) return { error: 'bad_date' }; f.starts_on = b.starts_on }
    if (b.expires_on !== undefined) {
      if (b.expires_on !== null && b.expires_on !== '' && !isDate(b.expires_on)) return { error: 'bad_date' }
      f.expires_on = b.expires_on || null
    }
    if (b.objects !== undefined) f.objects = JSON.stringify((Array.isArray(b.objects) ? b.objects : []).map((o) => str(o, 200)).filter(Boolean).slice(0, 100))
    if (b.stages !== undefined) {
      const allowed = new Set((STAGES[plan] || []).map(([c]) => c))
      const list = (Array.isArray(b.stages) ? b.stages : []).map((s) => str(s, 60)).filter((s) => allowed.has(s))
      f.stages = JSON.stringify([...new Set(list)])
    }
    if (b.urgent !== undefined) f.urgent = b.urgent ? 1 : 0
    if (b.weekend !== undefined) f.weekend = b.weekend ? 1 : 0
    if (b.parent_report !== undefined) f.parent_report = str(b.parent_report, 60)
    if (b.paid_amount !== undefined) f.paid_amount = b.paid_amount === null || b.paid_amount === '' ? null : int(b.paid_amount)
    if (b.note !== undefined) f.note = str(b.note, 1000)
    if (b.checks_per_period !== undefined) f.checks_per_period = Math.max(1, int(b.checks_per_period))
    return { f }
  }

  // Назначить тариф (оплата внесена вручную).
  app.post('/api/crm/entitlements', async (req, reply) => {
    const b = req.body || {}
    const contactId = Number(b.contact_id)
    const plan = String(b.plan || '')
    if (!Number.isInteger(contactId) || !PLAN_CODES.includes(plan)) return reply.code(400).send({ error: 'bad_input' })
    const startsOn = b.starts_on ?? mskToday()
    if (!isDate(startsOn)) return reply.code(400).send({ error: 'bad_date' })
    const { f, error } = parseFields({ ...b, starts_on: startsOn }, plan)
    if (error) return reply.code(400).send({ error })
    const row = {
      contact_id: contactId, plan, starts_on: startsOn,
      expires_on: b.expires_on !== undefined ? f.expires_on : defaultExpiry(plan, startsOn),
      period_days: PERIOD_PLANS.includes(plan) ? LIMITS.periodDays : null,
      checks_per_period: PERIOD_PLANS.includes(plan) ? f.checks_per_period ?? LIMITS.checksPerPeriod : null,
      objects: f.objects ?? '[]',
      stages: f.stages ?? JSON.stringify(PACKAGE_PLANS.includes(plan) ? STAGES[plan].map(([c]) => c) : []),
      urgent: f.urgent ?? 0, weekend: f.weekend ?? 0, parent_report: f.parent_report ?? '',
      paid_amount: b.paid_amount !== undefined ? f.paid_amount : PLANS[plan].price,
      note: f.note ?? '', ts: now(),
    }
    const id = await withMutation(async (tx) => {
      const c = await tx.prepare('SELECT project_id FROM contacts WHERE id = ? FOR UPDATE').get(contactId)
      if (!c) return null
      const info = await tx.prepare(`INSERT INTO entitlements (contact_id, project_id, plan, starts_on, expires_on, period_days, checks_per_period,
          objects, stages, urgent, weekend, parent_report, paid_amount, credited_from, status, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'active', ?, ?, ?) RETURNING id`)
        .run(contactId, c.project_id, plan, row.starts_on, row.expires_on, row.period_days, row.checks_per_period, row.objects, row.stages,
          row.urgent, row.weekend, row.parent_report, row.paid_amount, row.note, row.ts, row.ts)
      const created = await tx.prepare('SELECT * FROM entitlements WHERE id = ?').get(info.lastInsertRowid)
      await audit(req, 'create', 'entitlements', info.lastInsertRowid, `назначен: — → ${summaryOf(created)}`, tx)
      return info.lastInsertRowid
    })
    if (!id) return reply.code(400).send({ error: 'bad_reference' })
    return { ok: true, id }
  })

  async function mutateEntitlement(req, reply, fn) {
    const id = Number(req.params.id)
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad_id' })
    let failed = null
    await withMutation(async (tx) => {
      const before = await tx.prepare('SELECT * FROM entitlements WHERE id = ? FOR UPDATE').get(id)
      if (!before) { failed = [404, { error: 'not_found' }]; return }
      const res = await fn(tx, before)
      if (res?.error) { failed = [400, res]; return }
      const after = await tx.prepare('SELECT * FROM entitlements WHERE id = ?').get(id)
      await audit(req, res.action, 'entitlements', id, `${res.label}: ${summaryOf(before)} → ${summaryOf(after)}${res.extra ? ` (${res.extra})` : ''}`, tx)
    })
    if (failed) return reply.code(failed[0]).send(failed[1])
    return { ok: true }
  }

  // Изменить срок, состав, опции, сумму, заметку.
  app.patch('/api/crm/entitlements/:id', (req, reply) => mutateEntitlement(req, reply, async (tx, before) => {
    const { f, error } = parseFields(req.body || {}, before.plan)
    if (error) return { error }
    const cols = Object.keys(f)
    if (!cols.length) return { error: 'nothing_to_update' }
    await tx.prepare(`UPDATE entitlements SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map((c) => f[c]), now(), before.id)
    return { action: 'update', label: 'изменён', extra: cols.join(', ') }
  }))

  // Продлить: помесячные — следующие 30 дней, остальные — следующий год. Если срок уже
  // истёк, новый отсчитывается от сегодняшней оплаты, а не от давно прошедшей даты.
  app.post('/api/crm/entitlements/:id/renew', (req, reply) => mutateEntitlement(req, reply, async (tx, before) => {
    const ent = rowToEntitlement(before)
    if (ent.status !== 'active') return { error: 'not_active' }
    const today = mskToday()
    let startsOn = ent.startsOn
    let expiresOn
    if (!ent.expiresOn || ent.expiresOn < addDays(today, -1)) {
      startsOn = today
      expiresOn = defaultExpiry(ent.plan, today)
    } else {
      expiresOn = PERIOD_PLANS.includes(ent.plan) ? addDays(ent.expiresOn, ent.periodDays || LIMITS.periodDays) : addYearInclusive(addDays(ent.expiresOn, 1))
    }
    const paid = req.body?.paid_amount
    await tx.prepare('UPDATE entitlements SET starts_on = ?, expires_on = ?, paid_amount = COALESCE(?, paid_amount), reminded_for = NULL, updated_at = ? WHERE id = ?')
      .run(startsOn, expiresOn, paid === undefined || paid === null || paid === '' ? null : int(paid), now(), ent.id)
    return { action: 'update', label: 'продлён' }
  }))

  app.post('/api/crm/entitlements/:id/cancel', (req, reply) => mutateEntitlement(req, reply, async (tx, before) => {
    if (before.status !== 'active') return { error: 'not_active' }
    await tx.prepare("UPDATE entitlements SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now(), before.id)
    return { action: 'update', label: 'отменён' }
  }))

  // Перевести в пакет: оплаченные разовые «Проверки этапа» засчитываются и деньгами, и
  // этапом (раздел 3). Доплата = цена пакета − уже оплаченное; срок — год от доплаты.
  app.post('/api/crm/contacts/:id/entitlements/convert', async (req, reply) => {
    const contactId = Number(req.params.id)
    const plan = String(req.body?.plan || '')
    if (!Number.isInteger(contactId) || !PACKAGE_PLANS.includes(plan)) return reply.code(400).send({ error: 'bad_input' })
    const startsOn = req.body?.starts_on ?? mskToday()
    if (!isDate(startsOn)) return reply.code(400).send({ error: 'bad_date' })
    let result = null
    await withMutation(async (tx) => {
      const c = await tx.prepare('SELECT project_id FROM contacts WHERE id = ? FOR UPDATE').get(contactId)
      if (!c) { result = [404, { error: 'not_found' }]; return }
      const stages = (await tx.prepare("SELECT * FROM entitlements WHERE contact_id = ? AND plan = 'stage' AND status = 'active' ORDER BY id FOR UPDATE").all(contactId)).map(rowToEntitlement)
      if (!stages.length) { result = [400, { error: 'nothing_to_credit' }]; return }
      const credit = Math.min(PLANS[plan].price, stages.reduce((s, e) => s + (e.paidAmount ?? PLANS.stage.price), 0))
      const ts = now()
      const info = await tx.prepare(`INSERT INTO entitlements (contact_id, project_id, plan, starts_on, expires_on, period_days, checks_per_period,
          objects, stages, urgent, weekend, parent_report, paid_amount, credited_from, status, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, NULL, '[]', ?, 0, 0, '', ?, ?, 'active', ?, ?, ?) RETURNING id`)
        .run(contactId, c.project_id, plan, startsOn, addYearInclusive(startsOn), JSON.stringify(STAGES[plan].map(([s]) => s)),
          PLANS[plan].price - credit, JSON.stringify(stages.map((e) => e.id)), str(req.body?.note, 1000), ts, ts)
      const marks = stages.map(() => '?').join(',')
      await tx.prepare(`UPDATE entitlements SET status = 'credited', updated_at = ? WHERE id IN (${marks})`).run(ts, ...stages.map((e) => e.id))
      await audit(req, 'create', 'entitlements', info.lastInsertRowid,
        `переведён в пакет: stage #${stages.map((e) => e.id).join(', #')} → ${plan}, засчитано ${credit}₽, доплата ${PLANS[plan].price - credit}₽`, tx)
      result = [200, { ok: true, id: info.lastInsertRowid, credit, toPay: PLANS[plan].price - credit }]
    })
    return reply.code(result[0]).send(result[1])
  })

  // Личные ссылки: выпустить из CRM (ключ показывается один раз — CRM хранит только хеш).
  app.post('/api/crm/contacts/:id/client-links', async (req, reply) => {
    const contactId = Number(req.params.id)
    if (!Number.isInteger(contactId)) return reply.code(400).send({ error: 'bad_id' })
    const token = newToken()
    const ok = await withMutation(async (tx) => {
      const c = await tx.prepare('SELECT id FROM contacts WHERE id = ? AND anonymized_at IS NULL').get(contactId)
      if (!c) return false
      const info = await tx.prepare('INSERT INTO client_links (contact_id, token_hash, created_at) VALUES (?, ?, ?) RETURNING id').run(contactId, hashToken(token), now())
      await audit(req, 'create', 'client_links', info.lastInsertRowid, `ссылка в кабинет выпущена: — → контакт #${contactId}`, tx)
      return true
    })
    if (!ok) return reply.code(404).send({ error: 'not_found' })
    return { url: `${cabinetBaseUrl}/#/c/${token}` }
  })

  app.post('/api/crm/contacts/:id/client-links/revoke-all', async (req, reply) => {
    const contactId = Number(req.params.id)
    if (!Number.isInteger(contactId)) return reply.code(400).send({ error: 'bad_id' })
    const n = await withMutation(async (tx) => {
      const res = await tx.prepare('UPDATE client_links SET revoked_at = ? WHERE contact_id = ? AND revoked_at IS NULL').run(now(), contactId)
      const count = res?.changes ?? 0
      await audit(req, 'update', 'client_links', contactId, `ссылки в кабинет отозваны: ${count} действующих → 0`, tx)
      return count
    })
    return { ok: true, revoked: n }
  })
}

// ---------- напоминания (раздел 4) ----------

/**
 * Задача владельцу «Продлить / связаться с клиентом» за REMINDER_DAYS до конца срока —
 * один раз на срок (reminded_for = expires_on, при продлении сбрасывается). Уведомление
 * в мессенджеры — обезличенное (ADR-018): тариф, дата и ссылка на карточку, без имени.
 */
export async function runEntitlementReminders(db, { withMutation, enqueue, now, today, baseUrl = '' }) {
  const rows = await db.prepare("SELECT * FROM entitlements WHERE status = 'active' AND expires_on IS NOT NULL").all()
  let created = 0
  for (const r of rows) {
    if (r.reminded_for && r.reminded_for === r.expires_on) continue
    const ent = rowToEntitlement(r)
    const days = REMINDER_DAYS[ent.plan]
    const left = daysBetween(today, ent.expiresOn)
    if (days === undefined || left < 0 || left > days) continue
    const title = PLANS[ent.plan].title
    await withMutation(async (tx) => {
      const fresh = await tx.prepare('SELECT reminded_for, expires_on, status FROM entitlements WHERE id = ? FOR UPDATE').get(ent.id)
      if (!fresh || fresh.status !== 'active' || fresh.reminded_for === fresh.expires_on) return
      const ts = now()
      await tx.prepare('INSERT INTO tasks (title, contact_id, due_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(`Продлить тариф «${title}» (до ${ru(ent.expiresOn)}) — связаться с клиентом`, ent.contactId, today, ts, ts)
      await tx.prepare('UPDATE entitlements SET reminded_for = expires_on WHERE id = ?').run(ent.id)
      const base = String(baseUrl || '').trim().replace(/\/+$/, '')
      await enqueue(tx, 'text', {
        text: [
          '⏰ <b>Истекает тариф клиента</b>',
          `Тариф: ${title}, до ${ru(ent.expiresOn)}`,
          base ? `Открыть: ${base}/crm/contacts/${ent.contactId}` : 'Детали — в CRM, раздел «Задачи»',
        ].join('\n'),
      })
      created++
    })
  }
  return created
}

export function scheduleEntitlementReminders(db, opts) {
  const log = opts.log || console
  const tick = async () => {
    try { await runEntitlementReminders(db, { ...opts, today: opts.mskToday() }) } catch (err) { log.error?.(`entitlement reminders: ${err}`) }
  }
  const timer = setInterval(tick, opts.intervalMs ?? 60 * 60_000)
  timer.unref?.()
  if (opts.autoStart !== false) tick()
  return { tick, stop: () => clearInterval(timer) }
}
