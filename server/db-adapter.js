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
    // COMMIT над транзакцией, уже переведённой в состояние отказа упавшим
    // оператором, НЕ бросает ошибку — Postgres молча выполняет откат и сообщает об
    // этом в поле `command`. Без этой проверки такой случай выглядел бы как успех:
    // вызывающий получил бы результат, а изменений в базе не было. Ловим явно —
    // это страховка от любого будущего кода, который проглотит ошибку внутри
    // транзакции (см. `audit` в server/app.js, где это уже однажды случилось).
    const done = await client.query('COMMIT')
    if (done?.command === 'ROLLBACK') throw new Error('транзакция была отменена базой: COMMIT выполнился как ROLLBACK')
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
 * Согласованное ЧТЕНИЕ нескольких таблиц: одно закреплённое соединение и один
 * снимок базы на все запросы внутри (REPEATABLE READ), плюс READ ONLY — чтобы
 * случайная запись здесь была ошибкой базы, а не тихо прошла.
 *
 * Зачем отдельно от withTransaction: `createDb(pool)` берёт НОВОЕ соединение на
 * КАЖДЫЙ вызов `.prepare().all()`, а каждое такое соединение в режиме
 * autocommit видит СВОЙ снимок. Для одиночного запроса это безразлично, но для
 * серии связанных таблиц — нет: заявка, закоммитившаяся между чтением
 * `contacts` и чтением `deals`, кладёт в результат сделку, чьего контакта в нём
 * уже не будет. У `deals.contact_id` внешний ключ NOT NULL (schema.sql), так что
 * такой дамп не импортируется вовсе — падает на FK. В SQLite этого класса
 * проблем не было: одно соединение, один процесс, запись физически не могла
 * вклиниться между двумя SELECT-ами.
 *
 * READ ONLY здесь ещё и защищает от будущей правки: если кто-то добавит в
 * колбэк запись, база откажет явно, а не создаст молчаливый побочный эффект в
 * функции, которая по названию только читает.
 */
export async function withReadSnapshot(pool, fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const result = await fn(wrapQueryable(client))
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Та же причина, что в withTransaction: исходная ошибка важнее вторичной.
    }
    throw err
  } finally {
    client.release()
  }
}

/**
 * «Этого движок не умеет» против «настоящая ошибка базы». Раньше три функции ниже
 * решали это подстрокой в тексте ошибки, и все три были неправы одинаково опасно
 * (найдено независимым ревью): настоящий Postgres выдаёт `syntax error` при кривом
 * `LOCK TABLE`, а `permission denied for function pg_advisory_xact_lock` содержит имя
 * функции — то есть боевой отказ проглатывался как «мы под эмулятором», и защита
 * молча отключалась в проде, ничего не сообщая.
 *
 * Надёжный признак: **SQLSTATE**. Настоящий Postgres проставляет `err.code` всегда
 * (42883 нет функции, 42601 синтаксис, 42501 нет прав, 23505 дубль). `pg-mem` на
 * нереализованной возможности бросает свою `QueryError` вообще без кода — проверено
 * замером; при этом ошибки, которые он МОДЕЛИРУЕТ (нарушение PRIMARY KEY), код имеют.
 * Поэтому глотаем, только если кода нет И текст называет ровно то, чего не хватает.
 *
 * Молчать при этом нельзя: пропуск защиты обязан оставлять след, иначе он неотличим
 * от работающей защиты. Предупреждаем один раз на возможность, чтобы не залить лог.
 */
const warnedGaps = new Set()
function isEngineGap(err, feature, marker = feature) {
  if (err?.code) return false // у настоящего Postgres код есть всегда — это боевой отказ
  if (!String(err?.message ?? '').includes(marker)) return false
  if (!warnedGaps.has(feature)) {
    warnedGaps.add(feature)
    console.warn(`${feature}: пропущено — возможность недоступна в этом движке (ожидаемо для pg-mem, НЕ для настоящего Postgres)`)
  }
  return true
}

