import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { createDb, resyncIdentitySequence, withTransaction } from './db-adapter.js'

export { STAGES, TERMINAL_STAGES } from '../src/shared/stages.js'

// node-postgres по умолчанию возвращает BIGINT (oid 20) — то, что отдают COUNT(*)
// и SUM() над INTEGER-колонками, а их в этом коде десятки, весь дашборд и не
// только — JS-строкой, не числом: боится потери точности за пределами
// Number.MAX_SAFE_INTEGER. У малого бизнеса ни счётчик строк, ни сумма сделок в
// рублях никогда не подойдут к этой границе — установим глобальный парсер здесь,
// в ОДНОМ месте, вместо `::int`/`::bigint` на каждом отдельном count/sum по всему
// app.js (счёт на десятки мест, дашборд особенно). НЕ баг pg-mem (используется в
// тестах) — тот возвращает числа нативно, эмулируя JS, а не wire-протокол
// настоящего Postgres; без этой правки тесты были бы зелёными, а прод — молча
// сравнивал бы строки с числами (например, funnel/counts на дашборде во фронте).
pg.types.setTypeParser(20, (v) => parseInt(v, 10))

const SCHEMA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql')

/**
 * Проекты — единственные строки со вставленным вручную id (1/2), на которые
 * держится весь остальной код (DEFAULT_PROJECT_ID и вообще любое место, где
 * project_id захардкожен). Раньше это была одна INSERT-строка внутри миграции
 * v3 (server/db.js, SQLite) — теперь отдельный сид-шаг в openDb(), потому что
 * схема (schema.sql) — чистый DDL без данных (план перевода на Postgres,
 * ТЗ nevarium-lab#3: «одна чистая схема», не перенос миграций по шагам).
 */
const SEED_PROJECTS = [
  { id: 1, slug: 'nevarium1', displayName: 'Невариум Лаб ИИ', origins: 'https://nevarium-lab.ru,https://www.nevarium-lab.ru,https://nevarium1.vercel.app' },
  { id: 2, slug: 'nevarium-vizor', displayName: 'Невариум Визор', origins: 'https://nevarium-vizor.ru,https://www.nevarium-vizor.ru' },
]

/**
 * Открывает (и при необходимости готовит с нуля) базу — асинхронно, в отличие
 * от прежней синхронной SQLite-версии: pg — сетевой протокол, любое обращение
 * к базе теперь await'ится (план перевода на Postgres, ТЗ nevarium-lab#3).
 *
 * `dbConfig` — ЛИБО строка подключения (`DATABASE_URL`, продакшен: создаётся
 * настоящий `pg.Pool`), ЛИБО уже готовый Pool-совместимый объект (тесты —
 * pg-mem, `db.adapters.createPg()` — используется КАК ЕСТЬ, не оборачивается).
 * Не строка и не null/undefined — значит это пул; так и определяем, что делать.
 */
