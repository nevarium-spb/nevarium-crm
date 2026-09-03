// Тонкий асинхронный слой поверх `pg`, имитирующий интерфейс better-sqlite3
// (`.prepare(sql).get()/.all()/.run()`), который использует весь остальной код —
// чтобы перевод на Postgres не требовал переписывать текст самих SQL-запросов,
// только добавить `await` в местах вызова (docs/CRM_POSTGRES_MIGRATION_SPEC.md
// в nevarium-lab#3, план перевода — «Технические решения», п.2).
//
// Что НЕ переносится прозрачно и требует правки текста самого запроса на
// вызывающей стороне (не в этом файле):
//  - `.lastInsertRowid` — работает только если сам текст INSERT добавляет
//    `RETURNING id`. Без него `run()` просто вернёт `lastInsertRowid: undefined`
//    (в pg инструкции без RETURNING не отдают строк) — это НЕ баг адаптера,
//    а сигнал, что конкретный вызов забыли снабдить RETURNING id.
//  - `db.transaction(() => {...})()` (синхронный, better-sqlite3) — заменяется
//    на `await withTransaction(pool, async (tx) => {...})` ниже: код ВНУТРИ
//    колбэка обязан обращаться к `tx`, не к внешнему `db` — иначе будет молча
//    выполняться на ДРУГОМ соединении, вне транзакции.

/** Переводит позиционные `?` SQLite в `$1, $2, ...` Postgres. Тексты запросов
 * захардкожены в коде (не пользовательский ввод) — простая замена безопасна. */
function translatePlaceholders(sql) {
  let i = 0
  return sql.replace(/\?/g, () => `$${++i}`)
}

/**
 * Часть текста запросов в app.js написана в именованном стиле better-sqlite3
 * (`@col`), не позиционном — generic PATCH (`SET col = @col`) и построчный
 * INSERT при восстановлении дампа (`VALUES (@id, @col1, ...)`), оба со списком
 * колонок, известным только в момент вызова, не при `prepare()`. У `pg` именованных
 * параметров нет вообще, только `$1, $2, ...`. Чтобы не переписывать сам текст
 * запроса в app.js (он и так уже параметризован и не пользовательский ввод —
 * простая замена безопасна, см. translatePlaceholders выше), приводим `@name`
 * ЗДЕСЬ: собираем список различимых имён в порядке первого появления, каждое
 * повторное упоминание того же `@name` получает тот же номер `$N` (как и должно
 * быть — одно значение подставляется в оба места).
 */
function translateNamedPlaceholders(sql) {
  const names = []
  const indexOf = new Map()
  const text = sql.replace(/@(\w+)/g, (_, name) => {
    let idx = indexOf.get(name)
    if (idx === undefined) {
      idx = names.length + 1
      indexOf.set(name, idx)
      names.push(name)
    }
    return `$${idx}`
  })
  return { text, names }
}

const isNamedParamsSql = (sql) => /@\w+/.test(sql)

/**
 * Оборачивает что угодно с методом `.query(text, params)` — так `pg.Pool` и
 * `pg.PoolClient` (внутри транзакции) получают ОДИН и тот же интерфейс
 * `.prepare()`, и withTransaction ниже может отдать колбэку db-подобный
 * объект, привязанный именно к захваченному клиенту, а не к пулу.
 */
function wrapQueryable(queryable) {
  return {
    prepare(sql) {
      // Именованный стиль (@col) — параметры подаются ОДНИМ объектом на вызов
      // (`.run({...data, id})`), не позиционным списком. Определяем режим по
      // тексту запроса один раз, при prepare(), а не по форме аргументов при
      // каждом вызове — сам текст запроса решает, каким стилем его вызывать.
      if (isNamedParamsSql(sql)) {
        const { text, names } = translateNamedPlaceholders(sql)
        const toParams = (paramsObj) => names.map((n) => paramsObj[n])
        return {
          async get(paramsObj) {
            const res = await queryable.query(text, toParams(paramsObj))
            return res.rows[0]
          },
          async all(paramsObj) {
            const res = await queryable.query(text, toParams(paramsObj))
            return res.rows
          },
          async run(paramsObj) {
            const res = await queryable.query(text, toParams(paramsObj))
            return { changes: res.rowCount, lastInsertRowid: res.rows[0]?.id }
          },
        }
      }
      const text = translatePlaceholders(sql)
      return {
        async get(...params) {
          const res = await queryable.query(text, params)
          return res.rows[0]
        },
        async all(...params) {
          const res = await queryable.query(text, params)
          return res.rows
        },
        async run(...params) {
          const res = await queryable.query(text, params)
          return { changes: res.rowCount, lastInsertRowid: res.rows[0]?.id }
        },
      }
    },
    // Прямой доступ к query() нужен изредка — например, применить schema.sql
    // (несколько CREATE TABLE в одном тексте) или выполнить BEGIN/COMMIT самому.
    query: (text, params) => queryable.query(text, params),
  }
}

/** db-подобный объект поверх пула — обычные (вне транзакции) запросы. Каждый
 * вызов сам берёт соединение из пула и возвращает его — как и должно быть для
 * пула соединений; для атомарных цепочек операций нужен withTransaction ниже. */
export function createDb(pool) {
  return wrapQueryable(pool)
}

/**
 * Замена синхронного `db.transaction(fn)()`. Держит ОДНО соединение на всю
 * транзакцию (BEGIN → fn(tx) → COMMIT, ROLLBACK при исключении, клиент
 * возвращается в пул в finally) — колбэк получает `tx`, с ним и нужно работать
 * внутри, не с внешним db (см. преамбулу файла).
 */