/**
 * Ключ единственного барьера обслуживания. Произвольное, но ПОСТОЯННОЕ число:
 * advisory-блокировки в Postgres различаются только им, поэтому менять его нельзя —
 * иначе старые и новые процессы перестанут видеть блокировки друг друга.
 */
const MAINTENANCE_LOCK_KEY = 4127001


/**
 * Барьер «восстановление против обычной работы». Берётся ПЕРВЫМ в транзакции, ДО
 * любого чтения, на котором потом основано решение.
 *
 *  - `exclusive` (импорт дампа) — ждёт, пока закончатся все текущие мутации, и не
 *    пускает новые до конца восстановления;
 *  - обычная мутация берёт РАЗДЕЛЯЕМЫЙ барьер — такие друг с другом не конфликтуют,
 *    то есть штатная работа идёт с прежней параллельностью.
 *
 * Зачем, если импорт и так берёт LOCK TABLE: EXCLUSIVE на таблицу намеренно ПУСКАЕТ
 * обычные SELECT. Значит обработчик успевал прочитать данные ДО восстановления,
 * подождать на своей записи и продолжить уже по ВОССТАНОВЛЕННЫМ строкам с теми же
 * id — то есть удалить или обезличить чужие данные (независимая проверка, четвёртый
 * раунд: удаление контакта и прямое обезличивание читают именно так). Табличные
 * блокировки этого класса проблем не решают в принципе — нужен барьер, который
 * стоит РАНЬШЕ чтения, а не только раньше записи.
 *
 * Второе, что он чинит, — взаимную блокировку. Раздел ПДн брал `pd_requests`, затем
 * `contacts`, а импорт — наоборот, и встречное ожидание давало `40P01`. Обработчик
 * импорта переводит любую ошибку в «битый файл», так что владелец увидел бы
 * «дамп повреждён» на совершенно целом бэкапе. Один барьер, всегда первый, цикл
 * замыкать нечему.
 */
export async function maintenanceBarrier(queryable, exclusive = false) {
  const fn = exclusive ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared'
  try {
    // Ожидание ограничено по времени — но потолок задаётся НЕ здесь, а на всём пуле
    // (LOCK_WAIT_MS в server/db.js). Точечный SET LOCAL защищал только тех, кто до
    // барьера дошёл: захват ключа идемпотентности и воркер очереди работают на голом
    // соединении, мимо транзакции, и на восстановлении вставали бы шагом раньше,
    // выпивая пул — тот же DoS, от которого потолок и заведён (найдено red team).
    //
    // Восстановлению потолок, наоборот, СНИМАЕМ: оно обязано дождаться своей
    // очереди, а не отступить, — иначе аварийное восстановление проигрывало бы
    // гонку обычным заявкам.
    if (exclusive) await queryable.query('SET LOCAL lock_timeout = 0')
    await queryable.query(`SELECT ${fn}($1)`, [MAINTENANCE_LOCK_KEY])
  } catch (err) {
    // Не дождались барьера: идёт восстановление. Это не поломка и не «битый запрос» —
    // отдельная ошибка, чтобы вызывающий ответил «повторите», а не 500.
    if (err?.code === '55P03' || err?.code === '57014') {
      const busy = new Error('идёт восстановление базы, повторите запрос')
      busy.maintenanceBusy = true
      throw busy
    }
    // pg-mem (движок тестов) advisory-блокировок не реализует вовсе — отличаем
    // это от боевого отказа по отсутствию SQLSTATE, см. isEngineGap выше.
    if (isEngineGap(err, fn)) return
    throw err
  }
}