export async function openDb(dbConfig) {
  const pool =
    dbConfig && typeof dbConfig !== 'string'
      ? dbConfig
      : new pg.Pool({ connectionString: dbConfig || process.env.DATABASE_URL })

  // schema.sql — целиком IF NOT EXISTS, безопасно применять на каждом старте
  // (см. преамбулу schema.sql) — миграционной истории/PRAGMA user_version
  // больше нет, версионировать нечего: схема одна, актуальная.
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8')
  await pool.query(schema)

  const db = createDb(pool)
  // Раскрыт для withTransaction(db.pool, fn) в app.js — обёртке нужен «сырой»
  // Pool (с .connect()), которого нет у db-подобного объекта createDb() отдаёт
  // только .prepare()/.query(). Не переиспользуем сам db как транзакционный
  // объект: internally он всегда идёт через пул (новое соединение на вызов),
  // withTransaction обязан держать ОДНО соединение на всю транзакцию.
  db.pool = pool

  // Сид проектов — только если их ещё нет (та же идемпотентность, что и у
  // схемы). resyncIdentitySequence ОБЯЗАТЕЛЕН после явной вставки id (см.
  // schema.sql, преамбула, и db-adapter.js — иначе первый же органический
  // INSERT в projects мог бы столкнуться с id 1 или 2).
  //
  // ВСЯ вставка — ОДНОЙ транзакцией, и это не перестраховка. Условие входа —
  // «проектов ноль»; если процесс упадёт (или оборвётся сеть до Postgres) между
  // вставкой первого и второго проекта, то при следующем старте их будет уже НЕ
  // ноль, сид не выполнится никогда, и «Невариум Визор» пропадёт навсегда — с ним
  // заявки Визора будут молча уезжать в проект по умолчанию. В SQLite-версии
  // сид был одним INSERT-ом с двумя строками внутри транзакции миграции, то есть
  // атомарным даром; при переводе на pg эта атомарность потерялась и её нужно
  // вернуть явно.
  const existing = await db.prepare('SELECT COUNT(*) c FROM projects').get()
  if (Number(existing.c) === 0) {
    const ts = now()
    await withTransaction(pool, async (tx) => {
      for (const p of SEED_PROJECTS) {
        await tx
          .prepare('INSERT INTO projects (id, slug, display_name, origins, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(p.id, p.slug, p.displayName, p.origins, ts)
      }
    })
    await resyncIdentitySequence(pool, 'projects')
  }

  return db
}

export function now() {
  return new Date().toISOString()
}

/**
 * Виды запросов субъекта ПДн — ровно то, что перечислено в п.7 политики на сайтах.
 * Ключи хранятся в pd_requests.kind, подписи показываются в интерфейсе.
 */
export const PD_REQUEST_KINDS = {
  access: 'узнать, какие данные есть',
  correct: 'исправить неточные данные',
  delete: 'отозвать согласие и удалить данные',
  stop: 'прекратить обработку',
}

/** Срок исполнения по 152-ФЗ и по обещанию в политике — 10 рабочих дней. */
export const PD_DEADLINE_WORKDAYS = 10

/**
 * Дедлайн = N рабочих дней от даты (только пн–пт).
 * Государственные праздники сознательно не учитываем: их даты каждый год переносятся
 * постановлением, и держать этот календарь в коде — источник тихих ошибок. Без них
 * дедлайн получается раньше законного, то есть в запас, а не в просрочку.
 */
export function addWorkdays(fromIsoDate, days = PD_DEADLINE_WORKDAYS) {
  const d = new Date(`${fromIsoDate}T00:00:00Z`)
  let left = days
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1)
    const weekday = d.getUTCDay()
    if (weekday !== 0 && weekday !== 6) left--
  }
  return d.toISOString().slice(0, 10)
}

/**
 * Расписание воронки возврата: через сколько дней после отказа ставим задачу.
 * Два месяца, три касания — чаще превращается в рутину, которую перестают замечать.
 */
export const WINBACK_STEPS = [
  { days: 7, title: 'Написать клиенту: уточнить причину отказа' },
  { days: 30, title: 'Позвонить клиенту: узнать, не изменилась ли ситуация' },
  { days: 60, title: 'Финальное касание: предложить вернуться к задаче' },
]

/** Проект по умолчанию для строк без явной привязки (совпадает с id в SEED_PROJECTS). */
export const DEFAULT_PROJECT_ID = 1

/**
 * Таблицы, попадающие в JSON-дамп. Порядок важен: при импорте вставляем в этом
 * порядке (родители раньше детей), удаляем в обратном.
 *
 * Почему сюда входят pd_requests и audit_log: на App Platform нет shell-доступа,
 * поэтому положить обратно файл базы там нечем (и теперь тем более — база вообще
 * не файл, а управляемый Postgres) — единственный реальный путь восстановления
 * это «Импорт JSON» через браузер. Всё, чего нет в дампе, при потере доступа к
 * базе исчезает навсегда, включая записи об исполнении запросов ПДн и журнал —
 * то есть ровно то, чем это исполнение доказывают (ADR-013).
 *
 * consents стоит СРАЗУ после deals (не в конце): вставка идёт в этом порядке, а
 * consents.deal_id ссылается на уже вставленную строку deals.
 */
export const DUMP_TABLES = ['contacts', 'deals', 'consents', 'tasks', 'interactions', 'pd_requests', 'audit_log']

/** У этих таблиц есть колонка demo — демо-строки в дамп не берём. */
const DEMO_FILTERED = new Set(['contacts', 'deals', 'tasks', 'interactions'])

/**
 * Версия формата дампа. v1 — без pd_requests и audit_log (дампы до 2026-07-30).
 * v3 — pd_requests обзавёлся verified_at. v4 — новая таблица consents. Импорт
 * обязан принимать все — старый бэкап должен восстанавливаться (см. app.js,
 * hasCompliance/hasConsents).
 */
export const DUMP_VERSION = 4

export async function buildDump(db) {
  const data = { version: DUMP_VERSION, exportedAt: now() }
  for (const t of DUMP_TABLES) {
    data[t] = await db.prepare(`SELECT * FROM ${t}${DEMO_FILTERED.has(t) ? ' WHERE demo = 0' : ''}`).all()
  }
  // Пользователи — только для справки «кто был в команде»: импорт их не восстанавливает,
  // иначе чужие хеши паролей могли бы заменить текущего администратора и запереть вход.
  data.team = await db.prepare('SELECT id, name, email, role FROM users').all()
  return data
}