export async function withTransaction(pool, fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const tx = wrapQueryable(client)
    const result = await fn(tx)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Соединение могло уже развалиться (например, сетевая ошибка) — ROLLBACK
      // на мёртвом соединении сам бросит, но исходная ошибка важнее вторичной.
    }
    throw err
  } finally {
    client.release()
  }
}

/**
 * Продвигает identity-последовательность таблицы до максимального фактического
 * id — обязательна ПОСЛЕ любой вставки с явным id (см. server/schema.sql,
 * преамбула про GENERATED BY DEFAULT AS IDENTITY). Явная вставка id не двигает
 * последовательность сама (реальное поведение Postgres, не баг эмулятора):
 * без этого вызова следующий органический INSERT рано или поздно получит
 * auto-id, уже занятый восстановленной строкой, и упадёт на PRIMARY KEY
 * constraint. Вызывать после сида projects (server/db.js) и после каждой
 * таблицы, вставленной с явными id при POST /api/crm/import (server/app.js).
 * `table` — только из захардкоженного в коде набора имён, не пользовательский
 * ввод (интерполяция в identifier здесь безопасна по той же причине, что и
 * везде в этом кодовой базе с именами таблиц).
 *
 * НЕ ПРОВЕРЯЕМО через pg-mem (смоук-тест адаптера, tmp-smoke-adapter.mjs):
 * ни `pg_get_serial_sequence()`, ни прямой `setval('<table>_id_seq', ...)` по
 * предсказуемому имени НЕ работают в pg-mem вообще — «function ... does not
 * exist» / «relation ... does not exist» в обоих случаях, для IDENTITY и для
 * классического SERIAL одинаково. Это ограничение эмулятора, не повод писать
 * неидиоматичный SQL: `pg_get_serial_sequence` + `setval` — стандартный,
 * документированный способ Postgres чинить последовательность после массовой
 * вставки с явными id, и он корректно работает в настоящем Postgres. Пункт
 * добавлен в обязательный список проверки на реальной Timeweb-базе (Этап 4
 * плана переезда) — конкретно: сделать импорт дампа, затем создать новый
 * контакт руками, убедиться, что оба сосуществуют без ошибки PRIMARY KEY.
 */
export async function resyncIdentitySequence(queryable, table) {
  try {
    await queryable.query(
      `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1))`
    )
  } catch (err) {
    // pg-mem не реализует pg_get_serial_sequence()/именованные sequence-объекты
    // ВООБЩЕ (см. комментарий выше — подтверждено смоук-тестом, и для IDENTITY,
    // и для классического SERIAL одинаково) — это ограничение тестового
    // движка, не ошибка выполнения. В настоящем Postgres эта функция есть
    // всегда, поэтому сюда попадаем ТОЛЬКО под pg-mem. Проглатываем молча
    // именно по этой конкретной причине (сверяем текст ошибки — не любую
    // ошибку) и предупреждаем в консоль, чтобы не потерялось, если pg-mem
    // когда-нибудь начнёт кидать другую ошибку при том же вызове.
    if (String(err.message).includes('pg_get_serial_sequence')) {
      console.warn(`resyncIdentitySequence(${table}): пропущено — pg_get_serial_sequence недоступна (ожидаемо для pg-mem, не для настоящего Postgres)`)
      return
    }
    throw err
  }
}

/**
 * Claim-first идемпотентность (см. server/schema.sql, комментарий у
 * idempotency_keys, и план перевода). В SQLite проверка «ключ уже есть?» и
 * запись бизнес-данных были атомарны бесплатно — синхронный однопоточный код,
 * ни одного await между ними. С async pg это перестаёт быть верно: окно между
 * «ключа ещё нет» и «ключ записан» открыто, и два параллельных запроса с одним
 * Idempotency-Key оба проходят проверку раньше, чем любой из них закоммитит
 * ключ. Решение — застолбить ключ ДО бизнес-логики: атомарность здесь даёт
 * сама СУБД (UNIQUE-индекс), а не порядок выполнения JS.
 *
 * Простой INSERT + catch unique_violation (23505) — НЕ `ON CONFLICT DO NOTHING
 * RETURNING`. Смоук-тестом (tmp-smoke-adapter.mjs) поймано: pg-mem у этого
 * запроса на конфликтующей вставке возвращает СУЩЕСТВУЮЩУЮ строку в RETURNING
 * вместо пустого набора строк (как настоящий Postgres) — тихо ломает саму
 * функцию, которую этот код должен исправлять. try/catch на 23505 — тот же
 * приём, что был проверен много раундов ревью в SQLite-версии (там ловился
 * SQLITE_CONSTRAINT_UNIQUE), просто другой код ошибки — работает одинаково
 * в pg-mem и в настоящем Postgres.
 *
 * Возвращает id захваченной строки при успехе или null, если ключ уже занят —
 * вызывающий код (idempotencyClaim в server/app.js) в этом случае сам смотрит
 * текущий status_code и либо отдаёт закешированный терминальный ответ, либо
 * (status_code ещё NULL — конкурентная обработка) коротко повторяет
 * попытку/отвечает так, чтобы сайт повторил (контракт сайта уже это умеет).
 */
export async function tryClaimIdempotencyKey(queryable, scope, requestId, createdAt) {
  if (!requestId) return null
  try {
    const res = await queryable.query(
      'INSERT INTO idempotency_keys (scope, request_id, status_code, created_at) VALUES ($1, $2, NULL, $3) RETURNING id',
      [scope, requestId, createdAt]
    )
    return res.rows[0]?.id ?? null
  } catch (err) {
    if (err.code === '23505') return null
    throw err
  }
}