/**
 * Берёт EXCLUSIVE-блокировку на перечисленные таблицы внутри уже открытой
 * транзакции — держится до COMMIT/ROLLBACK самой базой, снимать вручную не нужно.
 *
 * Зачем: восстановление дампа чистит таблицы, вставляет строки с явными id и
 * чинит последовательности. Само по себе всё это не мешает параллельной записи —
 * DELETE/INSERT берут лишь ROW EXCLUSIVE, который с другим ROW EXCLUSIVE не
 * конфликтует. Значит между чтением `MAX(id)`/`last_value` и вызовом `setval`
 * успевает вклиниться органическая вставка и занять следующий id, а `setval`
 * потом откатывает счётчик назад — и эта вставка сталкивается с восстановленной
 * строкой по PRIMARY KEY (независимая проверка, второй раунд; в документации
 * Postgres прямо сказано, что наблюдаемый `last_value` может устареть немедленно).
 * Монотонный GREATEST один этого не лечит: он сравнивает значения, прочитанные
 * ДО вставки конкурента.
 *
 * EXCLUSIVE, а не ACCESS EXCLUSIVE: конфликтует с любой записью, но обычные
 * SELECT'ы продолжают работать — дашборд у того, кто в этот момент открыл CRM,
 * не повиснет, а его попытка что-то сохранить подождёт конца восстановления.
 * Это ровно то поведение, которое нужно: импорт дампа — аварийная процедура,
 * во время которой писать в базу и не должны.
 *
 * Порядок таблиц обязан быть одинаковым у всех, кто их так блокирует — иначе
 * два параллельных восстановления встанут во взаимную блокировку.
 */
export async function lockTablesForRestore(queryable, tables) {
  try {
    // Одной командой, а не по таблице за раз: меньше round-trip'ов, и Postgres
    // берёт блокировки в перечисленном порядке — то самое, что нужно против
    // взаимных блокировок.
    await queryable.query(`LOCK TABLE ${tables.join(', ')} IN EXCLUSIVE MODE`)
  } catch (err) {
    if (isEngineGap(err, 'LOCK TABLE', 'failed to parse')) return
    throw err
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
    // ТОЛЬКО ВВЕРХ, никогда вниз (GREATEST с текущим last_value). Причина —
    // setval в Postgres НЕтранзакционен: его не откатывает ни ROLLBACK, ни
    // сбой следующего шага. Прежняя версия ставила счётчик равным MAX(id) по
    // таблице, а MAX считается уже по вычищенным и заполненным дампом данным —
    // то есть при импорте бэкапа со СТАРЫМИ (меньшими) id счётчик понижался. Если
    // импорт затем падал, строки откатывались, а пониженный счётчик оставался:
    // следующее органическое создание записи получало id, который в живой базе
    // уже занят, и падало на PRIMARY KEY — раз за разом, пока последовательность
    // не догонит. Для владельца это выглядит как «CRM сломалась» без объяснений,
    // и происходит ровно в момент аварийного восстановления.
    //
    // Повышение безопасно всегда: лишний разрыв в нумерации ничего не значит,
    // столкновение id — значит. Поэтому здесь берётся максимум из фактического
    // MAX(id) и уже достигнутого last_value последовательности.
    await queryable.query(
      `SELECT setval(
         pg_get_serial_sequence('${table}', 'id'),
         GREATEST(
           COALESCE((SELECT MAX(id) FROM ${table}), 1),
           COALESCE((SELECT last_value FROM pg_sequences
                     WHERE format('%I.%I', schemaname, sequencename)::regclass
                         = pg_get_serial_sequence('${table}', 'id')::regclass), 1)
         )
       )`
    )
  } catch (err) {
    // pg-mem не реализует pg_get_serial_sequence()/именованные sequence-объекты
    // ВООБЩЕ (см. комментарий выше — подтверждено смоук-тестом, и для IDENTITY,
    // и для классического SERIAL одинаково) — ограничение тестового движка,
    // отличаемое от боевого отказа по отсутствию SQLSTATE (см. isEngineGap).
    if (isEngineGap(err, 'pg_get_serial_sequence')) return
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
