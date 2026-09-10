// @vitest-environment node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { newDb } from 'pg-mem'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, mskToday } from './app.js'
import { hashPassword, resetThrottle, verifyPassword, volatileSize, reserveVerify, serializeVerify, verifyOrFake, admitLoginRequest, releaseLoginRequest, inFlightLoginCount, MAX_BUCKETS, MAX_QUEUED_PER_KEY, MAX_QUEUED_PER_SOURCE, MAX_INFLIGHT_LOGIN_REQUESTS, THROTTLE_IP_FREE_ATTEMPTS } from './auth.js'
import { bootstrapAdmin } from './bootstrap.js'
import { validSeedInput } from './seed-admin.js'
import { runBackup } from './backup.js'
import { DUMP_VERSION, LOCK_WAIT_MS, addWorkdays, now } from './db.js'
import { lockTablesForRestore } from './db-adapter.js'
import { leadMessage, startOutboxWorker } from './telegram.js'

// Перевод на Postgres (план в nevarium-lab#3): каждый тест — свежий pg-mem-пул
// вместо свежего :memory: SQLite. pg-mem эмулирует протокол pg настолько, что
// server/db-adapter.js (написанный для настоящего pg.Pool) работает поверх него
// без изменений — buildApp({ dbConfig }) принимает готовый Pool-совместимый объект
// точно так же, как строку подключения.
//
// РЕЖИМ НАСТОЯЩЕГО POSTGRES. `TEST_DATABASE_URL` в окружении переключает набор с
// pg-mem на живую базу — этим прогоняется обязательный ручной чек-лист из
// HANDOFF.md, всё то, что эмулятор не умеет в принципе: реальный откат
// транзакции, блокировки строк и таблиц, уровни изоляции, setval и BIGINT.
//
//   TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/db npm test
//
// Изоляция — СВОЯ СХЕМА на каждый тест, а не своя база: создание схемы дёшево, и
// `search_path` в параметрах пула делает её невидимой для остального кода —
// запросы остаются без квалификации, как и написаны. Пул закрывается вручную:
// buildApp() этого не делает (под pg-mem не нужно), а на живой базе две сотни
// незакрытых пулов упрутся в max_connections.
export const REAL_PG = process.env.TEST_DATABASE_URL || ''
/** Прогонять только на живой базе — под pg-mem такой тест недоказуем. */
const itPg = REAL_PG ? it : it.skip
let schemaSeq = 0

async function makePool() {
  if (!REAL_PG) {
    const mem = newDb()
    return new (mem.adapters.createPg()).Pool()
  }
  // Имя обязано быть уникальным МЕЖДУ воркерами, а не только внутри одного: vitest
  // гоняет файлы в worker_threads, где process.pid у всех общий, а schemaSeq —
  // счётчик своего модуля. Без VITEST_WORKER_ID два файла (или будущее разделение
  // этого) сгенерировали бы одинаковое имя, и dropPool одного снёс бы CASCADE живую
  // схему другого прямо посреди теста. CREATE SCHEMA намеренно без IF NOT EXISTS —
  // столкновение должно падать громко, а не тихо переиспользовать чужое.
  const schema = `t${process.pid}_${process.env.VITEST_WORKER_ID ?? 0}_${++schemaSeq}`
  const admin = new pg.Pool({ connectionString: REAL_PG, max: 1 })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  await admin.end()
  // lock_timeout повторяем за openDb: в проде пул создаёт она сама и ставит потолок,
  // а здесь пул делает фикстура — без этой строки тесты на ожидание блокировок
  // висели бы вечно и проверяли не то.
  const pool = new pg.Pool({ connectionString: REAL_PG, options: `-c search_path="${schema}" -c lock_timeout=${LOCK_WAIT_MS}ms`, max: 4 })
  pool.__schema = schema
  return pool
}

async function dropPool(pool) {
  if (!REAL_PG || !pool?.__schema) return
  const schema = pool.__schema
  await pool.end()
  const admin = new pg.Pool({ connectionString: REAL_PG, max: 1 })
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
  await admin.end()
}

let app, cookie, pool

async function login(email = 'a@a.ru', password = 'password123') {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } })
  return res
}

beforeEach(async () => {
  resetThrottle()
  pool = await makePool()
  app = await buildApp({ dbConfig: pool, secure: false })
  await app.db
    .prepare('INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)')
    .run('Админ', 'a@a.ru', await hashPassword('password123'), 'admin', now())
  await app.ready()
  cookie = (await login()).headers['set-cookie']
})

afterEach(async () => {
  // try/finally обязателен: если app.close() падает, без него dropPool не
  // вызывается — схема в базе остаётся навсегда, а пул не закрывается. На живом
  // Postgres один такой сбой каскадом выедает max_connections для всего прогона.
  // Это уже случалось: пришлось вручную вычищать 57 осиротевших схем.
  try {
    await app?.close?.()
  } finally {
    await dropPool(pool)
  }
})

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

  it('после 5 неудач попытки выстраиваются в очередь, но остаются 401 — отказа нет', async () => {
    // Логин не отдаёт 429: отказ до проверки пароля позволял бы любому, кто знает
    // адрес владельца, запереть его в CRM. Вместо отказа — очередь на проверку.
    // Первая попытка сверх порога идёт сразу, следующие ждут своего слота (2 с).
    for (let i = 0; i < 5; i++) await login('a@a.ru', 'wrong-password')
    const t = Date.now()
    for (let i = 0; i < 3; i++) {
      const res = await login('a@a.ru', 'wrong-password')
      expect(res.statusCode).toBe(401)
    }
    // Три попытки сверх порога: первая идёт сразу, следующие ждут слота. Слоты
    // абсолютные, поэтому ожидание перекрывается с bcrypt — суммарно ~4,2 с.
    // Без очереди те же три попытки заняли бы ~750 мс, так что порог с запасом.
    expect(Date.now() - t).toBeGreaterThan(3000)
  }, 60_000)

  it('верный пароль проходит даже после серии неудач — владельца не запереть', async () => {
    // Регрессия, которую просил Codex: пять неверных попыток по реальному адресу,
    // затем верный пароль обязан вернуть 200. Раньше здесь был 429 до проверки.
    for (let i = 0; i < 5; i++) await login('a@a.ru', 'wrong-password')
    const res = await login('a@a.ru', 'password123')
    expect(res.statusCode).toBe(200)
    // успех чистит корзину — следующая неудача снова «первая», без задержки
    const t = Date.now()
    await login('a@a.ru', 'wrong-password')
    expect(Date.now() - t).toBeLessThan(4000)
  }, 60_000)

  it('смена X-Forwarded-For не обходит очередь: ключ по email, не по IP', async () => {
    // Атака из аудита: перебор пароля админа с новым IP на каждый запрос.
    // Очередь ведётся по email → все попытки в одной корзине, спуфинг бесполезен.
    const attempt = (i) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': `10.0.${Math.floor(i / 256)}.${i % 256}` },
        payload: { email: 'a@a.ru', password: `guess${i}` },
      })
    for (let i = 0; i < 5; i++) await attempt(i)
    const t = Date.now()
    for (let i = 5; i < 8; i++) await attempt(i)
    // несмотря на новый IP у каждой попытки, очередь по email их растянула:
    // ~4,2 с против ~750 мс, которые заняли бы три попытки без очереди
    expect(Date.now() - t).toBeGreaterThan(3000)
  }, 60_000)

  it('параллельная пачка ограничена по пропускной способности, а не только по задержке', async () => {
    // Ключевая разница между «поспать N секунд» и очередью. Сон ограничивает
    // латентность каждого запроса по отдельности: сто параллельных попыток отспят
    // одни и те же N секунд ОДНОВРЕМЕННО и затем все проверятся — перебор не
    // замедлится. Резервирование двигает общий счётчик времени синхронно, поэтому
    // попытки выстраиваются в очередь: одна проверка на интервал.
    //
    // Все 40 попыток ВСЕГДА доходят до проверки пароля (отказа по горизонту очереди
    // больше нет — см. «переполненная очередь не запирает владельца» ниже), поэтому
    // нижняя граница по времени объясняется не «частью отсеялось», а тем, что после
    // потолка ожидания (10 с) множество проснувшихся запросов исполняются по одному
    // через serializeVerify — реальная бы параллельность бы такую нижнюю границу
    // не дала. Верхняя граница проверяет, что весь serializeVerify-хвост укладывается
    // в разумное время, а не растягивается на исходные 40 × 2 с = 80 с.
    const t = Date.now()
    const results = await Promise.all(
      Array.from({ length: 40 }, () =>
        app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@a.ru', password: 'wrong' } })
      )
    )
    const elapsed = Date.now() - t
    // Все отвечают одинаково — по коду ответа очередь не видно
    expect(results.every((r) => r.statusCode === 401)).toBe(true)
    expect(elapsed).toBeGreaterThan(8000)
    expect(elapsed).toBeLessThan(30000)
  }, 120_000)

  it('serializeVerify гарантирует concurrency=1: сколько бы вызовов ни пришло разом, исполняются по одному', async () => {
    // Это и есть настоящее доказательство фикса — не по времени (замер по wall-clock
    // на общем CI-раннере flaky сам по себе), а прямым подсчётом одновременных
    // исполнений. Независимая проверка отдельно указала: HTTP-тест «за 30 секунд»
    // маскирует именно этот risk — не доказывает границу параллелизма.
    let inFlight = 0
    let maxInFlight = 0
    const work = () => new Promise((resolve) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      setTimeout(() => { inFlight--; resolve() }, 5)
    })
    await Promise.all(Array.from({ length: 50 }, () => serializeVerify(work)))
    expect(maxInFlight).toBe(1)
  })

  it('verifyOrFake ограничивает очередь ОДНОГО ключа: сверх MAX_QUEUED_PER_KEY — мимо serializeVerify', async () => {
    // Находка Codex (4-й раунд): reserveVerify после своего потолка ожидания даёт
    // множеству параллельных попыток одно и то же время пробуждения — раньше ВСЕ
    // они без исключения шли в serializeVerify, и при флуде в тысячи попыток на
    // известный email владельца очередь растягивалась на ~20 минут. Доказываем не
    // по времени (замер по wall-clock на общем CI-раннере flaky сам по себе, как уже
    // отмечал Codex в прошлом раунде), а прямым подсчётом: сколько вызовов реально
    // дошли до «bcrypt» против того, сколько ушло в дешёвую заглушку. Источники —
    // все РАЗНЫЕ (потолок по источнику ниже потолка по ключу, разными адресами его
    // не задеть), чтобы здесь проверялся именно общий потолок по ключу.
    let realCalls = 0
    let concurrentReal = 0
    let maxConcurrentReal = 0
    const verifier = () => new Promise((resolve) => {
      realCalls++
      concurrentReal++
      maxConcurrentReal = Math.max(maxConcurrentReal, concurrentReal)
      setTimeout(() => { concurrentReal--; resolve(true) }, 20)
    })
    const key = 'email:probe@test.ru'
    // Все N вызовов стартуют синхронно (Array.from не уступает управление), поэтому
    // ровно первые MAX_QUEUED_PER_KEY успевают увеличить счётчик занятых слотов до
    // того, как хоть один из них разрешится — детерминировано, без гонки.
    await Promise.all(Array.from({ length: 200 }, (_, i) => verifyOrFake(key, `src-${i}`, verifier)))
    expect(realCalls).toBe(MAX_QUEUED_PER_KEY)
    expect(maxConcurrentReal).toBe(1) // serializeVerify внутри всё ещё concurrency=1
  })

  it('verifyOrFake ограничивает очередь ОДНОГО источника: MAX_QUEUED_PER_SOURCE даже при свободных слотах ключа', async () => {
    // Без этого потолка первая версия admission была гонкой за свободный слот,
    // которую атакующий с одного адреса выигрывал числом попыток (следующий тест —
    // прямое доказательство именно этого сценария).
    let realCalls = 0
    const verifier = () => new Promise((resolve) => setTimeout(() => resolve(true), 20))
    const key = 'email:probe-source@test.ru'
    const source = '10.0.0.1'
    await Promise.all(Array.from({ length: 50 }, () => verifyOrFake(key, source, () => { realCalls++; return verifier() })))
    expect(realCalls).toBe(MAX_QUEUED_PER_SOURCE)
  })

  it('verifyOrFake: непрерывный флуд с ОДНОГО источника не блокирует попытку с ДРУГОГО — находка Codex (5-й раунд)', async () => {
    // До источникового потолка свободный слот на ключ доставался тому, кто первым
    // до него дозвонился — при НЕПРЕРЫВНОМ пополнении с одного источника атакующий
    // выигрывал эту гонку почти всегда просто объёмом попыток, и настоящий пароль
    // владельца мог не проверяться вообще, сколько бы времени ни прошло (Codex прямо
    // указал: тест раунда 4 с конечным флудом и ретраями это не ловил). Здесь
    // атакующий не останавливается, пока владелец не получит ответ — и владелец
    // обязан получить его от РЕАЛЬНОГО verifier, а не от fakeVerifyDelay.
    const key = 'email:sustained@test.ru'
    const attackerSource = '203.0.113.9'
    const ownerSource = '198.51.100.7'
    let attackerRunning = true
    const inFlight = []
    const pump = (async () => {
      while (attackerRunning) {
        inFlight.push(verifyOrFake(key, attackerSource, () => new Promise((r) => setTimeout(() => r(false), 5))))
        await new Promise((r) => setTimeout(r, 1))
      }
    })()
    await new Promise((r) => setTimeout(r, 30)) // дать атакующему занять свой слот
    let ownerSawReal = false
    const ownerResult = await verifyOrFake(key, ownerSource, () => { ownerSawReal = true; return Promise.resolve(true) })
    attackerRunning = false
    await pump
    await Promise.all(inFlight)
    expect(ownerSawReal).toBe(true)
    expect(ownerResult).toBe(true)
  })

  it('admitLoginRequest ограничивает число одновременных /api/auth/login запросов', () => {
    // Находка Codex (6-й раунд): фаза reserveVerify+sleep не была ограничена по
    // числу ОДНОВРЕМЕННЫХ ожидающих запросов — потолок на bcrypt-очередь (verifyOrFake)
    // не спасал от истощения соединений/памяти раньше него. Здесь — счётчик, не
    // wall-clock: детерминировано.
    expect(inFlightLoginCount()).toBe(0)
    for (let i = 0; i < MAX_INFLIGHT_LOGIN_REQUESTS; i++) expect(admitLoginRequest()).toBe(true)
    expect(admitLoginRequest()).toBe(false) // потолок исчерпан
    releaseLoginRequest()
    expect(admitLoginRequest()).toBe(true) // освободившийся слот снова доступен
    // Счётчик модульный, resetThrottle() его не трогает (это не троттлинг по ключу,
    // а общий потолок на запрос) — подчищаем сами, чтобы не утекло в другие тесты.
    for (let i = 0; i < MAX_INFLIGHT_LOGIN_REQUESTS; i++) releaseLoginRequest()
    expect(inFlightLoginCount()).toBe(0)
  })

  it('/api/auth/login отвечает 503 при исчерпанном глобальном потолке запросов, а не зависает', async () => {
    for (let i = 0; i < MAX_INFLIGHT_LOGIN_REQUESTS; i++) admitLoginRequest()
    try {
      const res = await login('a@a.ru', 'password123')
      expect(res.statusCode).toBe(503)
      expect(JSON.parse(res.body).error).toBe('overloaded')
    } finally {
      for (let i = 0; i < MAX_INFLIGHT_LOGIN_REQUESTS; i++) releaseLoginRequest()
    }
    const ok = await login('a@a.ru', 'password123')
    expect(ok.statusCode).toBe(200)
  })

  it('время ответа не выдаёт, существует ли аккаунт, даже после порога', async () => {
    // Оракул, который Codex нашёл в прошлой версии: если очередь заводить только для
    // существующих адресов, то после 5 попыток реальный email начинает отвечать
    // медленно, а выдуманный — быстро. Очередь ведётся для любого адреса.
    const probe = async (email) => {
      for (let i = 0; i < 5; i++) await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'x' } })
      const t = Date.now()
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'x' } })
      return Date.now() - t
    }
    const existing = await probe('a@a.ru')
    const ghost = await probe('ghost@nowhere.ru')
    // Обе шестые попытки попадают в очередь одинаково: разница не должна быть
    // такой, чтобы по ней классифицировать аккаунты.
    expect(Math.abs(existing - ghost)).toBeLessThan(1500)
  }, 120_000)

  it('спрей не сбрасывает лимит атакуемого аккаунта: корзины аккаунтов не вытесняются', () => {
    // Находка Codex: вытеснение само становилось примитивом сброса. Атакующий
    // заливал MAX_BUCKETS мусорных адресов, выбивал корзину владельца и получал
    // новые бесплатные попытки. Корзины существующих аккаунтов теперь в отдельном
    // невытесняемом хранилище.
    resetThrottle()
    const target = 'email:a@a.ru'
    // изматываем лимит атакуемого аккаунта
    for (let i = 0; i < 8; i++) reserveVerify(target, { durable: true })
    const waitBefore = reserveVerify(target, { durable: true })
    expect(waitBefore).toBeGreaterThan(0)

    // спрей сверх потолка — он не должен ничего сбросить
    for (let i = 0; i < MAX_BUCKETS * 2; i++) reserveVerify(`email:spray-${i}@nowhere.ru`)

    const waitAfter = reserveVerify(target, { durable: true })
    expect(waitAfter).toBeGreaterThan(0)
    expect(volatileSize()).toBeLessThanOrEqual(MAX_BUCKETS)
  })

  it('переполненная очередь не запирает владельца: верный пароль проверяется всегда', async () => {
    // Находка Codex: отказ по горизонту очереди возвращал 401 без проверки пароля,
    // то есть атакующий, держа очередь полной, не давал владельцу войти вообще.
    // Теперь ожидание ограничено потолком, но проверка выполняется всегда.
    await Promise.all(
      Array.from({ length: 30 }, () =>
        app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@a.ru', password: 'wrong' } })
      )
    )
    const res = await login('a@a.ru', 'password123')
    expect(res.statusCode).toBe(200)
  }, 120_000)

  it('состояние троттлинга ограничено сверху: спрей уникальных email не растит его без предела', () => {
    // Корзину заводим для ЛЮБОГО адреса — иначе разница во времени ответа сама
    // выдаёт, какой аккаунт существует. Значит защита от OOM не в отказе заводить
    // корзины, а в потолке их числа и вытеснении самых старых.
    // Проверяем напрямую на reserveVerify: гонять 6000 запросов через HTTP с bcrypt
    // заняло бы десятки минут, а суть проверки — в самом хранилище.
    resetThrottle()
    for (let i = 0; i < MAX_BUCKETS * 2; i++) reserveVerify(`email:spray-${i}@nowhere.ru`)
    expect(volatileSize()).toBeLessThanOrEqual(MAX_BUCKETS)
  })

  it('флуд уникальными несуществующими email не жжёт CPU: путь всегда fakeVerifyDelay, не bcrypt', async () => {
    // Несуществующий email больше не идёт на настоящий bcrypt вообще (ни при каких
    // условиях) — всегда fakeVerifyDelay, дешёвый по CPU. Контракт: ответ 401,
    // сервис не блокируется.
    for (let i = 0; i < THROTTLE_IP_FREE_ATTEMPTS + 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: `ghost-${i}-${Date.now()}@nowhere.ru`, password: 'x' },
      })
      expect(res.statusCode).toBe(401)
    }
  }, 60_000)

  it('флуд не запирает владельца: верный пароль проходит даже после долгой серии неудач', async () => {
    for (let i = 0; i < THROTTLE_IP_FREE_ATTEMPTS + 5; i++) {
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `flood-${i}@nowhere.ru`, password: 'x' } })
    }
    const res = await login('a@a.ru', 'password123')
    expect(res.statusCode).toBe(200)
  }, 60_000)

  it('владелец логинится за секунды, ПОКА идёт активный флуд поддельных email — независимая проверка нашла: раньше вставал в ту же очередь', async () => {
    // Тот самый регресс: fakeVerifyDelay раньше шёл через общий serializeVerify —
    // каждый уникальный несуществующий email резервирует слот мгновенно (emailWait=0,
    // это его первое обращение), и все они попадали в ОДНУ очередь с настоящим
    // логином владельца. При потоке в тысячи запросов владелец встал бы в конец
    // этой очереди и ждал бы весь поток целиком — блокировка не отказом (429),
    // а фактическим временем ожидания, то есть то же самое, от чего был весь фикс.
    // Флуд не ждём (не await) — он должен оставаться «в полёте» одновременно
    // с попыткой владельца, как в реальной атаке.
    const flood = Array.from({ length: 500 }, (_, i) =>
      app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `flood-${i}-${Date.now()}@nowhere.ru`, password: 'x' } })
    )
    const t = Date.now()
    const res = await login('a@a.ru', 'password123')
    const elapsed = Date.now() - t
    expect(res.statusCode).toBe(200)
    // 500 запросов через serializeVerify заняли бы больше минуты; фейковый путь
    // мимо шлюза — владелец укладывается в пару секунд независимо от флуда.
    expect(elapsed).toBeLessThan(5000)
    await Promise.all(flood) // не оставляем висящих промисов после теста
  }, 60_000)

  it('владелец логинится даже при флуде НА ЕГО ЖЕ email с ЧУЖОГО адреса — тест выше ловит только флуд по чужим адресам', async () => {
    // Codex прямо указал на пробел: тест на 500 фейковых email не показателен для
    // ЭТОЙ атаки — разные email и так идут мимо очереди через fakeVerifyDelay.
    // Настоящая угроза — флуд на email владельца (он опубликован на сайте): все
    // попытки делят один и тот же ключ в reserveVerify/verifyOrFake. Флуд — с ОДНОГО
    // чужого IP (реалистичный сценарий: атакующий редко сидит на адресе владельца),
    // попытка владельца — со своего, дефолтного для инъекций в этом файле. Потолок
    // по источнику (MAX_QUEUED_PER_SOURCE) гарантирует: атакующий не может занять
    // больше одного из MAX_QUEUED_PER_KEY слотов, попытке владельца всегда есть куда
    // встать. Ретраи оставлены как запас на фазу reserveVerify (она по-прежнему
    // общая на ключ и капается на 10 с независимо от источника, см. auth.js) —
    // не на гонку за слот bcrypt, та теперь честно разделена по источнику.
    const flood = Array.from({ length: 60 }, () =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': '203.0.113.50' },
        payload: { email: 'a@a.ru', password: 'wrong-guess' },
      })
    )
    const t = Date.now()
    let res
    for (let attempt = 0; attempt < 5; attempt++) {
      res = await login('a@a.ru', 'password123')
      if (res.statusCode === 200) break
    }
    const elapsed = Date.now() - t
    expect(res.statusCode).toBe(200)
    expect(elapsed).toBeLessThan(30000)
    await Promise.all(flood)
  }, 60_000)

  it('несуществующий email тоже прогоняет bcrypt — нет тайминговой энумерации', async () => {
    // До фикса ответ на чужой email был мгновенным (~1 мс), на существующий —
    // ~230 мс (bcrypt). По разнице во времени атакующий определял валидные учётки.
    // Порог 40 мс надёжно отделяет «bcrypt выполнился» от «мгновенного ответа»:
    // bcrypt cost 12 на любом железе дольше 100 мс, а без него путь занимал ~1 мс.
    const t = Date.now()
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ghost@nowhere.ru', password: 'x' } })
    const elapsed = Date.now() - t
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).error).toBe('invalid_credentials')
    expect(elapsed).toBeGreaterThan(40)
  })

  it('без cookie /api/crm/* → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/crm/contacts' })
    expect(res.statusCode).toBe(401)
  })

  it('процентное кодирование в пути НЕ обходит авторизацию (боевой пентест)', async () => {
    // req.url остаётся сырым (`/api/%63rm/...`), а роутер Fastify декодирует %63→c и
    // ведёт на CRM-роут: матч авторизации по req.url пропускал такой запрос без входа
    // и отдавал ПДн всех клиентов. Барьер теперь по каноническому шаблону роута.
    for (const path of [
      '/api/%63rm/contacts',   // %63 = c
      '/api/c%72m/contacts',   // %72 = r
      '/api/cr%6d/contacts',   // %6d = m
      '/api/%63%72%6d/deals',
      '/api/%63rm/users',
    ]) {
      const res = await app.inject({ method: 'GET', url: path })
      expect(res.statusCode, `${path} обязан быть 401 без cookie`).toBe(401)
    }
  })

  it('на ответах стоят заголовки безопасности', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    const csp = res.headers['content-security-policy'] || ''
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self'")           // без 'unsafe-inline' в script-src
    expect(csp.includes("script-src 'self' 'unsafe-inline'")).toBe(false)
    expect(res.headers['strict-transport-security']).toContain('max-age=')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['x-frame-options']).toBe('DENY')
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
  })

  it('логин отбивает переросшее тело (bodyLimit) → 413', async () => {
    const big = { email: 'a@a.ru', password: 'x'.repeat(20000) } // ~20 КБ > 4 КБ лимита
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: big })
    expect(res.statusCode).toBe(413)
  })

  it('смена пароля инвалидирует старую сессию (tokenVersion)', async () => {
    // Пользователь 1 — admin, порог для него 16 символов (MIN_ADMIN_PASSWORD_LENGTH)
    await app.inject({ method: 'PATCH', url: '/api/crm/users/1', payload: { password: 'newpassword12345' }, headers: { cookie } })
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

  it('битый Origin — 403, а не 500', async () => {
    // new URL('not a url') бросает исключение, а необработанное внутри preHandler оно
    // отдавало 500 ERR_INVALID_URL. Не разобрали Origin — значит не браузер, значит отказ.
    const res = await app.inject({
      method: 'POST',
      url: '/api/crm/contacts',
      payload: { name: 'X' },
      headers: { cookie, origin: 'not a url', host: 'localhost:3001' },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('APP_ORIGIN: строгая CSRF-проверка, когда домен CRM настроен явно', () => {
  // Независимый аудит: сравнение с X-Forwarded-Host — это сравнение с заголовком,
  // который в общем случае подставляет клиент, а не прокси. Явный APP_ORIGIN
  // такой лазейки не оставляет — сравниваем строго с настроенным значением.
  let strictApp, strictCookie, strictPool

  beforeEach(async () => {
    strictPool = await makePool()
    strictApp = await buildApp({ dbConfig: strictPool, secure: false, appOrigin: 'https://crm-nevarium.ru' })
    await strictApp.db.prepare('INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)')
      .run('Админ', 'a@a.ru', await hashPassword('password123'), 'admin', now())
    await strictApp.ready()
    strictCookie = (await strictApp.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@a.ru', password: 'password123' } })).headers['set-cookie']
  })
  afterEach(async () => {
    try {
      await strictApp?.close?.()
    } finally {
      await dropPool(strictPool)
    }
  })

  it('верный Origin проходит', async () => {
    const res = await strictApp.inject({
      method: 'POST', url: '/api/crm/contacts', payload: { name: 'X' },
      headers: { cookie: strictCookie, origin: 'https://crm-nevarium.ru' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('поддельный X-Forwarded-Host больше не помогает — сравнение идёт с APP_ORIGIN, не с заголовком', async () => {
    const res = await strictApp.inject({
      method: 'POST', url: '/api/crm/contacts', payload: { name: 'X' },
      headers: { cookie: strictCookie, origin: 'https://evil.example', 'x-forwarded-host': 'evil.example', host: 'evil.example' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('отсутствие Origin тоже отклоняется — в строгом режиме, в отличие от мягкого', async () => {
    const res = await strictApp.inject({
      method: 'POST', url: '/api/crm/contacts', payload: { name: 'X' },
      headers: { cookie: strictCookie },
    })
    expect(res.statusCode).toBe(403)
  })

  it('GET не требует Origin даже в строгом режиме', async () => {
    const res = await strictApp.inject({ method: 'GET', url: '/api/crm/contacts', headers: { cookie: strictCookie } })
    expect(res.statusCode).toBe(200)
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

  it('PATCH той же стадией не затирает closed_at', async () => {
    // Форма редактирования сделки всегда шлёт текущую стадию, поэтому правка одной лишь
    // заметки у закрытой сделки перевыставляла closed_at на сегодня и теряла настоящую
    // дату закрытия — а по ней считается воронка за прошлые периоды.
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов' }, headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/crm/deals', payload: { contact_id: 1, title: 'Пилот' }, headers: { cookie } })
    const paid = await app.inject({ method: 'PATCH', url: '/api/crm/deals/1', payload: { stage: 'Оплачено' }, headers: { cookie } })
    const closedAt = JSON.parse(paid.body).item.closed_at
    expect(closedAt).toBeTruthy()
    const edited = await app.inject({
      method: 'PATCH',
      url: '/api/crm/deals/1',
      payload: { stage: 'Оплачено', note: 'уточнение по договору' },
      headers: { cookie },
    })
    expect(JSON.parse(edited.body).item.closed_at).toBe(closedAt)
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
    const contact = await app.db.prepare('SELECT * FROM contacts WHERE id = 1').get()
    expect(contact).toMatchObject({ name: 'Марина', email: 'm@x.ru', source: 'site-form', suspicious: 0 })
    const deal = await app.db.prepare('SELECT * FROM deals WHERE id = 1').get()
    expect(deal.title).toContain('внедрение ИИ')
    expect(deal.stage).toBe('Новый')
    expect((await app.db.prepare("SELECT COUNT(*) c FROM outbox WHERE kind = 'lead' AND tg_sent_at IS NULL AND max_sent_at IS NULL").get()).c).toBe(1)
  })

  it('чат: detail → заметка сделки, handle → messenger и имя', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/leads', payload: { task: 'чат-бот', detail: 'для клиники', contact: '@tg_user', source: 'chat' } })
    expect(res.statusCode).toBe(204)
    const contact = await app.db.prepare('SELECT * FROM contacts WHERE id = 1').get()
    expect(contact).toMatchObject({ name: '@tg_user', messenger: '@tg_user', source: 'site-chat' })
    expect((await app.db.prepare('SELECT note FROM deals WHERE id = 1').get()).note).toBe('для клиники')
  })

  it('чат: transcript → полная переписка во взаимодействиях, а не в note сделки', async () => {
    const transcript = 'Нева: Здравствуйте!\nКлиент: хочу чат-бота\nНева: на какой масштаб?'
    const res = await app.inject({ method: 'POST', url: '/api/leads', payload: { task: 'чат-бот', detail: 'для клиники', transcript, contact: '@tg_user', source: 'chat' } })
    expect(res.statusCode).toBe(204)
    expect((await app.db.prepare('SELECT note FROM deals WHERE id = 1').get()).note).toBe('для клиники')
    const interaction = await app.db.prepare('SELECT * FROM interactions WHERE contact_id = 1').get()
    expect(interaction).toMatchObject({ type: 'сообщение', note: transcript })
  })

  it('форма без transcript не создаёт взаимодействие', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Клиент', contact: 'k@x.ru' } })
    expect((await app.db.prepare('SELECT COUNT(*) c FROM interactions').get()).c).toBe(0)
  })

  it('honeypot: молчаливый дроп — отвечает как успех, но ничего не сохраняет и не уведомляет', async () => {
    // ТЗ сайта Визор (docs/CRM-REQUIREMENTS.md, §1.3): отвечать нужно как при успехе
    // (иначе бот подберёт обход по коду ответа), но не сохранять и не уведомлять.
    const res = await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Бот', contact: 'bot@x.ru', website: 'spam.com' } })
    expect(res.statusCode).toBe(204)
    expect((await app.db.prepare('SELECT COUNT(*) c FROM contacts').get()).c).toBe(0)
    expect((await app.db.prepare('SELECT COUNT(*) c FROM outbox').get()).c).toBe(0)
  })

  it('проект из поля формы не перекрывает уже определённый по Origin', async () => {
    // ТЗ сайта Визор §2: недоверенный клиент передаёт project сам — если он молча
    // побеждает доверенный Origin, атакующий может загрязнить инбокс чужого бизнеса.
    await app.db.prepare("UPDATE projects SET origins = 'https://vizor.example.ru' WHERE slug = 'nevarium-vizor'").run()
    await app.inject({
      method: 'POST',
      url: '/api/leads',
      payload: { name: 'Клиент', contact: 'k@x.ru', project: 'nevarium1' },
      headers: { origin: 'https://vizor.example.ru' },
    })
    expect((await app.db.prepare('SELECT project_id FROM contacts WHERE id = 1').get()).project_id).toBe(2)
  })

  it('rate limit не отбрасывает: 5-й лид с одного IP — подозрительный', async () => {
    for (let i = 0; i < 5; i++) {
      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: `Гость ${i}`, contact: `g${i}@x.ru` }, remoteAddress: '10.1.1.1' })
    }
    expect((await app.db.prepare('SELECT COUNT(*) c FROM contacts').get()).c).toBe(5)
    expect((await app.db.prepare('SELECT suspicious FROM contacts WHERE id = 5').get()).suspicious).toBe(1)
  })

  it('жёсткий rate-limit: 429 только после щедрого порога — обычный всплеск его не задевает', async () => {
    // ТЗ сайта Визор §1.2. Порог намного щедрее примера из ТЗ («5 за 10 минут») —
    // тот заденет офис на одном IP/CGNAT после пары настоящих заявок подряд, что
    // противоречит многолетней логике leadSuspicious (см. ADR-006/015).
    const codes = []
    for (let i = 0; i < 35; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/leads', payload: { name: `Г${i}`, contact: `rl${i}@x.ru` }, remoteAddress: '10.2.2.2' })
      codes.push(res.statusCode)
    }
    expect(codes.slice(0, 30)).not.toContain(429)
    expect(codes.slice(30)).toContain(429)
  }, 30_000)

  it('жёсткий rate-limit раздельный: флуд по leads не трогает pd-requests с того же IP', async () => {
    for (let i = 0; i < 35; i++) {
      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: `Г${i}`, contact: `sep${i}@x.ru` }, remoteAddress: '10.3.3.3' })
    }
    const res = await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'still-ok@x.ru' }, remoteAddress: '10.3.3.3' })
    expect(res.statusCode).toBe(204)
  }, 30_000)

  describe('глобальная квота на уведомления о лидах по проекту (ТЗ сайта Визор §1.2)', () => {
    // Независимая проверка (раунд 17): первая версия отвечала 429 и НЕ сохраняла
    // заявку — квота теперь решает только судьбу enqueue(): приём — 204, запись
    // в БД — всегда безусловно, независимо от бюджета уведомлений.
    it('61-й лид на проект за час — всё равно 204 и сохранён; уведомления в outbox упираются в потолок 60', async () => {
      const codes = []
      for (let i = 0; i < 61; i++) {
        const res = await app.inject({ method: 'POST', url: '/api/leads', payload: { name: `К${i}`, contact: `q${i}@x.ru` }, remoteAddress: `10.9.0.${i}` })
        codes.push(res.statusCode)
      }
      expect(codes).not.toContain(429)
      expect((await app.db.prepare('SELECT COUNT(*) c FROM contacts').get()).c).toBe(61)
      expect((await app.db.prepare("SELECT COUNT(*) c FROM outbox WHERE kind = 'lead'").get()).c).toBe(60)
    }, 45_000)

    it('насыщение бюджета шлёт ОДНО гарантированное предупреждение, не одно на каждую скрытую заявку (раунд 23)', async () => {
      // Независимая проверка: без явного сигнала исчерпание бюджета неотличимо от
      // затишья — «нет уведомлений о лидах» выглядит одинаково и когда лидов правда
      // нет, и когда их слишком много (это и есть «cheap targeted alerting DoS»).
      for (let i = 0; i < 65; i++) {
        await app.inject({ method: 'POST', url: '/api/leads', payload: { name: `К${i}`, contact: `w${i}@x.ru` }, remoteAddress: `10.9.5.${i}` })
      }
      // ровно одно предупреждение, а не пять (по числу скрытых заявок сверх 60)
      expect((await app.db.prepare("SELECT COUNT(*) c FROM outbox WHERE kind = 'text'").get()).c).toBe(1)
      const payload = JSON.parse((await app.db.prepare("SELECT payload FROM outbox WHERE kind = 'text'").get()).payload)
      expect(payload.text).toContain('Много заявок за час')
    }, 60_000)

    it('квота раздельная по проектам — насыщение одного не трогает соседний', async () => {
      for (let i = 0; i < 60; i++) {
        await app.inject({ method: 'POST', url: '/api/leads', payload: { name: `К${i}`, contact: `p1-${i}@x.ru` }, remoteAddress: `10.9.1.${i}` })
      }
      // проект 1 (по умолчанию) уже насытил бюджет уведомлений — приём не пострадал
      const same = await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Ещё', contact: 'over@x.ru' }, remoteAddress: '10.9.1.200' })
      expect(same.statusCode).toBe(204)
      expect((await app.db.prepare("SELECT COUNT(*) c FROM outbox WHERE kind = 'lead'").get()).c).toBe(60)
      // сосед — другой проект, свой бюджет, уведомление уходит как обычно
      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Сосед', contact: 'ok@x.ru', project: 'nevarium-vizor' }, remoteAddress: '10.9.1.201' })
      expect((await app.db.prepare("SELECT COUNT(*) c FROM outbox WHERE kind = 'lead'").get()).c).toBe(61)
    }, 45_000)

    it('запросы по ПДн этой квотой не ограничены вообще (раунд 19): насыщение лидов не трогает pd-requests, и сами pd-requests не имеют потолка', async () => {
      // Независимая проверка (раунд 19): гейт «только на уведомление», применённый
      // к pd-requests так же, как к лидам, всё ещё создавал дешёвую DoS — 30 запросов
      // с одного IP гасят бюджет проекта, и настоящий 31-й запрос сохраняется, но
      // БЕЗ пинга сотруднику. Правильный фикс — /api/pd-requests не участвует в этом
      // механизме вообще, ни с одной, ни с другой стороны.
      for (let i = 0; i < 60; i++) {
        await app.inject({ method: 'POST', url: '/api/leads', payload: { name: `К${i}`, contact: `s2-${i}@x.ru` }, remoteAddress: `10.9.2.${i}` })
      }
      for (let i = 0; i < 35; i++) {
        const res = await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: `pd${i}@x.ru` }, remoteAddress: `10.9.3.${i}` })
        expect(res.statusCode).toBe(204)
      }
      expect((await app.db.prepare('SELECT COUNT(*) c FROM pd_requests').get()).c).toBe(35)
      expect((await app.db.prepare('SELECT COUNT(*) c FROM pd_requests WHERE due_date IS NOT NULL').get()).c).toBe(35)
      // 35 > старого потолка 30 — ни один запрос не остался без уведомления
      expect((await app.db.prepare("SELECT COUNT(*) c FROM outbox WHERE kind = 'text'").get()).c).toBe(35)
    }, 60_000)
  })

  it('неизвестное поле в теле не отбрасывает заявку — только предупреждение в лог (ADR-006: не отвергаем)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Клиент', contact: 'k@x.ru', totally_unexpected_field: 'x' } })
    expect(res.statusCode).toBe(204)
    expect((await app.db.prepare('SELECT COUNT(*) c FROM contacts').get()).c).toBe(1)
  })

  describe('идемпотентность (ТЗ сайта Визор §1.1)', () => {
    it('Idempotency-Key: повтор с тем же ключом не создаёт вторую заявку и не шлёт повторное уведомление', async () => {
      const payload = { name: 'Марина', contact: 'm@x.ru' }
      const headers = { 'idempotency-key': 'req-1' }
      const first = await app.inject({ method: 'POST', url: '/api/leads', payload, headers })
      const second = await app.inject({ method: 'POST', url: '/api/leads', payload, headers })
      expect(first.statusCode).toBe(204)
      expect(second.statusCode).toBe(204)
      expect((await app.db.prepare('SELECT COUNT(*) c FROM contacts').get()).c).toBe(1)
      // outbox, не только contacts: дедуп по человеку (ADR-014) всё равно enqueue'ит
      // уведомление о «повторной заявке» на каждый POST — только идемпотентность
      // по ключу не даёт второму вызову вообще дойти до этой логики.
      expect((await app.db.prepare('SELECT COUNT(*) c FROM outbox').get()).c).toBe(1)
    })

    it('request_id в теле работает так же, как заголовок Idempotency-Key', async () => {
      const payload = { name: 'Пётр', contact: 'p@x.ru', request_id: 'req-2' }
      await app.inject({ method: 'POST', url: '/api/leads', payload })
      await app.inject({ method: 'POST', url: '/api/leads', payload })
      expect((await app.db.prepare('SELECT COUNT(*) c FROM outbox').get()).c).toBe(1)
    })

    it('слишком длинный ключ не обрезается вслепую — два разных длинных ключа не схлопываются в один', async () => {
      // Codex поймал: обрезка до 200 символов могла бы схлопнуть два РАЗНЫХ ключа,
      // различающихся только после символа 200, в один и потерять одну из отправок.
      const prefix = 'x'.repeat(200)
      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'A', contact: 'long1@x.ru', request_id: prefix + '-one' } })
      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'B', contact: 'long2@x.ru', request_id: prefix + '-two' } })
      expect((await app.db.prepare('SELECT COUNT(*) c FROM contacts').get()).c).toBe(2)
    })

    it('разные ключи — разные вызовы, идемпотентность их не путает', async () => {
      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Иван', contact: 'i1@x.ru', request_id: 'k1' } })
      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Иван', contact: 'i2@x.ru', request_id: 'k2' } })
      expect((await app.db.prepare('SELECT COUNT(*) c FROM contacts').get()).c).toBe(2)
    })

    it('honeypot тоже идемпотентен: повтор с тем же ключом не пытается сохранить снова', async () => {
      const payload = { name: 'Бот', contact: 'bot@x.ru', website: 'spam.com', request_id: 'req-hp' }
      const first = await app.inject({ method: 'POST', url: '/api/leads', payload })
      const second = await app.inject({ method: 'POST', url: '/api/leads', payload })
      expect(first.statusCode).toBe(204)
      expect(second.statusCode).toBe(204)
      expect((await app.db.prepare('SELECT COUNT(*) c FROM contacts').get()).c).toBe(0)
    })

    // Два теста ниже добавлены ревью перевода на Postgres: все остальные тесты этого
    // блока шлют повторы ПОСЛЕДОВАТЕЛЬНО (await), поэтому первый запрос всегда успевает
    // полностью завершиться (claim → бизнес-логика → idempotencyFinish) до второго. Та
    // самая гонка, ради которой check-then-act и переписан на claim-first (окно между
    // «ключа ещё нет» и «ключ записан», открывшееся с асинхронным pg), не
    // воспроизводилась НИ ОДНИМ тестом.
    it('claim-first: два ОДНОВРЕМЕННЫХ запроса с одним ключом не создают вторую заявку', async () => {
      const payload = { name: 'Гонка', contact: 'race@x.ru', request_id: 'race-key' }
      const [a, b] = await Promise.all([
        app.inject({ method: 'POST', url: '/api/leads', payload }),
        app.inject({ method: 'POST', url: '/api/leads', payload }),
      ])
      // Проигравший получает либо закешированный терминальный код победителя (204),
      // либо 429 «повторите тем же ключом» — но НИКОГДА не вторую запись.
      expect([a.statusCode, b.statusCode].every((c) => c === 204 || c === 429)).toBe(true)
      expect((await app.db.prepare('SELECT COUNT(*) c FROM contacts').get()).c).toBe(1)
      expect((await app.db.prepare('SELECT COUNT(*) c FROM deals').get()).c).toBe(1)
    })

    it('429 по жёсткому лимиту освобождает ключ: повтор тем же ключом не залипает навсегда', async () => {
      // idempotencyAbandon. 429 обязан остаться ПОВТОРЯЕМЫМ: если ключ останется
      // застолблённым со status_code = NULL, любой повтор с ним будет вечно упираться
      // в конкурентную ветку claim-first и заявка потеряется молча. Раньше эта ветка
      // не выполнялась ни разу — единственный тест на hardRateLimited шлёт запросы
      // БЕЗ ключа, а тогда claim.id === null и удалять просто нечего.
      const ip = '10.7.7.7'
      for (let i = 0; i < 30; i++) {
        await app.inject({ method: 'POST', url: '/api/leads', payload: { name: `Ф${i}`, contact: `ab${i}@x.ru` }, remoteAddress: ip })
      }
      const blocked = await app.inject({
        method: 'POST', url: '/api/leads',
        payload: { name: 'Заблокированный', contact: 'blocked@x.ru', request_id: 'abandon-key' },
        remoteAddress: ip,
      })
      expect(blocked.statusCode).toBe(429)
      // ключ снят, а не оставлен со status_code = NULL
      expect((await app.db.prepare('SELECT COUNT(*) c FROM idempotency_keys WHERE request_id = ?').get('abandon-key')).c).toBe(0)

      // и тот же ключ с другого IP (лимит per-IP) проходит нормально, а не залипает
      const retry = await app.inject({
        method: 'POST', url: '/api/leads',
        payload: { name: 'Заблокированный', contact: 'blocked@x.ru', request_id: 'abandon-key' },
        remoteAddress: '10.7.7.8',
      })
      expect(retry.statusCode).toBe(204)
      expect((await app.db.prepare('SELECT status_code FROM idempotency_keys WHERE request_id = ?').get('abandon-key')).status_code).toBe(204)
    }, 30_000)
  })

  it('пустой лид отбрасывается без записи', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: {} })
    expect((await app.db.prepare('SELECT COUNT(*) c FROM contacts').get()).c).toBe(0)
  })

  it('проект берётся из поля формы — контакт и сделка попадают в него', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Клиент', contact: 'k@x.ru', project: 'nevarium-vizor' } })
    expect((await app.db.prepare('SELECT project_id FROM contacts WHERE id = 1').get()).project_id).toBe(2)
    expect((await app.db.prepare('SELECT project_id FROM deals WHERE id = 1').get()).project_id).toBe(2)
  })

  it('без поля формы проект определяется по домену сайта', async () => {
    await app.db.prepare("UPDATE projects SET origins = 'https://vizor.example.ru' WHERE slug = 'nevarium-vizor'").run()
    await app.inject({
      method: 'POST',
      url: '/api/leads',
      payload: { name: 'Клиент', contact: 'k@x.ru' },
      headers: { origin: 'https://vizor.example.ru' },
    })
    expect((await app.db.prepare('SELECT project_id FROM contacts WHERE id = 1').get()).project_id).toBe(2)
  })

  it('неизвестный проект не теряет заявку — уходит в проект по умолчанию', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Клиент', contact: 'k@x.ru', project: 'опечатка' } })
    expect(res.statusCode).toBe(204)
    expect((await app.db.prepare('SELECT project_id FROM contacts WHERE id = 1').get()).project_id).toBe(1)
  })

  describe('дубли: тот же человек не заводит вторую карточку', () => {
    const lead = (payload) => app.inject({ method: 'POST', url: '/api/leads', payload })
    const count = async (t) => (await app.db.prepare(`SELECT COUNT(*) c FROM ${t}`).get()).c

    it('форма, потом чат с тем же адресом — один контакт и одна сделка', async () => {
      await lead({ name: 'Марина', contact: 'm@x.ru', task: 'внедрение ИИ' })
      await lead({ contact: 'M@X.RU', task: 'уточняю по чат-боту', detail: 'ещё вопрос', source: 'chat' })
      expect(await count('contacts')).toBe(1)
      expect(await count('deals')).toBe(1)
      // текст второго обращения не потерялся — он в истории
      const notes = (await app.db.prepare('SELECT note FROM interactions WHERE contact_id = 1').all()).map((r) => r.note).join('\n')
      expect(notes).toContain('Повторная заявка')
      expect(notes).toContain('уточняю по чат-боту')
    })

    it('телефон опознаётся в разных записях: +7, 8 и без кода', async () => {
      await lead({ name: 'Марина', contact: '+7 921 555-14-88' })
      await lead({ name: 'Марина', contact: '8 (921) 555-14-88' })
      await lead({ name: 'Марина', contact: '9215551488' })
      expect(await count('contacts')).toBe(1)
    })

    it('разные люди не склеиваются', async () => {
      await lead({ name: 'Марина', contact: 'm@x.ru' })
      await lead({ name: 'Пётр', contact: 'p@x.ru' })
      await lead({ name: 'Иван', contact: '+7 921 000-00-01' })
      expect(await count('contacts')).toBe(3)
    })

    it('совпадение имени без совпадения контакта не склеивает', async () => {
      await lead({ name: 'Иван Иванов', contact: 'ivan1@x.ru' })
      await lead({ name: 'Иван Иванов', contact: 'ivan2@x.ru' })
      expect(await count('contacts')).toBe(2)
    })

    it('одинаковый контакт в разных проектах — разные карточки: это разные бизнесы', async () => {
      await lead({ name: 'Марина', contact: 'm@x.ru', project: 'nevarium1' })
      await lead({ name: 'Марина', contact: 'm@x.ru', project: 'nevarium-vizor' })
      expect(await count('contacts')).toBe(2)
    })

    it('обезличенный контакт не подхватывается — новое обращение это новое согласие', async () => {
      await lead({ name: 'Марина', contact: 'm@x.ru' })
      await app.inject({ method: 'POST', url: '/api/crm/contacts/1/anonymize', headers: { cookie } })
      await lead({ name: 'Марина', contact: 'm@x.ru' })
      expect(await count('contacts')).toBe(2)
    })

    it('если все сделки закрыты — заводится новая, а не переиспользуется', async () => {
      await lead({ name: 'Марина', contact: 'm@x.ru', task: 'первый проект' })
      await app.inject({ method: 'PATCH', url: '/api/crm/deals/1', payload: { stage: 'Оплачено' }, headers: { cookie } })
      await lead({ name: 'Марина', contact: 'm@x.ru', task: 'второй проект' })
      expect(await count('contacts')).toBe(1)
      expect(await count('deals')).toBe(2)
      expect((await app.db.prepare('SELECT stage FROM deals WHERE id = 2').get()).stage).toBe('Новый')
    })

    it('вернувшийся клиент снимает напоминания воронки возврата', async () => {
      await lead({ name: 'Марина', contact: 'm@x.ru' })
      await app.inject({ method: 'PATCH', url: '/api/crm/deals/1', payload: { stage: 'Проиграно', reason: 'дорого' }, headers: { cookie } })
      expect((await app.db.prepare('SELECT COUNT(*) c FROM tasks WHERE done = 0').get()).c).toBe(3)

      await lead({ name: 'Марина', contact: 'm@x.ru', task: 'всё-таки решились' })
      expect((await app.db.prepare('SELECT COUNT(*) c FROM tasks WHERE done = 0').get()).c).toBe(0)
      expect((await app.db.prepare('SELECT status FROM winback_sequences WHERE id = 1').get()).status).toBe('cancelled')
      // и уведомление говорит именно о возврате, а не о «новой заявке»
      const payload = JSON.parse((await app.db.prepare('SELECT payload FROM outbox ORDER BY id DESC LIMIT 1').get()).payload)
      expect(leadMessage(payload)).toContain('Клиент вернулся сам')
    })

    it('архивный контакт возвращается из архива, иначе заявка пропала бы из инбокса', async () => {
      await lead({ name: 'Марина', contact: 'm@x.ru' })
      await app.inject({ method: 'PATCH', url: '/api/crm/contacts/1', payload: { archived: 1 }, headers: { cookie } })
      await lead({ name: 'Марина', contact: 'm@x.ru' })
      expect((await app.db.prepare('SELECT archived FROM contacts WHERE id = 1').get()).archived).toBe(0)
      const dash = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/dashboard', headers: { cookie } })).body)
      expect(dash.inbox.some((c) => c.id === 1)).toBe(true)
    })

    it('повторная заявка помечена в уведомлении, но ПДн в Telegram по-прежнему нет', async () => {
      await lead({ name: 'Марина Соколова', contact: 'm@x.ru' })
      await lead({ name: 'Марина Соколова', contact: 'm@x.ru', task: 'секретная задача' })
      const payload = JSON.parse((await app.db.prepare('SELECT payload FROM outbox ORDER BY id DESC LIMIT 1').get()).payload)
      const text = leadMessage(payload)
      expect(text).toContain('Повторная заявка')
      expect(text).not.toMatch(/Марина|секретная/)
    })
  })

  describe('слепок согласия (ТЗ сайта Визор, раздел «Про consent»; 152-ФЗ ст.9 с 2026-09-01)', () => {
    it('consent сохраняется целиком: версия, текст, момент согласия, и КТО согласился', async () => {
      const consent = { version: '27 июля 2026 года', text: 'Я даю согласие ИП Макеевой М. А. на обработку…', accepted_at: '2026-08-07T19:16:50.717Z' }
      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'm@x.ru', consent } })
      const row = await app.db.prepare('SELECT * FROM consents WHERE contact_id = 1').get()
      expect(row).toMatchObject({ requester: 'm@x.ru', version: consent.version, text: consent.text, accepted_at: consent.accepted_at, deal_id: 1, project_id: 1 })
    })

    it('отсутствующий consent не отбрасывает заявку — пишется пустая строка-доказательство', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Клиент', contact: 'k@x.ru' } })
      expect(res.statusCode).toBe(204)
      const row = await app.db.prepare('SELECT * FROM consents WHERE contact_id = 1').get()
      expect(row).toMatchObject({ version: '', text: '', accepted_at: null })
    })

    it('повторное обращение того же человека получает СВОЮ строку согласия, а не перезаписывает первую', async () => {
      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'm@x.ru', consent: { version: 'v1', text: 'старая редакция', accepted_at: '2026-01-01T00:00:00Z' } } })
      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'm@x.ru', consent: { version: 'v2', text: 'новая редакция', accepted_at: '2026-08-01T00:00:00Z' } } })
      const rows = await app.db.prepare('SELECT version FROM consents WHERE contact_id = 1 ORDER BY id').all()
      expect(rows.map((r) => r.version)).toEqual(['v1', 'v2'])
    })

    it('честный контракт: доступно для выгрузки как доказательство через существующий экспорт', async () => {
      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'm@x.ru', consent: { version: 'v1', text: 'текст согласия', accepted_at: '2026-08-01T00:00:00Z' } } })
      const dump = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })).body)
      expect(dump.consents).toHaveLength(1)
      expect(dump.consents[0]).toMatchObject({ version: 'v1', text: 'текст согласия' })
    })

    it('раунд-трип: экспорт → wipe → импорт сохраняет согласие целиком', async () => {
      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'm@x.ru', consent: { version: 'v1', text: 'текст', accepted_at: '2026-08-01T00:00:00Z' } } })
      const dump = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })).body)
      expect(dump.version).toBe(DUMP_VERSION)
      const res = await app.inject({ method: 'POST', url: '/api/crm/import', payload: dump, headers: { cookie } })
      expect(res.statusCode).toBe(200)
      const row = await app.db.prepare('SELECT * FROM consents WHERE id = 1').get()
      expect(row).toMatchObject({ contact_id: 1, deal_id: 1, requester: 'm@x.ru', version: 'v1', text: 'текст' })
    })

    it('дамп с pd_requests, но БЕЗ ключа consents (снят между появлением ПДн-раздела и появлением согласия): существующее согласие не стирается, но привязка рвётся', async () => {
      // hasCompliance (наличие pd_requests) слишком грубый флаг для consents — эта
      // таблица младше. Дамп такого «промежуточного» формата не должен ни стереть
      // сегодняшние согласия (их там просто нет физически), ни оставить их указывающими
      // на contact_id, который импорт вот-вот переиспользует для ДРУГОГО человека.
      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'm@x.ru', consent: { version: 'v1', text: 'текст', accepted_at: '2026-08-01T00:00:00Z' } } })
      const dump = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })).body)
      delete dump.consents // симулируем дамп до появления этой таблицы

      const res = await app.inject({ method: 'POST', url: '/api/crm/import', payload: dump, headers: { cookie } })
      expect(res.statusCode).toBe(200)
      // строка жива — само согласие как факт не потеряно
      const row = await app.db.prepare('SELECT * FROM consents WHERE id = 1').get()
      expect(row).toMatchObject({ version: 'v1', text: 'текст' })
      // привязка к контакту разорвана — тот только что пересоздан с тем же id
      expect(row.contact_id).toBeNull()
      expect(row.deal_id).toBeNull()
      // НО requester (независимая проверка, раунд 17) — переживает разрыв: без него
      // строка осталась бы «кто-то когда-то на что-то согласился» — недоказательной
      expect(row.requester).toBe('m@x.ru')
    })

    it('осиротевшее legacy-восстановлением согласие всё равно затирается при обезличивании ТОГО ЖЕ человека (раунд 21)', async () => {
      // Независимая проверка нашла: consents.requester переживает разрыв (раунд 17),
      // но anonymizeContact() матчит только по contact_id (раунд 20) — осиротевшая
      // (contact_id=NULL) строка недостижима ЭТИМ путём и переживала бы обезличивание
      // навсегда. Сценарий: заявка → «промежуточный» дамп без consents → импорт рвёт
      // привязку → тот же человек (контакт восстановлен из дампа под тем же id и
      // email) требует обезличивания — раньше requester остался бы 'm@x.ru' навсегда.
      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'm@x.ru', consent: { version: 'v1', text: 'текст', accepted_at: '2026-08-01T00:00:00Z' } } })
      const dump = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })).body)
      delete dump.consents
      await app.inject({ method: 'POST', url: '/api/crm/import', payload: dump, headers: { cookie } })
      expect(await app.db.prepare('SELECT contact_id, requester FROM consents WHERE id = 1').get()).toMatchObject({ contact_id: null, requester: 'm@x.ru' })

      const res = await app.inject({ method: 'POST', url: '/api/crm/contacts/1/anonymize', headers: { cookie } })
      expect(res.statusCode).toBe(200)
      // requester И содержимое затёрты (раунд 23: version/text — attacker-controlled
      // свободный текст с публичного эндпоинта, то же обоснование, что и у requester)
      const row = await app.db.prepare('SELECT requester, version, text, text_truncated, accepted_at FROM consents WHERE id = 1').get()
      expect(row).toMatchObject({ requester: '', version: '', text: '', text_truncated: 0, accepted_at: null })
      // сама строка жива — факт «согласие когда-то было» не потерян
      expect((await app.db.prepare('SELECT COUNT(*) c FROM consents').get()).c).toBe(1)
    })

    it('осиротевшее согласие с ДРУГИМ форматом телефона тоже находится и затирается (раунд 25)', async () => {
      // Независимая проверка: старое сравнение requester точной строкой пропускало
      // совпадение, когда один и тот же номер записан по-разному ("+7 921 555-14-88"
      // vs "89215551488") — ровно тот случай, который дедуп при приёме (findExistingContact)
      // уже умеет распознавать через phoneKey. Два обращения одного человека в
      // разных форматах → два consents на один contact_id → оба осиротевшие после
      // «промежуточного» дампа обязаны найтись при обезличивании.
      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: '+7 921 555-14-88', consent: { version: 'v1', text: 'формат А' } } })
      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: '89215551488', consent: { version: 'v1', text: 'формат Б' } } })
      expect((await app.db.prepare('SELECT COUNT(*) c FROM contacts').get()).c).toBe(1) // дедуп сработал
      expect((await app.db.prepare('SELECT COUNT(*) c FROM consents WHERE contact_id = 1').get()).c).toBe(2)

      const dump = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })).body)
      delete dump.consents
      await app.inject({ method: 'POST', url: '/api/crm/import', payload: dump, headers: { cookie } })
      expect((await app.db.prepare('SELECT COUNT(*) c FROM consents WHERE contact_id IS NULL').get()).c).toBe(2)

      await app.inject({ method: 'POST', url: '/api/crm/contacts/1/anonymize', headers: { cookie } })
      const rows = await app.db.prepare('SELECT requester FROM consents').all()
      expect(rows.every((r) => r.requester === '')).toBe(true)
    })

    it('email с цифрами не путается с чужим телефоном при поиске осиротевших согласий (раунд 26)', async () => {
      // Независимая проверка: phoneKey раньше вызывался для ЛЮБОГО идентификатора,
      // включая email. Если в адресе случайно нашлась 10-значная цепочка цифр
      // ("buyer1234567890@example.ru" → "1234567890"), она совпадала бы с ключом
      // РЕАЛЬНОГО телефона ("+7 123 456-78-90" → тот же "1234567890") — и удаление/
      // обезличивание контакта с таким email стирало бы согласие СОВСЕМ ДРУГОГО
      // человека, случайно набравшего тот же 10-значный хвост.
      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Покупатель', contact: 'buyer1234567890@example.ru', consent: { version: 'v1', text: 'согласие покупателя' } } })
      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Другой', contact: '+7 123 456-78-90', consent: { version: 'v1', text: 'согласие другого' } } })
      expect((await app.db.prepare('SELECT COUNT(*) c FROM contacts').get()).c).toBe(2) // разные люди, дедуп не сработал

      const dump = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })).body)
      delete dump.consents
      await app.inject({ method: 'POST', url: '/api/crm/import', payload: dump, headers: { cookie } })
      expect((await app.db.prepare('SELECT COUNT(*) c FROM consents WHERE contact_id IS NULL').get()).c).toBe(2)

      // обезличиваем контакт с email — согласие ЧУЖОГО телефона не должно пострадать
      await app.inject({ method: 'POST', url: '/api/crm/contacts/1/anonymize', headers: { cookie } })
      const untouched = await app.db.prepare("SELECT requester, text FROM consents WHERE text = 'согласие другого'").get()
      expect(untouched).toMatchObject({ requester: '+7 123 456-78-90', text: 'согласие другого' })
    })

    it('обычное удаление контакта (не анонимизация) тоже чистит его согласие (раунд 22)', async () => {
      // Независимая проверка нашла: DELETE /api/crm/contacts/:id — отдельный от
      // anonymizeContact путь («эту карточку не стоило заводить», спам/ошибка, не
      // исполнение права на забвение) — каскадно удаляет tasks/interactions, но не
      // трогал consents. Контакт исчезает, а requester (сырой email/телефон) остаётся
      // в базе и в экспорте без единой связанной карточки — то, ради чего сотрудник
      // мог бы удалить спам-контакт, теряет смысл.
      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Спам', contact: 'spam@x.ru', consent: { version: 'v1', text: 'текст' } } })
      expect((await app.db.prepare('SELECT COUNT(*) c FROM consents WHERE contact_id = 1').get()).c).toBe(1)
      await app.inject({ method: 'DELETE', url: '/api/crm/deals/1', headers: { cookie } })
      const res = await app.inject({ method: 'DELETE', url: '/api/crm/contacts/1', headers: { cookie } })
      expect(res.statusCode).toBe(200)
      expect((await app.db.prepare('SELECT COUNT(*) c FROM consents WHERE contact_id = 1').get()).c).toBe(0)
    })

    it('удаление контакта чистит и осиротевшие legacy-восстановлением согласия того же человека (раунд 23)', async () => {
      // Тот же класс пропуска, что раунд 21 нашёл в anonymizeContact — только для
      // отдельного пути DELETE /api/crm/contacts/:id: contact_id = ? не достаёт
      // строку с contact_id = NULL, даже если она про того же человека.
      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'm@x.ru', consent: { version: 'v1', text: 'текст' } } })
      const dump = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })).body)
      delete dump.consents
      await app.inject({ method: 'POST', url: '/api/crm/import', payload: dump, headers: { cookie } })
      expect(await app.db.prepare('SELECT contact_id, requester FROM consents WHERE id = 1').get()).toMatchObject({ contact_id: null, requester: 'm@x.ru' })

      await app.inject({ method: 'DELETE', url: '/api/crm/deals/1', headers: { cookie } })
      const res = await app.inject({ method: 'DELETE', url: '/api/crm/contacts/1', headers: { cookie } })
      expect(res.statusCode).toBe(200)
      expect((await app.db.prepare('SELECT COUNT(*) c FROM consents').get()).c).toBe(0)
    })

    it('удаление сделки рвёт deal_id у согласия, но саму строку и контакт не трогает', async () => {
      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Клиент', contact: 'k@x.ru', consent: { version: 'v1', text: 'текст' } } })
      await app.inject({ method: 'DELETE', url: '/api/crm/deals/1', headers: { cookie } })
      const row = await app.db.prepare('SELECT contact_id, deal_id, requester FROM consents WHERE id = 1').get()
      expect(row).toMatchObject({ contact_id: 1, deal_id: null, requester: 'k@x.ru' })
    })

    it('текст согласия НЕ обрезается в пределах разумного — сохраняется целиком (раунд 22)', async () => {
      // Настоящая политика на несколько тысяч слов легко превышает старый потолок
      // 5000 — обрезка тихо противоречила бы claim'у «хранится целиком». Текущий
      // потолок CONSENT_TEXT_MAX = 20000 (раунд 25) с огромным запасом — этот тест
      // держится далеко внутри него.
      const longText = 'А'.repeat(6000)
      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Клиент', contact: 'l@x.ru', consent: { version: 'v1', text: longText } } })
      const row = await app.db.prepare('SELECT text, text_truncated FROM consents WHERE contact_id = 1').get()
      expect(row.text).toHaveLength(6000)
      expect(row.text).toBe(longText)
      expect(row.text_truncated).toBe(0)
    })

    it('текст согласия ограничен потолком CONSENT_TEXT_MAX = 20000, но обрезка ВИДНА через text_truncated (раунд 25 + раунд 27)', async () => {
      // Раунд 25: без потолка — счётчик места на диске при распределённом флуде.
      // Раунд 27: тихая обрезка противоречила бы «хранится целиком» из раунда 22 —
      // разрешено флагом: текст обрезан, но это явно видно в самой записи.
      const res = await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Клиент', contact: 'over-text@x.ru', consent: { version: 'v1', text: 'Б'.repeat(25000) } } })
      expect(res.statusCode).toBe(204)
      const row = await app.db.prepare('SELECT text, text_truncated FROM consents WHERE contact_id = 1').get()
      expect(row.text).toHaveLength(20000)
      expect(row.text_truncated).toBe(1)
    })

    it('нестроковые version/text не стрингифицируются вслепую — приравниваются к отсутствующим (раунд 24)', async () => {
      // Независимая проверка: раньше String(consentIn.text ?? '') молча превращал
      // ЛЮБОЙ тип (число, вложенный объект) в текст вроде «[object Object]» —
      // не инъекция (параметризованный INSERT), но бессмысленные данные под видом
      // «сохранено как прислано». Неверный тип теперь = отсутствию поля, как уже
      // было у accepted_at.
      const res = await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Клиент', contact: 'z@x.ru', consent: { version: 12345, text: { evil: 'object' }, accepted_at: '2026-08-01T00:00:00Z' } } })
      expect(res.statusCode).toBe(204)
      const row = await app.db.prepare('SELECT version, text, accepted_at FROM consents WHERE contact_id = 1').get()
      expect(row).toMatchObject({ version: '', text: '', accepted_at: '2026-08-01T00:00:00Z' })
    })

    it('опечатка в ключе внутри consent (acceptedAt вместо accepted_at) не роняет заявку — поле просто отсутствует (раунд 24)', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Клиент', contact: 'y@x.ru', consent: { version: 'v1', text: 'текст', acceptedAt: '2026-08-01T00:00:00Z' } } })
      expect(res.statusCode).toBe(204)
      const row = await app.db.prepare('SELECT version, text, accepted_at FROM consents WHERE contact_id = 1').get()
      expect(row).toMatchObject({ version: 'v1', text: 'текст', accepted_at: null })
    })
  })

  it('CORS: чужой домен не проходит preflight, свой — проходит', async () => {
    await app.db.prepare("UPDATE projects SET origins = 'https://vizor.example.ru' WHERE slug = 'nevarium-vizor'").run()
    const alien = await app.inject({ method: 'OPTIONS', url: '/api/leads', headers: { origin: 'https://evil.example' } })
    expect(alien.statusCode).toBe(403)
    expect(alien.headers['access-control-allow-origin']).toBeUndefined()
    const ours = await app.inject({ method: 'OPTIONS', url: '/api/leads', headers: { origin: 'https://vizor.example.ru' } })
    expect(ours.statusCode).toBe(204)
    expect(ours.headers['access-control-allow-origin']).toBe('https://vizor.example.ru')
  })

  it('CORS preflight разрешает заголовок Idempotency-Key — иначе браузер блокирует реальный запрос сайта', async () => {
    // Codex поймал: сайт шлёт Idempotency-Key заголовком, но preflight разрешал
    // только content-type — браузер отбивал бы запрос ДО POST, идемпотентность
    // для реальных браузерных отправок просто не работала бы.
    await app.db.prepare("UPDATE projects SET origins = 'https://vizor.example.ru' WHERE slug = 'nevarium-vizor'").run()
    const leads = await app.inject({ method: 'OPTIONS', url: '/api/leads', headers: { origin: 'https://vizor.example.ru' } })
    expect(leads.headers['access-control-allow-headers']).toContain('idempotency-key')
    const pd = await app.inject({ method: 'OPTIONS', url: '/api/pd-requests', headers: { origin: 'https://vizor.example.ru' } })
    expect(pd.headers['access-control-allow-headers']).toContain('idempotency-key')
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
    let row = await app.db.prepare('SELECT * FROM outbox WHERE id = 1').get()
    expect(row.tg_attempts).toBe(1)
    expect(row.tg_sent_at).toBeNull()
    // MAX не зависит от Telegram — уже отправлено с первой попытки
    expect(row.max_sent_at).toBeTruthy()
    await worker.tick()
    row = await app.db.prepare('SELECT * FROM outbox WHERE id = 1').get()
    expect(row.tg_sent_at).toBeTruthy()
  })

  it('после 20 попыток запись не берётся в обработку по этому каналу (мёртвая, видна в очереди)', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'm@x.ru' } })
    await app.db.prepare('UPDATE outbox SET tg_attempts = 20 WHERE id = 1').run()
    let tgCalls = 0
    let maxCalls = 0
    const worker = startOutboxWorker(app.db, { senders: { tg: async () => { tgCalls++ }, max: async () => { maxCalls++ } }, log: { warn() {} }, autoStart: false })
    worker.stop()
    await worker.tick()
    expect(tgCalls).toBe(0)
    expect((await app.db.prepare('SELECT tg_sent_at FROM outbox WHERE id = 1').get()).tg_sent_at).toBeNull()
    // MAX не исчерпал попытки — продолжает отправляться
    expect(maxCalls).toBe(1)
    expect((await app.db.prepare('SELECT max_sent_at FROM outbox WHERE id = 1').get()).max_sent_at).toBeTruthy()
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
    const payload = JSON.parse((await app.db.prepare('SELECT payload FROM outbox WHERE id = 1').get()).payload)
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
  it('импорт стирает idempotency_keys — иначе повтор после восстановления молча теряет данные', async () => {
    // Находка Codex: idempotency_keys вне DUMP_TABLES (короткоживущие по смыслу, не
    // бизнес-данные), но если импорт их не чистит, старый ключ переживает восстановление,
    // а запись, на которую он ссылался, — нет. Повтор с этим ключом получил бы
    // закешированный «успех», и сервер НИКОГДА не воссоздал бы пропавшую заявку.
    const payload = { name: 'Марина', contact: 'm@x.ru', request_id: 'req-restore' }
    await app.inject({ method: 'POST', url: '/api/leads', payload })
    expect((await app.db.prepare('SELECT COUNT(*) c FROM idempotency_keys').get()).c).toBe(1)

    const dump = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })).body)
    // катастрофа: контакт возник ПОСЛЕ этого бэкапа, в дампе его нет
    await app.db.query('DELETE FROM deals; DELETE FROM contacts')
    const res = await app.inject({ method: 'POST', url: '/api/crm/import', payload: dump, headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect((await app.db.prepare('SELECT COUNT(*) c FROM idempotency_keys').get()).c).toBe(0)

    // повтор с тем же ключом обязан ЗАНОВО создать заявку, а не молча вернуть 204
    // для записи, которой после восстановления уже нет
    await app.inject({ method: 'POST', url: '/api/leads', payload })
    expect((await app.db.prepare('SELECT COUNT(*) c FROM contacts').get()).c).toBe(1)
  })


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
    expect((await app.db.prepare('SELECT name FROM contacts WHERE id = 1').get()).name).toBe('Иванов')
    expect((await app.db.prepare('SELECT amount FROM deals WHERE id = 1').get()).amount).toBe(777)
    expect((await app.db.prepare('SELECT title FROM tasks WHERE id = 1').get()).title).toBe('Позвонить')
    expect((await app.db.prepare('SELECT note FROM interactions WHERE id = 1').get()).note).toBe('обсудили')
  })

  // На App Platform нет shell — файл базы туда не положить, и «Импорт JSON» остаётся
  // единственным путём восстановления. Всё, чего нет в дампе, при потере диска
  // исчезает навсегда, поэтому записи об исполнении запросов ПДн и журнал обязаны
  // в нём быть: именно ими это исполнение доказывают.
  it('запросы ПДн и журнал действий переживают экспорт → wipe → импорт', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'm@x.ru' } })
    await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'm@x.ru', kind: 'delete', note: 'прошу удалить' } })
    // подтверждение личности — обязательный шаг перед исполнением (pending_unverified)
    await app.inject({ method: 'PATCH', url: '/api/crm/pd-requests/1', payload: { status: 'new' }, headers: { cookie } })
    await app.inject({ method: 'PATCH', url: '/api/crm/pd-requests/1', payload: { status: 'done', anonymize: true }, headers: { cookie } })

    const dump = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })).body)
    expect(dump.version).toBe(DUMP_VERSION)
    expect(dump.pd_requests).toHaveLength(1)
    expect(dump.audit_log.some((a) => a.action === 'anonymize')).toBe(true)

    await app.db.query('DELETE FROM pd_requests; DELETE FROM audit_log')
    const res = await app.inject({ method: 'POST', url: '/api/crm/import', payload: dump, headers: { cookie } })
    expect(res.statusCode).toBe(200)

    const restored = await app.db.prepare('SELECT * FROM pd_requests WHERE id = 1').get()
    expect(restored).toMatchObject({ kind: 'delete', status: 'done', requester: 'm@x.ru', contact_id: 1 })
    expect((await app.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'anonymize'").get()).c).toBe(1)
  })

  it('старый дамп (v1) не стирает сегодняшние записи о ПДн, но рвёт их привязку к контактам', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'm@x.ru' } })
    await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'm@x.ru' } })
    expect((await app.db.prepare('SELECT contact_id FROM pd_requests WHERE id = 1').get()).contact_id).toBe(1)

    // дамп в старом формате: без pd_requests и audit_log
    const dump = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })).body)
    const legacy = { version: 1, contacts: dump.contacts, deals: dump.deals, tasks: dump.tasks, interactions: dump.interactions }
    const res = await app.inject({ method: 'POST', url: '/api/crm/import', payload: legacy, headers: { cookie } })
    expect(res.statusCode).toBe(200)

    // запрос жив — это юридический след, стирать его старым файлом нельзя
    const row = await app.db.prepare('SELECT * FROM pd_requests WHERE id = 1').get()
    expect(row.requester).toBe('m@x.ru')
    // но привязку разорвали: контакты заменены целиком, id мог достаться другому человеку
    expect(row.contact_id).toBeNull()
  })

  it('дамп с pd_requests, но БЕЗ verified_at (снят до этой сессии): закрытые/ручные верифицируются задним числом, открытый публичный — в pending_unverified', async () => {
    // Codex поймал ДВЕ ошибки подряд на этом пути: (раунд 9) без бэкфилла вообще
    // восстановленный открытый запрос оставался бы неисполнимым навсегда; (раунд 15)
    // мой первый бэкфилл верифицировал ВСЁ подряд, включая открытые публичные запросы,
    // которые НИКОГДА не проходили верификацию — та же дыра для имперсонации, ради
    // закрытия которой verified_at появился. Правильно: закрытым (гейт больше ничего
    // не решает) и ручным (пред-верифицированы по построению) — верифицировать задним
    // числом можно; открытому публичному — нет, только pending_unverified.
    await app.inject({ method: 'POST', url: '/api/crm/pd-requests', payload: { requester: 'manual@x.ru', kind: 'delete' }, headers: { cookie } }) // id 1: ручной
    await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'closed@x.ru', kind: 'delete' } }) // id 2: публичный
    await app.inject({ method: 'PATCH', url: '/api/crm/pd-requests/2', payload: { status: 'rejected' }, headers: { cookie } }) // закрыт без верификации — это ОК для rejected
    await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'open@x.ru', kind: 'delete' } }) // id 3: публичный, открыт

    const dump = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })).body)
    // симулируем бэкап ДО этой сессии: у pd_requests не было verified_at вообще
    dump.pd_requests = dump.pd_requests.map(({ verified_at, ...rest }) => rest)

    const res = await app.inject({ method: 'POST', url: '/api/crm/import', payload: dump, headers: { cookie } })
    expect(res.statusCode).toBe(200)

    const manual = await app.db.prepare('SELECT status, verified_at FROM pd_requests WHERE id = 1').get()
    expect(manual.verified_at).toBeTruthy()

    const closedSite = await app.db.prepare('SELECT status, verified_at FROM pd_requests WHERE id = 2').get()
    expect(closedSite).toMatchObject({ status: 'rejected' })
    expect(closedSite.verified_at).toBeTruthy()

    const openSite = await app.db.prepare('SELECT status, verified_at FROM pd_requests WHERE id = 3').get()
    expect(openSite.status).toBe('pending_unverified')
    expect(openSite.verified_at).toBeNull()
  })

  it('актуальный дамп с ЗАКОННЫМ null у verified_at НЕ бэкфиллится — иначе восстановление обходит верификацию', async () => {
    // Codex поймал регресс в предыдущем фикс: безусловный бэкфилл по «verified_at IS
    // NULL» путал «поля не было в старом дампе» с «поле было и было null» — второе
    // значит по-настоящему неподтверждённый (pending_unverified) запрос из АКТУАЛЬНОГО
    // дампа. После такого восстановления сотрудник мог бы обезличить контакт без
    // подтверждения личности — ровно та дыра, ради которой verified_at и появился.
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'm@x.ru' } })
    await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'm@x.ru', kind: 'delete' } })
    // НЕ верифицируем — остаётся pending_unverified, verified_at честно null
    const dump = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })).body)
    expect(dump.pd_requests[0]).toHaveProperty('verified_at', null) // ключ ЕСТЬ, значение null

    const res = await app.inject({ method: 'POST', url: '/api/crm/import', payload: dump, headers: { cookie } })
    expect(res.statusCode).toBe(200)
    const row = await app.db.prepare('SELECT status, verified_at FROM pd_requests WHERE id = 1').get()
    expect(row.status).toBe('pending_unverified')
    expect(row.verified_at).toBeNull()

    // и попытка обезличить без подтверждения по-прежнему блокируется после восстановления
    const anonymize = await app.inject({ method: 'PATCH', url: '/api/crm/pd-requests/1', payload: { anonymize: true }, headers: { cookie } })
    expect(anonymize.statusCode).toBe(400)
    expect(JSON.parse(anonymize.body).error).toBe('not_verified')
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
    expect((await app.db.prepare('SELECT COUNT(*) c FROM tasks WHERE winback_sequence_id IS NOT NULL').get()).c).toBe(3)

    const dump = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })).body)
    const res = await app.inject({ method: 'POST', url: '/api/crm/import', payload: dump, headers: { cookie } })
    expect(res.statusCode).toBe(200)
    // признак обезличивания сохранился — восстановление не «расконсервирует» человека
    expect((await app.db.prepare('SELECT name, anonymized_at FROM contacts WHERE id = 2').get()).anonymized_at).toBeTruthy()
    // задачи серии на месте, но ссылка на серию обнулена: самих серий в дампе нет
    expect((await app.db.prepare('SELECT COUNT(*) c FROM tasks').get()).c).toBe(3)
    expect((await app.db.prepare('SELECT COUNT(*) c FROM tasks WHERE winback_sequence_id IS NOT NULL').get()).c).toBe(0)
  })

  // pg-mem (движок тестов, не настоящий Postgres) — ОГРАНИЧЕНИЕ ЭМУЛЯТОРА, уже
  // задокументированное в HANDOFF.md при переводе на pg (план в nevarium-lab#3):
  // BEGIN/COMMIT/ROLLBACK парсятся и «выполняются» без ошибки, но не дают реальной
  // изоляции — вставка/удаление внутри транзакции, которую откатили, остаётся
  // закоммиченной. Оба теста ниже проверяют именно атомарность отката: код и логика
  // withTransaction/ROLLBACK на стороне приложения корректны (подтверждено: код
  // ответа 400 приходит правильно — сама ошибка распознаётся и транзакция честно
  // пытается откатиться), но проверить реальный откат под pg-mem нельзя технически.
  // Обязательный ручной прогон на настоящей Timeweb-базе перед первым продакшен-
  // деплоем (уже в критериях готовности ТЗ, Этап 4 плана переезда) должен включать
  // ИМЕННО эти два сценария.
  itPg('битый файл отклоняется атомарно (требует настоящего Postgres — см. комментарий выше)', async () => {
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Живой' }, headers: { cookie } })
    const res = await app.inject({ method: 'POST', url: '/api/crm/import', payload: { version: 1, contacts: [{ nonsense: true }] }, headers: { cookie } })
    expect(res.statusCode).toBe(400)
    // старые данные не тронуты
    expect((await app.db.prepare('SELECT COUNT(*) c FROM contacts').get()).c).toBe(1)
  })

  it('файл новее версии приложения отклоняется', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/crm/import', payload: { version: 99, contacts: [] }, headers: { cookie } })
    expect(JSON.parse(res.body).error).toBe('newer_version')
  })

  // Тот же pg-mem-предел атомарности отката, что и у теста выше — см. комментарий там.
  itPg('импорт с чужеродным именем колонки отклоняется (не SQL-инъекция) (требует настоящего Postgres)', async () => {
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Живой' }, headers: { cookie } })
    const res = await app.inject({ method: 'POST', url: '/api/crm/import', payload: { version: 1, contacts: [{ 'name) VALUES (1); DROP TABLE contacts; --': 'x', name: 'Злой' }] }, headers: { cookie } })
    expect(res.statusCode).toBe(400)
    expect((await app.db.prepare('SELECT COUNT(*) c FROM contacts').get()).c).toBe(1)
  })

  it('CSV нейтрализует формулы из публичных лидов (=/+/-/@)', async () => {
    // имя приходит с публичного endpoint — Excel исполнил бы =HYPERLINK(...)
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: '=HYPERLINK("http://evil")', contact: 'e@x.ru' } })
    const csv = (await app.inject({ method: 'GET', url: '/api/crm/contacts.csv', headers: { cookie } })).body
    expect(csv).toContain("'=HYPERLINK")
    expect(csv).not.toMatch(/(^|;|")=HYPERLINK/)
  })

  it('демо-данные ВХОДЯТ в экспорт (иначе дамп невосстановим); CSV их не показывает', async () => {
    // ПОВЕДЕНИЕ ИЗМЕНЕНО ОСОЗНАННО. Раньше дамп отсеивал demo-строки, и в SQLite это
    // было безобидно — внешних ключей не было. В Postgres deals.contact_id и
    // interactions.contact_id это NOT NULL REFERENCES contacts(id), а завести НЕ демо-
    // сделку на демо-контакте можно обычным интерфейсом (демо-контакты видны в общем
    // списке, обработчик создания колонку demo не ставит). Такой ребёнок уезжал в дамп
    // без родителя, и импорт этого же файла падал на внешнем ключе — ночной бэкап был
    // невосстановим, и выяснялось это только в аварии. Отсеивать заодно и детей значило
    // бы молча терять НАСТОЯЩУЮ сделку, поэтому demo-строки теперь просто входят в дамп:
    // они помечены demo = 1, и кнопка «Удалить демо-данные» работает после импорта.
    // CSV — отдельный путь, он по-прежнему демо не показывает: это витрина, не бэкап.
    await app.inject({ method: 'POST', url: '/api/crm/demo-seed', headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'ООО "Ромашка"; и точка' }, headers: { cookie } })
    const dump = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })).body)
    expect(dump.contacts.length).toBeGreaterThan(1)
    expect(dump.contacts.some((c) => c.demo === 1 || c.demo === true)).toBe(true)
    expect(dump.contacts.some((c) => c.name === 'ООО "Ромашка"; и точка')).toBe(true)
    const csv = (await app.inject({ method: 'GET', url: '/api/crm/contacts.csv', headers: { cookie } })).body
    expect(csv).toContain('"ООО ""Ромашка""; и точка"')
    // демо-контактов в CSV нет
    expect(csv).not.toContain('Балтика')
  })

  it('дамп с НЕ демо-сделкой на демо-контакте импортируется (внешний ключ цел)', async () => {
    // Ровно тот сценарий, который делал бэкап невосстановимым: демо-контакт виден в
    // общем списке, сотрудник заводит на нём настоящую сделку. Проверено независимым
    // ревью на живой базе — до правки импорт падал с 400 bad_file на FK.
    await app.inject({ method: 'POST', url: '/api/crm/demo-seed', headers: { cookie } })
    const demoContact = await app.db.prepare('SELECT id FROM contacts WHERE demo = 1 ORDER BY id LIMIT 1').get()
    expect(demoContact, 'демо-контакт не создался').toBeTruthy()
    const deal = await app.inject({
      method: 'POST', url: '/api/crm/deals',
      payload: { contact_id: demoContact.id, title: 'Настоящая сделка на демо-контакте' }, headers: { cookie },
    })
    expect(deal.statusCode).toBe(200)

    const dump = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })).body)
    const ids = new Set(dump.contacts.map((c) => c.id))
    expect(dump.deals.every((d) => ids.has(d.contact_id)), 'в дампе сделка без своего контакта').toBe(true)
    const imp = await app.inject({ method: 'POST', url: '/api/crm/import', payload: dump, headers: { cookie } })
    expect(imp.statusCode, `импорт своего же дампа: ${imp.body}`).toBe(200)
  })

  it('очистка демо удаляет только помеченные записи', async () => {
    await app.inject({ method: 'POST', url: '/api/crm/demo-seed', headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Настоящий' }, headers: { cookie } })
    await app.inject({ method: 'DELETE', url: '/api/crm/demo', headers: { cookie } })
    const rows = await app.db.prepare('SELECT name FROM contacts').all()
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
    const age = async (table, id, daysAgo) =>
      app.db.prepare(`UPDATE ${table} SET created_at = ? WHERE id = ?`)
        .run(new Date(Date.now() - daysAgo * 864e5).toISOString(), id)

    const cooling = async () =>
      JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/dashboard', headers: { cookie } })).body).cooling

    it('сделка без единого взаимодействия попадает в блок, свежая — нет', async () => {
      await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Забытый' }, headers: { cookie } })
      await app.inject({ method: 'POST', url: '/api/crm/deals', payload: { contact_id: 1, title: 'Тихая' }, headers: { cookie } })
      await age('deals', 1, 5)
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
      await age('deals', 1, 5)
      expect((await cooling())).toHaveLength(1)
      await app.inject({ method: 'POST', url: '/api/crm/interactions', payload: { contact_id: 1, type: 'звонок', note: 'связались' }, headers: { cookie } })
      expect((await cooling())).toHaveLength(0)
    })

    it('открытая задача означает «договорились» — сделка не остывает, закрытая не спасает', async () => {
      await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Клиент' }, headers: { cookie } })
      await app.inject({ method: 'POST', url: '/api/crm/deals', payload: { contact_id: 1, title: 'Сделка' }, headers: { cookie } })
      await age('deals', 1, 5)
      await app.inject({ method: 'POST', url: '/api/crm/tasks', payload: { title: 'Позвонить в среду', contact_id: 1 }, headers: { cookie } })
      expect((await cooling())).toHaveLength(0)
      await app.inject({ method: 'PATCH', url: '/api/crm/tasks/1', payload: { done: 1 }, headers: { cookie } })
      expect((await cooling())).toHaveLength(1)
    })

    it('закрытые и обезличенные в блок не попадают', async () => {
      await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Выигранный' }, headers: { cookie } })
      await app.inject({ method: 'POST', url: '/api/crm/deals', payload: { contact_id: 1, title: 'Оплаченная' }, headers: { cookie } })
      await app.inject({ method: 'PATCH', url: '/api/crm/deals/1', payload: { stage: 'Оплачено' }, headers: { cookie } })
      await age('deals', 1, 5)

      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Ушедший', contact: 'u@x.ru' } })
      await age('deals', 2, 5)
      await app.inject({ method: 'POST', url: '/api/crm/contacts/2/anonymize', headers: { cookie } })

      expect((await cooling())).toHaveLength(0)
    })

    it('блок уважает фильтр по проекту', async () => {
      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Лаб', contact: 'l@x.ru', project: 'nevarium1' } })
      await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Визор', contact: 'v@x.ru', project: 'nevarium-vizor' } })
      await age('deals', 1, 5)
      await age('deals', 2, 5)
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

  it('PATCH и DELETE несуществующего пользователя — 404, а не молчаливый ok', async () => {
    // Без проверки существования оба отвечали {ok:true} и писали в журнал, не изменив
    // ничего: 0 задетых строк неотличимы от успеха, а админ считал доступ отозванным.
    // Проверка в асинхронном коде обязана быть под await — на промисе if (!x) не сработает
    // никогда, и этот тест — единственное, что поймает такую регрессию при слиянии.
    const patch = await app.inject({ method: 'PATCH', url: '/api/crm/users/999', payload: { name: 'Никто' }, headers: { cookie } })
    expect(patch.statusCode).toBe(404)
    const del = await app.inject({ method: 'DELETE', url: '/api/crm/users/999', headers: { cookie } })
    expect(del.statusCode).toBe(404)
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

    const seq = await app.db.prepare('SELECT * FROM winback_sequences').get()
    expect(seq).toMatchObject({ deal_id: id, contact_id: 1, reason: 'дорого', status: 'active' })

    const tasks = await app.db.prepare('SELECT * FROM tasks WHERE winback_sequence_id = ? ORDER BY due_date').all(seq.id)
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
    const seqId = (await app.db.prepare('SELECT id FROM winback_sequences').get()).id
    // менеджер успел закрыть первую задачу до возврата сделки
    const firstTask = await app.db.prepare('SELECT id FROM tasks WHERE winback_sequence_id = ? ORDER BY due_date').get(seqId)
    await app.inject({ method: 'PATCH', url: `/api/crm/tasks/${firstTask.id}`, payload: { done: 1 }, headers: { cookie } })

    const res = await toStage(id, 'Переговоры')
    expect(JSON.parse(res.body).winback).toMatchObject({ cancelled: true, tasks: 2 })

    const left = await app.db.prepare('SELECT * FROM tasks WHERE winback_sequence_id = ?').all(seqId)
    expect(left).toHaveLength(1) // осталась только выполненная — это история работы
    expect(left[0].done).toBe(1)
    expect((await app.db.prepare('SELECT status FROM winback_sequences WHERE id = ?').get(seqId)).status).toBe('cancelled')
  })

  it('повторный перевод в «Проиграно» не плодит дубли задач', async () => {
    const id = await makeDeal()
    await toStage(id, 'Проиграно')
    await toStage(id, 'Проиграно') // тот же статус — смены стадии нет
    expect((await app.db.prepare('SELECT COUNT(*) c FROM winback_sequences').get()).c).toBe(1)
    expect((await app.db.prepare('SELECT COUNT(*) c FROM tasks WHERE winback_sequence_id IS NOT NULL').get()).c).toBe(3)
  })

  it('другие терминальные стадии воронку не запускают', async () => {
    const id = await makeDeal()
    const res = await toStage(id, 'Оплачено')
    expect(JSON.parse(res.body).winback).toBeNull()
    expect((await app.db.prepare('SELECT COUNT(*) c FROM winback_sequences').get()).c).toBe(0)
  })

  it('удаление сделки с воронкой не падает и убирает её задачи', async () => {
    const id = await makeDeal()
    await toStage(id, 'Проиграно')
    const del = await app.inject({ method: 'DELETE', url: `/api/crm/deals/${id}`, headers: { cookie } })
    expect(del.statusCode).toBe(200)
    expect((await app.db.prepare('SELECT COUNT(*) c FROM winback_sequences').get()).c).toBe(0)
    expect((await app.db.prepare('SELECT COUNT(*) c FROM tasks WHERE winback_sequence_id IS NOT NULL').get()).c).toBe(0)
  })

  it('обычные задачи серией не помечены и живут своей жизнью', async () => {
    const id = await makeDeal()
    await app.inject({ method: 'POST', url: '/api/crm/tasks', payload: { title: 'Обычная задача', contact_id: 1 }, headers: { cookie } })
    await toStage(id, 'Проиграно')
    await toStage(id, 'Контакт') // отмена серии не должна задеть обычную задачу
    const plain = await app.db.prepare("SELECT * FROM tasks WHERE title = 'Обычная задача'").get()
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
    await app.db.query('DELETE FROM users') // beforeEach уже создал тестового пользователя
    const env = { BOOTSTRAP_ADMIN_EMAIL: 'Boss@Example.ru', BOOTSTRAP_ADMIN_PASSWORD: 'supersecret12345' }
    const created = await bootstrapAdmin(app.db, { log: silent, env })
    expect(created).toBe(true)
    const user = await app.db.prepare('SELECT * FROM users WHERE email = ?').get('boss@example.ru')
    expect(user).toMatchObject({ role: 'admin', name: 'Админ' })
    expect(await verifyPassword('supersecret12345', user.password_hash)).toBe(true)
  })

  it('не трогает базу, если пользователи уже есть', async () => {
    const before = (await app.db.prepare('SELECT COUNT(*) c FROM users').get()).c
    const created = await bootstrapAdmin(app.db, {
      log: silent,
      env: { BOOTSTRAP_ADMIN_EMAIL: 'x@x.ru', BOOTSTRAP_ADMIN_PASSWORD: 'supersecret12345' },
    })
    expect(created).toBe(false)
    expect((await app.db.prepare('SELECT COUNT(*) c FROM users').get()).c).toBe(before)
  })

  it('слишком короткий пароль — админ не создаётся', async () => {
    await app.db.query('DELETE FROM users')
    const created = await bootstrapAdmin(app.db, {
      log: silent,
      env: { BOOTSTRAP_ADMIN_EMAIL: 'x@x.ru', BOOTSTRAP_ADMIN_PASSWORD: 'short' },
    })
    expect(created).toBe(false)
    expect((await app.db.prepare('SELECT COUNT(*) c FROM users').get()).c).toBe(0)
  })

  it('ровно 15 символов — отказ, ровно 16 — создаётся (граница MIN_ADMIN_PASSWORD_LENGTH)', async () => {
    await app.db.query('DELETE FROM users')
    const pass15 = 'a'.repeat(15)
    const pass16 = 'a'.repeat(16)
    expect(pass15).toHaveLength(15)
    expect(pass16).toHaveLength(16)
    const rejected = await bootstrapAdmin(app.db, { log: silent, env: { BOOTSTRAP_ADMIN_EMAIL: 'x@x.ru', BOOTSTRAP_ADMIN_PASSWORD: pass15 } })
    expect(rejected).toBe(false)
    const accepted = await bootstrapAdmin(app.db, { log: silent, env: { BOOTSTRAP_ADMIN_EMAIL: 'x@x.ru', BOOTSTRAP_ADMIN_PASSWORD: pass16 } })
    expect(accepted).toBe(true)
  })
})

describe('минимальная длина пароля по роли (MIN_ADMIN_PASSWORD_LENGTH = 16)', () => {
  // Порог у bootstrap — не единственная дверь для создания админа: /api/crm/users
  // с role=admin и смена пароля существующему админу обязаны требовать то же самое,
  // иначе минимум обходится через создание слабого админа в самом интерфейсе.
  it('создание нового пользователя с role=admin требует 16 символов, participant — только 8', async () => {
    const weakAdmin = await app.inject({ method: 'POST', url: '/api/crm/users', payload: { name: 'Х', email: 'weak-admin@x.ru', password: 'short123', role: 'admin' }, headers: { cookie } })
    expect(weakAdmin.statusCode).toBe(400)
    const okAdmin = await app.inject({ method: 'POST', url: '/api/crm/users', payload: { name: 'Х', email: 'ok-admin@x.ru', password: 'supersecret12345', role: 'admin' }, headers: { cookie } })
    expect(okAdmin.statusCode).toBe(200)
    const okMember = await app.inject({ method: 'POST', url: '/api/crm/users', payload: { name: 'Y', email: 'ok-member@x.ru', password: 'short123', role: 'member' }, headers: { cookie } })
    expect(okMember.statusCode).toBe(200)
  })

  it('смена пароля существующему админу требует 16 символов — по роли ЦЕЛИ, не инициатора', async () => {
    // Пользователь 1 (из beforeEach) — admin
    const weak = await app.inject({ method: 'PATCH', url: '/api/crm/users/1', payload: { password: 'short123' }, headers: { cookie } })
    expect(weak.statusCode).toBe(400)
    const strong = await app.inject({ method: 'PATCH', url: '/api/crm/users/1', payload: { password: 'supersecret12345' }, headers: { cookie } })
    expect(strong.statusCode).toBe(200)
  })

  it('невалидный пароль в PATCH не должен успевать сохранить имя — раньше запись была частичной', async () => {
    // Codex поймал: имя писалось в БД ДО проверки длины пароля, поэтому запрос с
    // новым именем и слабым паролем возвращал 400, но имя всё равно менялось —
    // ответ «ничего не сохранено» не соответствовал реальности.
    const before = await app.inject({ method: 'GET', url: '/api/crm/users', headers: { cookie } })
    const nameBefore = JSON.parse(before.body).items.find((u) => u.id === 1).name
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/crm/users/1',
      payload: { name: 'Новое Имя', password: 'short123' },
      headers: { cookie },
    })
    expect(res.statusCode).toBe(400)
    const after = await app.inject({ method: 'GET', url: '/api/crm/users', headers: { cookie } })
    const nameAfter = JSON.parse(after.body).items.find((u) => u.id === 1).name
    expect(nameAfter).toBe(nameBefore)
  })

  it('PATCH с нестроковым password не проходит проверку длины молча — тоже не должен писать имя', async () => {
    // Codex отдельно отметил: password.length у нестроковых значений — undefined,
    // а undefined < minLen ложно, так что проверка молча пропускала бы такой запрос
    // без явного typeof-контроля.
    const before = await app.inject({ method: 'GET', url: '/api/crm/users', headers: { cookie } })
    const nameBefore = JSON.parse(before.body).items.find((u) => u.id === 1).name
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/crm/users/1',
      payload: { name: 'Другое Имя', password: 12345678901234567 },
      headers: { cookie },
    })
    expect(res.statusCode).toBe(400)
    const after = await app.inject({ method: 'GET', url: '/api/crm/users', headers: { cookie } })
    expect(JSON.parse(after.body).items.find((u) => u.id === 1).name).toBe(nameBefore)
  })

  it('смена пароля участнику по-прежнему принимает 8 символов', async () => {
    await app.inject({ method: 'POST', url: '/api/crm/users', payload: { name: 'Y', email: 'member2@x.ru', password: 'password123', role: 'member' }, headers: { cookie } })
    const res = await app.inject({ method: 'PATCH', url: '/api/crm/users/2', payload: { password: 'short123' }, headers: { cookie } })
    expect(res.statusCode).toBe(200)
  })

  it('seed-admin.js (четвёртый путь создания админа) тоже требует 16 символов', () => {
    // Независимый аудит поймал: этот путь остался на пороге 8, хотя bootstrap.js,
    // POST /api/crm/users (role=admin) и PATCH уже требовали 16 — единственный
    // интерактивный скрипт создания первого админа оставался лазейкой.
    expect(validSeedInput('Админ', 'a@a.ru', 'a'.repeat(15))).toBe(false)
    expect(validSeedInput('Админ', 'a@a.ru', 'a'.repeat(16))).toBe(true)
    expect(validSeedInput('', 'a@a.ru', 'a'.repeat(20))).toBe(false)
    expect(validSeedInput('Админ', 'не-email', 'a'.repeat(20))).toBe(false)
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
    const row = await app.db.prepare('SELECT * FROM pd_requests WHERE id = 1').get()
    // pending_unverified, не new: публичная форма не подтверждает, что запрос
    // прислал сам владелец данных (ТЗ сайта §1.4, сценарий атаки — чужой email/
    // телефон + kind=delete). Сотрудник обязан подтвердить личность и перевести
    // статус дальше, прежде чем запрос можно исполнить.
    expect(row).toMatchObject({ contact_id: 1, kind: 'delete', status: 'pending_unverified', source: 'site-form' })
    expect(row.due_date).toBe(addWorkdays(mskToday()))
  })

  it('honeypot на /api/pd-requests НЕ отбрасывает запрос — потерянный запрос по ПДн это просроченный юридический срок', async () => {
    // Асимметрия с лидами (Codex поймал): у лидов honeypot — молчаливый дроп (ниже
    // риск, спам засоряет инбокс), но у запроса по ПДн цена ложного срабатывания
    // категорически выше — просроченное обязательство без единого следа, при этом
    // отправителю показан «успех». Здесь — как было до этой сессии: помечаем, не теряем.
    const res = await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'bot@x.ru', kind: 'delete', website: 'spam.com' } })
    expect(res.statusCode).toBe(204)
    const row = await app.db.prepare('SELECT note FROM pd_requests WHERE id = 1').get()
    expect(row).toBeTruthy()
    expect(row.note).toContain('подозрительная отправка')
    expect((await app.db.prepare('SELECT COUNT(*) c FROM outbox').get()).c).toBe(1)
  })

  it('Idempotency-Key на /api/pd-requests: повтор не заводит второй запрос — второй 10-дневный срок не открывается', async () => {
    const payload = { contact: 'marina@x.ru', kind: 'delete' }
    const headers = { 'idempotency-key': 'pd-req-1' }
    await app.inject({ method: 'POST', url: '/api/pd-requests', payload, headers })
    await app.inject({ method: 'POST', url: '/api/pd-requests', payload, headers })
    expect((await app.db.prepare('SELECT COUNT(*) c FROM pd_requests').get()).c).toBe(1)
  })

  it('нераспознанный kind сохраняется как прислан, не подменяется другим смыслом', async () => {
    // Codex дважды поймал одну и ту же ошибку с разных сторон: молчаливый ремап
    // ЛЮБОГО нераспознанного kind (что на 'delete', что на 'access') подменяет
    // юридический смысл запроса без следа. Правильно — сохранить сырое значение и
    // оставить видимым для ручной классификации сотрудником.
    const res = await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'x@x.ru', kind: 'bogus' } })
    expect(res.statusCode).toBe(204)
    expect((await app.db.prepare('SELECT kind FROM pd_requests WHERE id = 1').get()).kind).toBe('bogus')
  })

  it('ПОЛНОСТЬЮ опущенный kind по-прежнему «удалить» — обратная совместимость с уже развёрнутым сайтом', async () => {
    // Codex поймал: если опущенное поле тоже понижать до «access», уже работающий
    // клиент (сайт), который его не передаёт, тихо получает другой смысл запроса —
    // «удалить» бесследно становится «узнать». Отличать от явно нераспознанного kind.
    const res = await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'x2@x.ru' } })
    expect(res.statusCode).toBe(204)
    expect((await app.db.prepare('SELECT kind FROM pd_requests WHERE id = 1').get()).kind).toBe('delete')
  })

  it('запрос по ПДн не сопоставляется с контактом из ЧУЖОГО проекта по совпавшему email', async () => {
    // Codex поймал: поиск клиента по email/телефону не учитывал project_id — тот же
    // адрес в Лаб ИИ и Визоре (разных бизнесах) мог склеить чужого человека, и через
    // workflow верификации это давало бы «подтверждённое» обезличивание не того контакта.
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Чужой', contact: 'shared@x.ru', project: 'nevarium1' } })
    const res = await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'shared@x.ru', kind: 'delete', project: 'nevarium-vizor' } })
    expect(res.statusCode).toBe(204)
    const row = await app.db.prepare('SELECT contact_id, project_id FROM pd_requests WHERE id = 1').get()
    expect(row.project_id).toBe(2) // nevarium-vizor
    expect(row.contact_id).toBeNull() // контакт с этим email — в ДРУГОМ проекте, не сопоставлен
  })

  it('нераспознанный kind экранируется в уведомлении — публичный ввод не ломает HTML-разметку Telegram/MAX', async () => {
    // Codex поймал: kind теперь сохраняется как прислано (см. тест выше) и попадает
    // в текст уведомления с format:'html' — без экранирования сломанная разметка
    // могла бы уронить доставку staff-уведомления навсегда, пока идёт срок по 152-ФЗ.
    const res = await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'x@x.ru', kind: '<b>evil</b>&broken' } })
    expect(res.statusCode).toBe(204)
    const payload = JSON.parse((await app.db.prepare("SELECT payload FROM outbox WHERE kind = 'text' ORDER BY id DESC LIMIT 1").get()).payload)
    expect(payload.text).toContain('&lt;b&gt;evil&lt;/b&gt;&amp;broken')
    expect(payload.text).not.toContain('<b>evil</b>')
  })

  it('незнакомый адрес не теряется — запрос заводится без привязки к контакту', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'кто-то@ещё.ru' } })
    expect(res.statusCode).toBe(204)
    expect((await app.db.prepare('SELECT contact_id FROM pd_requests WHERE id = 1').get()).contact_id).toBeNull()
  })

  it('уведомление о запросе обезличено для обоих каналов', async () => {
    await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'marina@secret.ru', note: 'прошу удалить всё' } })
    const payload = JSON.parse((await app.db.prepare("SELECT payload FROM outbox WHERE kind = 'text' ORDER BY id DESC LIMIT 1").get()).payload)
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
      payload: { name: 'Марина Соколова', contact: '+7 921 555-14-88', task: 'внедрение ИИ', note: 'звонить после 18', transcript: 'Клиент: меня зовут Марина, телефон 555-14-88', source: 'chat', consent: { version: 'v1', text: 'текст политики', accepted_at: '2026-08-01T00:00:00Z' } },
    })
    await app.db.prepare("INSERT INTO tasks (title, contact_id, created_at, updated_at) VALUES ('Позвонить Марине', 1, ?, ?)").run(now(), now())
    const res = await app.inject({ method: 'POST', url: '/api/crm/contacts/1/anonymize', headers: { cookie } })
    expect(res.statusCode).toBe(200)

    const contact = await app.db.prepare('SELECT * FROM contacts WHERE id = 1').get()
    expect(contact.name).toBe('Удалённый контакт #1')
    expect([contact.phone, contact.email, contact.messenger, contact.note]).toEqual(['', '', '', ''])
    expect(contact.anonymized_at).toBeTruthy()

    // сделка на месте — воронка за прошлые периоды не поехала
    const deal = await app.db.prepare('SELECT * FROM deals WHERE contact_id = 1').get()
    expect(deal.stage).toBe('Новый')
    expect(deal.note).toBe('')
    // транскрипт затёрт, но строка взаимодействия осталась для статистики активности
    const inter = await app.db.prepare('SELECT * FROM interactions WHERE contact_id = 1').get()
    expect(inter.note).toBe('')
    // задачи удалены: обработку требовали прекратить
    expect((await app.db.prepare('SELECT COUNT(*) c FROM tasks WHERE contact_id = 1').get()).c).toBe(0)
    // слепок согласия: requester, version, text, accepted_at — всё затёрто (раунд 20
    // затирал только requester; раунд 23 указал, что version/text — тоже свободный
    // текст с публичного эндпоинта, недоказуемо свободный от ПДн). Строка жива.
    const consent = await app.db.prepare('SELECT * FROM consents WHERE contact_id = 1').get()
    expect(consent).toMatchObject({ requester: '', version: '', text: '', text_truncated: 0, accepted_at: null })
    // и всё это попало в журнал
    expect((await app.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'anonymize'").get()).c).toBe(1)
  })

  it('обезличивание отменяет активную воронку возврата', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Пётр', contact: 'p@x.ru' } })
    await app.inject({ method: 'PATCH', url: '/api/crm/deals/1', payload: { stage: 'Проиграно', reason: 'дорого' }, headers: { cookie } })
    expect((await app.db.prepare("SELECT COUNT(*) c FROM winback_sequences WHERE status = 'active'").get()).c).toBe(1)
    await app.inject({ method: 'POST', url: '/api/crm/contacts/1/anonymize', headers: { cookie } })
    expect((await app.db.prepare("SELECT status FROM winback_sequences WHERE id = 1").get()).status).toBe('cancelled')
    expect((await app.db.prepare('SELECT COUNT(*) c FROM tasks WHERE contact_id = 1').get()).c).toBe(0)
  })

  it('повторное обезличивание безвредно и не портит заглушку', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'm@x.ru' } })
    await app.inject({ method: 'POST', url: '/api/crm/contacts/1/anonymize', headers: { cookie } })
    const first = (await app.db.prepare('SELECT anonymized_at FROM contacts WHERE id = 1').get()).anonymized_at
    const res = await app.inject({ method: 'POST', url: '/api/crm/contacts/1/anonymize', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(await app.db.prepare('SELECT name, anonymized_at FROM contacts WHERE id = 1').get())
      .toEqual({ name: 'Удалённый контакт #1', anonymized_at: first })
  })

  it('запрос с сайта нельзя исполнить без подтверждения личности', async () => {
    // Находка ТЗ сайта (§1.4): атакующий, знающий чужой email/телефон, может сам
    // отправить kind=delete через форму. pending_unverified блокирует исполнение,
    // пока сотрудник не подтвердит личность по контакту ИЗ КАРТОЧКИ в CRM.
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'marina@x.ru' } })
    await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'marina@x.ru' } })
    const done = await app.inject({ method: 'PATCH', url: '/api/crm/pd-requests/1', payload: { status: 'done' }, headers: { cookie } })
    expect(done.statusCode).toBe(400)
    expect(JSON.parse(done.body).error).toBe('not_verified')
    const anonymize = await app.inject({ method: 'PATCH', url: '/api/crm/pd-requests/1', payload: { anonymize: true }, headers: { cookie } })
    expect(anonymize.statusCode).toBe(400)
    expect(JSON.parse(anonymize.body).error).toBe('not_verified')
    expect((await app.db.prepare('SELECT anonymized_at FROM contacts WHERE id = 1').get()).anonymized_at).toBeNull()
  })

  it('нельзя подтвердить личность и исполнить одним PATCH — {status:"new", anonymize:true} обязан провалиться', async () => {
    // Находка Codex: если проверять статус ПОСЛЕ его же обновления в том же запросе,
    // {status:'new', anonymize:true} одним вызовом «подтверждает» и тут же исполняет —
    // весь смысл раздельного человеческого шага верификации исчезает.
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'marina@x.ru' } })
    await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'marina@x.ru', kind: 'delete' } })
    const res = await app.inject({ method: 'PATCH', url: '/api/crm/pd-requests/1', payload: { status: 'new', anonymize: true }, headers: { cookie } })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('not_verified')
    expect((await app.db.prepare('SELECT anonymized_at FROM contacts WHERE id = 1').get()).anonymized_at).toBeNull()
    // статус тоже не должен был обновиться — весь PATCH проваливается, не только anonymize
    expect((await app.db.prepare('SELECT status FROM pd_requests WHERE id = 1').get()).status).toBe('pending_unverified')
  })

  it('нельзя «подтвердить личность» у запроса без сопоставленного контакта', async () => {
    // Codex поймал: подтверждать личность полагается по каналу ИЗ КАРТОЧКИ в CRM —
    // без contact_id такой карточки нет, сотруднику нечем было бы сверяться.
    const res = await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'неизвестный@нигде.ru', kind: 'delete' } })
    expect(res.statusCode).toBe(204)
    expect((await app.db.prepare('SELECT contact_id FROM pd_requests WHERE id = 1').get()).contact_id).toBeNull()
    const verify = await app.inject({ method: 'PATCH', url: '/api/crm/pd-requests/1', payload: { status: 'new' }, headers: { cookie } })
    expect(verify.statusCode).toBe(400)
    expect(JSON.parse(verify.body).error).toBe('no_contact')
    expect((await app.db.prepare('SELECT status FROM pd_requests WHERE id = 1').get()).status).toBe('pending_unverified')

    // но привязать контакт и ТУТ ЖЕ подтвердить — можно: contactId в этом же запросе
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Найден', contact: 'позже@нашли.ru' } })
    const verifyWithLink = await app.inject({
      method: 'PATCH',
      url: '/api/crm/pd-requests/1',
      payload: { contact_id: 1, status: 'new' },
      headers: { cookie },
    })
    expect(verifyWithLink.statusCode).toBe(200)
    expect((await app.db.prepare('SELECT status FROM pd_requests WHERE id = 1').get()).status).toBe('new')
  })

  it('обход через «rejected» закрыт: отказ не подтверждает личность и не открывает anonymize', async () => {
    // Codex поймал: 'rejected' достижим БЕЗ верификации (это ОК — отказ ничего не
    // раскрывает), но снимает pending_unverified. Гейт по «status ≠ pending_unverified»
    // тогда пропускал ВТОРОЙ PATCH: {status:'rejected'} → {anonymize:true}. verified_at
    // (не текущий status) должен закрыть это независимо от последовательности статусов.
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'marina@x.ru' } })
    await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'marina@x.ru', kind: 'delete' } })
    const rejected = await app.inject({ method: 'PATCH', url: '/api/crm/pd-requests/1', payload: { status: 'rejected' }, headers: { cookie } })
    expect(rejected.statusCode).toBe(200)
    expect(await app.db.prepare('SELECT status, verified_at FROM pd_requests WHERE id = 1').get()).toMatchObject({ status: 'rejected', verified_at: null })

    const anonymize = await app.inject({ method: 'PATCH', url: '/api/crm/pd-requests/1', payload: { anonymize: true }, headers: { cookie } })
    expect(anonymize.statusCode).toBe(400)
    expect(JSON.parse(anonymize.body).error).toBe('not_verified')

    // и попытка «переоткрыть» через new → done тоже не должна проходить без verified_at
    const reopen = await app.inject({ method: 'PATCH', url: '/api/crm/pd-requests/1', payload: { status: 'new' }, headers: { cookie } })
    expect(reopen.statusCode).toBe(200) // rejected → new сам по себе не запрещён…
    const done = await app.inject({ method: 'PATCH', url: '/api/crm/pd-requests/1', payload: { status: 'done' }, headers: { cookie } })
    expect(done.statusCode).toBe(400) // …но done без verified_at всё равно недоступен
    expect(JSON.parse(done.body).error).toBe('not_verified')
    expect((await app.db.prepare('SELECT anonymized_at FROM contacts WHERE id = 1').get()).anonymized_at).toBeNull()
  })

  it('смена привязки контакта аннулирует прежнюю верификацию — иначе можно обезличить чужого', async () => {
    // Codex поймал: verified_at подтверждает личность ПРО КОНКРЕТНЫЙ контакт, а не
    // вообще. Верифицировали для Марины, потом тем же/следующим PATCH подменили
    // contact_id на Петра — старая верификация не должна распространяться на него.
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'marina@x.ru' } })
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Пётр', contact: 'petr@x.ru' } })
    await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'marina@x.ru', kind: 'delete' } })
    await app.inject({ method: 'PATCH', url: '/api/crm/pd-requests/1', payload: { status: 'new' }, headers: { cookie } })
    expect((await app.db.prepare('SELECT verified_at FROM pd_requests WHERE id = 1').get()).verified_at).toBeTruthy()

    // подмена контакта и обезличивание ОДНИМ запросом
    const combined = await app.inject({
      method: 'PATCH',
      url: '/api/crm/pd-requests/1',
      payload: { contact_id: 2, anonymize: true },
      headers: { cookie },
    })
    expect(combined.statusCode).toBe(400)
    expect(JSON.parse(combined.body).error).toBe('not_verified')
    expect((await app.db.prepare('SELECT anonymized_at FROM contacts WHERE id = 2').get()).anonymized_at).toBeNull()

    // подмена контакта ОТДЕЛЬНЫМ запросом тоже сбрасывает верификацию и статус
    const relink = await app.inject({ method: 'PATCH', url: '/api/crm/pd-requests/1', payload: { contact_id: 2 }, headers: { cookie } })
    expect(relink.statusCode).toBe(200)
    expect(await app.db.prepare('SELECT status, verified_at FROM pd_requests WHERE id = 1').get())
      .toMatchObject({ status: 'pending_unverified', verified_at: null })
    const anonymizeAfter = await app.inject({ method: 'PATCH', url: '/api/crm/pd-requests/1', payload: { anonymize: true }, headers: { cookie } })
    expect(anonymizeAfter.statusCode).toBe(400)
    expect(JSON.parse(anonymizeAfter.body).error).toBe('not_verified')
  })

  it('релинк + {status:"new"} одним PATCH — легитимная связка «привязали и тут же подтвердили», verified_at выставляется', async () => {
    // Codex поймал: без пересчёта verifying относительно СБРОШЕННОГО (из-за релинка)
    // статуса {contact_id: новый, status: 'new'} мог записать status='new', но
    // verified_at оставить NULL — снаружи «в порядке», а исполнить нельзя никогда.
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'marina@x.ru' } })
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Пётр', contact: 'petr@x.ru' } })
    await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'marina@x.ru', kind: 'delete' } })
    await app.inject({ method: 'PATCH', url: '/api/crm/pd-requests/1', payload: { status: 'new' }, headers: { cookie } }) // верифицирован на Марине

    const relinkAndVerify = await app.inject({
      method: 'PATCH',
      url: '/api/crm/pd-requests/1',
      payload: { contact_id: 2, status: 'new' },
      headers: { cookie },
    })
    expect(relinkAndVerify.statusCode).toBe(200)
    const row = await app.db.prepare('SELECT contact_id, status, verified_at FROM pd_requests WHERE id = 1').get()
    expect(row).toMatchObject({ contact_id: 2, status: 'new' })
    expect(row.verified_at).toBeTruthy() // не «дыра»: verified_at реально выставлен

    // и теперь исполнимо через обычный PATCH — не застряло
    const done = await app.inject({ method: 'PATCH', url: '/api/crm/pd-requests/1', payload: { status: 'done' }, headers: { cookie } })
    expect(done.statusCode).toBe(200)
  })

  it('нельзя привязать запрос к контакту из ЧУЖОГО проекта', async () => {
    // Codex поймал: PATCH contact_id проверял только «контакт существует», не то,
    // что он в ТОМ ЖЕ проекте — запрос из Лаб ИИ можно было привязать к клиенту
    // Визора, «подтвердить» и в итоге обезличить постороннего для этого бизнеса.
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Визор-клиент', contact: 'v@x.ru', project: 'nevarium-vizor' } })
    await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'someone@else.ru', kind: 'delete', project: 'nevarium1' } })
    const res = await app.inject({ method: 'PATCH', url: '/api/crm/pd-requests/1', payload: { contact_id: 1 }, headers: { cookie } })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('bad_reference')
    expect((await app.db.prepare('SELECT contact_id FROM pd_requests WHERE id = 1').get()).contact_id).toBeNull()
  })

  it('участник (не admin) не может исполнить anonymize через PATCH — обход admin_only закрыт', async () => {
    // Codex поймал: у прямого POST .../anonymize есть admin_only, а у ЭТОГО пути,
    // делающего то же самое (после «подтверждения» тем же участником), проверки не было.
    await app.db.prepare('INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)')
      .run('Участник', 'm@m.ru', (await app.db.prepare('SELECT password_hash h FROM users WHERE id = 1').get()).h, 'member', now())
    const memberCookie = (await login('m@m.ru', 'password123')).headers['set-cookie']

    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'marina@x.ru' } })
    await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'marina@x.ru', kind: 'delete' } })
    await app.inject({ method: 'PATCH', url: '/api/crm/pd-requests/1', payload: { status: 'new' }, headers: { cookie: memberCookie } })

    const res = await app.inject({ method: 'PATCH', url: '/api/crm/pd-requests/1', payload: { anonymize: true }, headers: { cookie: memberCookie } })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toBe('admin_only')
    expect((await app.db.prepare('SELECT anonymized_at FROM contacts WHERE id = 1').get()).anonymized_at).toBeNull()
  })

  it('после подтверждения личности: статус done + обезличивание одним действием', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'marina@x.ru' } })
    await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'marina@x.ru', kind: 'delete' } })
    await app.inject({ method: 'PATCH', url: '/api/crm/pd-requests/1', payload: { status: 'new' }, headers: { cookie } })
    const res = await app.inject({ method: 'PATCH', url: '/api/crm/pd-requests/1', payload: { status: 'done', anonymize: true }, headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).anonymized.name).toBe('Удалённый контакт #1')
    const row = await app.db.prepare('SELECT * FROM pd_requests WHERE id = 1').get()
    expect(row.status).toBe('done')
    expect(row.resolved_at).toBeTruthy()
  })

  it('на запрос «узнать, какие данные есть» обезличивание не срабатывает даже после подтверждения', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'marina@x.ru' } })
    await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'marina@x.ru', kind: 'access' } })
    await app.inject({ method: 'PATCH', url: '/api/crm/pd-requests/1', payload: { status: 'new' }, headers: { cookie } })
    const res = await app.inject({ method: 'PATCH', url: '/api/crm/pd-requests/1', payload: { anonymize: true }, headers: { cookie } })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('kind_not_erasable')
    expect((await app.db.prepare('SELECT anonymized_at FROM contacts WHERE id = 1').get()).anonymized_at).toBeNull()
  })

  it('обезличенный контакт не подхватывается новым запросом по старому адресу', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'marina@x.ru' } })
    await app.inject({ method: 'POST', url: '/api/crm/contacts/1/anonymize', headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'marina@x.ru' } })
    expect((await app.db.prepare('SELECT contact_id FROM pd_requests WHERE id = 1').get()).contact_id).toBeNull()
  })

  it('журнал действий пишется в базу и доступен только администратору', async () => {
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Тест' }, headers: { cookie } })
    const row = await app.db.prepare("SELECT * FROM audit_log WHERE entity = 'contacts' ORDER BY id DESC LIMIT 1").get()
    expect(row).toMatchObject({ action: 'create', entity: 'contacts', user_email: 'a@a.ru' })

    const asAdmin = await app.inject({ method: 'GET', url: '/api/crm/audit', headers: { cookie } })
    expect(asAdmin.statusCode).toBe(200)
    expect(JSON.parse(asAdmin.body).items.length).toBeGreaterThan(0)

    await app.db.prepare('INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)')
      .run('Участник', 'm@m.ru', (await app.db.prepare('SELECT password_hash h FROM users WHERE id = 1').get()).h, 'member', now())
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

  // Перевод на Postgres (план в nevarium-lab#3): VACUUM INTO (.sqlite-копия) убран
  // из runBackup — у Postgres нет прямого аналога, снимок делается снаружи
  // (pg_dump/управляемые бэкапы Timeweb). Единственный формат бэкапа теперь — JSON.

  it('в MAX уходит JSON для восстановления', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина Соколова', contact: '+7 921 555-14-88' } })
    const sent = []
    const { jsonFile } = await runBackup(app.db, {
      dir,
      env: maxEnv,
      log: silent,
      sendDocument: async (f, caption) => sent.push({ f, caption }),
      sendStatus: async () => { throw new Error('статус не нужен, когда всё прошло') },
    })
    expect(fs.existsSync(jsonFile)).toBe(true)
    expect(sent.map((s) => s.f)).toEqual([jsonFile])
    expect(sent[0].caption).toContain('Импорт JSON')

    // в копии действительно лежат ПДн — именно поэтому её нельзя в Telegram
    expect(JSON.parse(fs.readFileSync(jsonFile, 'utf8')).contacts[0].name).toBe('Марина Соколова')
  })

  it('ночной JSON пригоден для восстановления: его принимает «Импорт JSON»', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'm@x.ru' } })
    await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'm@x.ru', kind: 'delete' } })
    const { jsonFile } = await runBackup(app.db, { dir, env: {}, log: silent, sendDocument: async () => {}, sendStatus: async () => {} })

    // катастрофа: база опустела
    await app.db.query('DELETE FROM pd_requests; DELETE FROM interactions; DELETE FROM tasks; DELETE FROM deals; DELETE FROM contacts')
    const dump = JSON.parse(fs.readFileSync(jsonFile, 'utf8'))
    const res = await app.inject({ method: 'POST', url: '/api/crm/import', payload: dump, headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect((await app.db.prepare('SELECT name FROM contacts WHERE id = 1').get()).name).toBe('Марина')
    expect((await app.db.prepare('SELECT COUNT(*) c FROM pd_requests').get()).c).toBe(1)
  })

  it('если MAX не настроен — копия остаётся на сервере, статус обезличен, файл никуда не уходит', async () => {
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина Соколова', contact: '+7 921 555-14-88' } })
    const docs = []
    const statuses = []
    const { jsonFile } = await runBackup(app.db, {
      dir,
      env: {},
      log: silent,
      sendDocument: async (f) => docs.push(f),
      sendStatus: async (text) => statuses.push(text),
    })
    expect(fs.existsSync(jsonFile)).toBe(true)
    expect(docs).toHaveLength(0)
    expect(statuses).toHaveLength(1)
    expect(statuses[0]).not.toMatch(/Марина|555-14-88/)
  })

  it('ошибка отправки не теряет копию и сообщает обезличенным статусом', async () => {
    const statuses = []
    const { jsonFile } = await runBackup(app.db, {
      dir,
      env: maxEnv,
      log: silent,
      sendDocument: async () => { throw new Error('MAX недоступен') },
      sendStatus: async (text) => statuses.push(text),
    })
    expect(fs.existsSync(jsonFile)).toBe(true)
    expect(statuses[0]).toContain('не отправился')
  })

  it('ротация оставляет 7 последних дат', async () => {
    fs.mkdirSync(dir, { recursive: true })
    for (const d of ['01', '02', '03', '04', '05', '06', '07', '08', '09']) {
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
  // Перевод на Postgres (план в nevarium-lab#3): «одна чистая схема», не перенос
  // миграций по шагам (schema.sql — только текущее состояние, MIGRATIONS/PRAGMA
  // user_version у SQLite-версии). Два теста, стоявшие здесь раньше, проверяли
  // ИМЕННО частичное применение миграций на существующей базе (например, только
  // v1-v2, затем «догнать» актуальным кодом) — самого объекта проверки, инкрементных
  // миграций, в новой архитектуре больше нет: применять нечего, схема одна. Гарантии,
  // которые они попутно проверяли (проекты сидируются, seed-данные на месте),
  // покрыты тестом «список проектов отдаёт оба бизнеса» ниже и сидом в db.js.

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

// ---------------------------------------------------------------------------
// Гонки и границы транзакций, вскрытые переводом на Postgres
// ---------------------------------------------------------------------------
// Общий корень всех тестов ниже: в better-sqlite3 целостность держалась на
// синхронности — между «прочитал» и «записал» не было ни одной точки
// переключения, поэтому вклиниться было физически некому. С асинхронным `pg`
// каждый шаг это сетевой round-trip, и все эти проверки пришлось сделать явными.
//
// pg-mem парсит FOR UPDATE и уровни изоляции, но НЕ обеспечивает их семантику
// (см. список ограничений в HANDOFF.md), поэтому «настоящую» гонку двух
// соединений здесь воспроизвести нельзя. Там, где она непроверяема, тест
// проверяет то, что проверяемо и от чего зависит корректность на настоящем
// Postgres: КАКИЕ запросы и в КАКОЙ последовательности уходят в базу, и на
// одном ли соединении. Каждый тест прогонялся на возвращённом баге — без
// соответствующей правки он падает.

/**
 * Наблюдатель за пулом: пишет каждый SQL, различая прямые запросы через пул
 * (autocommit, своё соединение на каждый вызов) и запросы внутри захваченного
 * соединения (транзакция). Плюс умеет один раз сорвать нужный запрос или
 * вклиниться сразу после него — так инъекция отказа и «чужая» запись в точное
 * окно делаются детерминированно, без таймеров и без реального параллелизма.
 *
 * ВАЖНОЕ ОГРАНИЧЕНИЕ, установлено опытом: под pg-mem `pool.connect()` отдаёт
 * объект, чей `query` — это тот же `pool.query`. То есть ПРИНАДЛЕЖНОСТЬ запроса
 * соединению там ненаблюдаема в принципе, и проверка вида «этот запрос шёл НЕ
 * через транзакцию» на pg-mem всегда ложно-зелёная — не пишите её снова.
 *
 * Поэтому проверки опираются на transactions(): границы задают сами команды
 * BEGIN/COMMIT/ROLLBACK, а не объекты соединений. Такой разбор одинаково верен
 * и на pg-mem (одно соединение на всех), и на настоящем Postgres (реальные
 * отдельные соединения) — один и тот же тест доказывает одно и то же в обоих.
 *
 * Что наблюдаемо и чем эти тесты и пользуются: КАКОЙ текст SQL отправлен и в
 * КАКОМ ПОРЯДКЕ. Этого достаточно, чтобы отличить исправленный код от прежнего —
 * например, COMMIT, стоящий раньше постановки уведомления, виден как порядок,
 * а не как выбор соединения.
 */
function watchPool(pool) {
  const all = [] // { conn, sql } — единый поток в порядке отправки
  const origQuery = pool.query.bind(pool)
  const origConnect = pool.connect.bind(pool)
  const hooks = { failBefore: null, failAfter: null, afterOnce: null }
  const wrapped = new WeakSet()
  const connOf = new WeakMap()
  let connSeq = 0

  const runBefore = async (text) => {
    if (hooks.failBefore && String(text).includes(hooks.failBefore)) {
      hooks.failBefore = null
      throw new Error('инъекция отказа (до выполнения): ' + text)
    }
  }
  const runAfter = async (text) => {
    if (hooks.afterOnce && String(text).includes(hooks.afterOnce.needle)) {
      const fn = hooks.afterOnce.fn
      hooks.afterOnce = null
      await fn()
    }
    if (hooks.failAfter && String(text).includes(hooks.failAfter)) {
      hooks.failAfter = null
      throw new Error('инъекция отказа (после выполнения): ' + text)
    }
  }

  // Обе формы вызова, и у пула, и у соединения: node-postgres внутри пользуется
  // КОЛБЭЧНОЙ формой (`query(text, values, cb)`), а обёртка, понимающая только
  // промис, молча теряла колбэк — запрос не завершался никогда, тест висел до
  // таймаута. Под pg-mem не всплывало: там колбэчной формы в этих путях нет.
  const wrapQuery = (label, orig) => (...args) => {
    const text = args[0]
    all.push({ conn: label(), sql: String(text?.text ?? text) })
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null
    const run = async () => {
      await runBefore(text)
      const res = await orig(...args)
      await runAfter(text)
      return res
    }
    const p = run()
    if (cb) {
      p.then((r) => cb(null, r), (e) => cb(e))
      return undefined
    }
    return p
  }

  pool.query = wrapQuery(() => 'pool', origQuery)

  // Соединение из пула нумеруем и оборачиваем РОВНО ОДИН раз: настоящий pg
  // переиспользует объекты клиентов, и повторная обёртка удваивала бы записи.
  const prepare = (client) => {
    if (!connOf.has(client)) connOf.set(client, `c${++connSeq}`)
    if (!wrapped.has(client)) {
      wrapped.add(client)
      client.query = wrapQuery(() => connOf.get(client), client.query.bind(client))
    }
    return client
  }

  // ОБЕ формы вызова. node-postgres внутри `pool.query` зовёт `connect(callback)`,
  // и обёртка, понимающая только промис, роняла запрос в вечное ожидание —
  // под pg-mem это не проявлялось, потому что там connect() отдаёт сам пул.
  pool.connect = (cb) => {
    const p = Promise.resolve(origConnect()).then(prepare)
    if (typeof cb === 'function') {
      p.then((c) => cb(undefined, c, c.release?.bind(c)), (e) => cb(e))
      return undefined
    }
    return p
  }

  return {
    /** Все запросы подряд, без разбора соединений. */
    get sql() { return all.map((e) => e.sql) },
    /**
     * Транзакции как отдельные куски: от BEGIN до COMMIT/ROLLBACK на ОДНОМ
     * соединении, в порядке открытия. Так проверки не зависят от того, отдаёт ли
     * движок настоящие отдельные соединения (настоящий pg) или одно на всех
     * (pg-mem) — разбор идёт по границам самих команд, а не по объектам.
     */
    transactions() {
      const open = new Map()
      const done = []
      for (const { conn, sql } of all) {
        if (/^\s*BEGIN/i.test(sql)) open.set(conn, [sql])
        else if (open.has(conn)) {
          open.get(conn).push(sql)
          if (/^\s*(COMMIT|ROLLBACK)/i.test(sql)) { done.push(open.get(conn)); open.delete(conn) }
        }
      }
      return [...done, ...open.values()]
    },
    /** Сорвать запрос ДО выполнения — падение базы на полпути. */
    failOnce: (needle) => { hooks.failBefore = needle },
    /** Сорвать ПОСЛЕ успешного выполнения — потерянное подтверждение (COMMIT прошёл,
     * ответ не дошёл). Единственный способ воспроизвести неоднозначный коммит. */
    failAfterOnce: (needle) => { hooks.failAfter = needle },
    /** Выполнить fn сразу ПОСЛЕ запроса — «чужая» запись в точное окно. */
    afterOnce: (needle, fn) => { hooks.afterOnce = { needle, fn } },
    restore: () => { pool.query = origQuery; pool.connect = origConnect },
  }
}

describe('границы транзакций и гонки (ревью перевода на Postgres)', () => {
  let watch
  afterEach(() => { watch?.restore(); watch = null })

  describe('приём запроса по ПДн — запись, уведомление и ключ неделимы', () => {
    it('запись, уведомление и закрытие ключа идут одной транзакцией, а не тремя шагами', async () => {
      // Раньше в транзакции был только INSERT (хотя комментарий рядом обещал
      // обратное), а enqueue и закрытие ключа шли после коммита. Падение базы
      // между ними оставляло зарегистрированный запрос по ПДн, о котором никто
      // не узнал (срок по 152-ФЗ идёт, сотруднику не пришло ничего), а
      // обработчик ошибки при этом снимал застолбление ключа — и повтор сайта
      // заводил ВТОРОЙ запрос, то есть второй 10-дневный срок на одно обращение.
      //
      // Сам откат под pg-mem непроверяем (см. it.skip ниже), но проверяемо
      // главное: все три записи обязаны уйти на ОДНО соединение между BEGIN и
      // COMMIT. До правки outbox и idempotency_keys туда не попадали вовсе.
      watch = watchPool(app.db.pool)
      const res = await app.inject({
        method: 'POST', url: '/api/pd-requests',
        payload: { contact: 'marina@x.ru', request_id: 'pd-atomic-1' },
      })
      expect(res.statusCode).toBe(204)

      const tx = watch.transactions().find((t) => t.some((q) => q.includes('INSERT INTO pd_requests')))
      expect(tx, 'запрос по ПДн обязан писаться в транзакции').toBeTruthy()
      const at = (needle) => tx.findIndex((q) => q.includes(needle))
      expect(tx[0], 'транзакция обязана начинаться с BEGIN').toBe('BEGIN')
      expect(at('INSERT INTO outbox'), 'уведомление ушло мимо транзакции').toBeGreaterThan(at('INSERT INTO pd_requests'))
      expect(at('UPDATE idempotency_keys'), 'ключ закрывается мимо транзакции').toBeGreaterThan(at('INSERT INTO outbox'))
      expect(at('COMMIT'), 'COMMIT обязан быть последним').toBeGreaterThan(at('UPDATE idempotency_keys'))
    })

    // Настоящая проверка атомичности — на ОТКАТЕ, а его pg-mem не эмулирует:
    // вставка внутри откаченной транзакции у него остаётся закоммиченной (то же
    // ограничение, из-за которого пропущены два теста импорта выше). Прогнать
    // руками на настоящем Postgres вместе с остальным чек-листом из HANDOFF.md:
    // сорвать `INSERT INTO outbox` — ни запроса, ни ключа остаться не должно,
    // а повтор с тем же ключом обязан создать РОВНО ОДИН запрос.
    itPg('сбой на уведомлении не оставляет ни запроса, ни занятого ключа (нужен настоящий Postgres)', async () => {
      watch = watchPool(app.db.pool)
      watch.failOnce('INSERT INTO outbox')
      const payload = { contact: 'marina@x.ru', request_id: 'pd-atomic-2' }

      expect((await app.inject({ method: 'POST', url: '/api/pd-requests', payload })).statusCode).toBe(500)
      expect((await app.db.prepare('SELECT COUNT(*) c FROM pd_requests').get()).c).toBe(0)
      expect((await app.db.prepare('SELECT COUNT(*) c FROM idempotency_keys').get()).c).toBe(0)

      // тот же ключ, база снова здорова — как и повторит сайт
      expect((await app.inject({ method: 'POST', url: '/api/pd-requests', payload })).statusCode).toBe(204)
      expect((await app.db.prepare('SELECT COUNT(*) c FROM pd_requests').get()).c).toBe(1)
      expect((await app.db.prepare('SELECT COUNT(*) c FROM outbox').get()).c).toBe(1)
    })

    it('брошенный ключ умершего процесса перезахватывается, а не держит форму сутки', async () => {
      // Процесс мог умереть (передеплой, OOM) между застолблением ключа и своей
      // транзакцией — тогда снимать застолбление стало некому. Уборщик сносит
      // такой ключ только через сутки, и всё это время повторы получали 429:
      // человек отправил форму один раз и не может отправить снова целый день.
      await app.db
        .prepare('INSERT INTO idempotency_keys (scope, request_id, status_code, created_at) VALUES (?, ?, NULL, ?)')
        .run('pd_requests', 'pd-orphan', new Date(Date.now() - 5 * 60_000).toISOString())

      const res = await app.inject({
        method: 'POST', url: '/api/pd-requests',
        payload: { contact: 'marina@x.ru', request_id: 'pd-orphan' },
      })
      expect(res.statusCode).toBe(204)
      expect((await app.db.prepare('SELECT COUNT(*) c FROM pd_requests').get()).c).toBe(1)
    })

    it('свежий незавершённый ключ по-прежнему держится — аренда не отключает защиту', async () => {
      // Обратная сторона предыдущего теста: если бы перезахват срабатывал сразу,
      // он бы уничтожил саму идемпотентность — два одновременных повтора одной
      // отправки снова создали бы два запроса.
      await app.db
        .prepare('INSERT INTO idempotency_keys (scope, request_id, status_code, created_at) VALUES (?, ?, NULL, ?)')
        .run('pd_requests', 'pd-fresh', now())

      const res = await app.inject({
        method: 'POST', url: '/api/pd-requests',
        payload: { contact: 'marina@x.ru', request_id: 'pd-fresh' },
      })
      expect(res.statusCode).toBe(429)
      expect((await app.db.prepare('SELECT COUNT(*) c FROM pd_requests').get()).c).toBe(0)
    })
  })

  describe('бэкап — один согласованный снимок, а не серия независимых чтений', () => {
    it('все таблицы дампа читаются одним соединением в REPEATABLE READ / READ ONLY', async () => {
      // Через пул каждая таблица читалась своим соединением и своим снимком:
      // заявка, пришедшая между чтением contacts и deals, клала в файл сделку
      // без её контакта, а deals.contact_id — NOT NULL REFERENCES contacts(id).
      // Такой бэкап не импортируется вовсе, и выясняется это в момент аварии.
      // Саму изоляцию pg-mem не эмулирует — проверяем то, от чего она зависит
      // на настоящем Postgres: одно соединение и явно запрошенный уровень.
      await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов' }, headers: { cookie } })
      await app.inject({ method: 'POST', url: '/api/crm/deals', payload: { contact_id: 1, title: 'Пилот' }, headers: { cookie } })

      watch = watchPool(app.db.pool)
      const res = await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })
      expect(res.statusCode).toBe(200)

      const snapshot = watch.transactions().find((t) => t.some((q) => q.includes('REPEATABLE READ')))
      expect(snapshot, 'дамп обязан открыть снимок на закреплённом соединении').toBeTruthy()
      expect(snapshot.some((q) => q.includes('READ ONLY'))).toBe(true)
      // ВСЕ таблицы дампа — на этом же соединении, от первой до последней
      for (const t of ['contacts', 'deals', 'consents', 'tasks', 'interactions', 'pd_requests', 'audit_log']) {
        expect(snapshot.some((q) => q.includes('FROM ' + t)), t + ' читается вне снимка').toBe(true)
      }
      expect(snapshot.some((q) => q.includes('FROM users')), 'состав команды читается вне снимка').toBe(true)
      // Порядок тоже важен: снимок открыт ДО первого чтения, иначе смысла нет.
      expect(snapshot.findIndex((q) => q.includes('REPEATABLE READ')))
        .toBeLessThan(snapshot.findIndex((q) => q.includes('FROM contacts')))
    })
  })

  describe('импорт — счётчики id не трогаются, пока импорт не удался целиком', () => {
    it('упавший импорт не переписывает ни одной последовательности', async () => {
      // setval в Postgres нетранзакционен: откат его не отменяет. Пока вызов
      // стоял внутри цикла по таблицам, падение на поздней таблице оставляло
      // счётчики ранних ПОНИЖЕННЫМИ до максимума из дампа, хотя строки
      // откатились — и следующее создание записи падало на PRIMARY KEY.
      await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов' }, headers: { cookie } })
      await app.inject({ method: 'POST', url: '/api/crm/deals', payload: { contact_id: 1, title: 'Пилот' }, headers: { cookie } })
      const dump = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })).body)
      // ломаем ПОЗДНЮЮ таблицу: contacts/deals к этому моменту уже вставлены
      dump.tasks = [{ id: 1, title: 'Позвонить', выдуманное_поле: 'x' }]

      watch = watchPool(app.db.pool)
      const res = await app.inject({ method: 'POST', url: '/api/crm/import', payload: dump, headers: { cookie } })
      expect(res.statusCode).toBe(400)

      expect(watch.sql.some((q) => q.includes('setval')), 'упавший импорт трогал последовательности').toBe(false)
    })

    it('успешный импорт последовательности всё-таки чинит, и только вверх', async () => {
      // Парный к предыдущему: перенос вызова в конец не должен был его потерять —
      // иначе после восстановления первый же новый контакт падал бы на PRIMARY KEY.
      await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов' }, headers: { cookie } })
      const dump = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })).body)

      watch = watchPool(app.db.pool)
      const res = await app.inject({ method: 'POST', url: '/api/crm/import', payload: dump, headers: { cookie } })
      expect(res.statusCode).toBe(200)

      const setvals = watch.sql.filter((q) => q.includes('setval'))
      expect(setvals.length).toBeGreaterThan(0)
      // понижение счётчика и есть источник коллизий id — только GREATEST
      expect(setvals.every((q) => q.includes('GREATEST'))).toBe(true)
    })
  })

  describe('раздел ПДн — решение принимается по заблокированной строке', () => {
    it('PATCH читает запрос внутри транзакции и под FOR UPDATE', async () => {
      // Строка читалась до транзакции обычным SELECT, и вся защита
      // verified_at/contactChanged держалась на допущении, что снимок
      // консистентен. Два PATCH по одному снимку (верификация + смена контакта)
      // разъезжались так, что запрос оказывался привязан к ОДНОМУ человеку, а
      // подтверждён по ДРУГОМУ — и следующее обезличивание стирало не того.
      // Саму блокировку pg-mem не реализует; проверяем, что она запрошена и что
      // чтение идёт внутри транзакции, а не мимо неё.
      await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов' }, headers: { cookie } })
      await app.inject({
        method: 'POST', url: '/api/crm/pd-requests',
        payload: { contact_id: 1, kind: 'delete', requester: 'i@x.ru' }, headers: { cookie },
      })

      watch = watchPool(app.db.pool)
      const res = await app.inject({
        method: 'PATCH', url: '/api/crm/pd-requests/1',
        payload: { note: 'уточнение' }, headers: { cookie },
      })
      expect(res.statusCode).toBe(200)

      const tx = watch.transactions().find((t) => t.some((q) => q.includes('FROM pd_requests WHERE id = $1 FOR UPDATE')))
      expect(tx, 'запрос по ПДн обязан читаться под FOR UPDATE').toBeTruthy()
      // Чтение — ПОСЛЕ BEGIN: блокировка вне транзакции ничего не держит.
      expect(tx[0]).toBe('BEGIN')
    })

    it('отказ валидации откатывает транзакцию, ничего не записав', async () => {
      // Валидация переехала ВНУТРЬ транзакции — значит отказ обязан её откатывать,
      // а не оставлять половину изменений закоммиченной.
      await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов' }, headers: { cookie } })
      await app.inject({
        method: 'POST', url: '/api/pd-requests',
        payload: { contact: 'i@x.ru', kind: 'delete' },
      })
      // pending_unverified: перевод сразу в done обязан быть отвергнут
      const res = await app.inject({
        method: 'PATCH', url: '/api/crm/pd-requests/1',
        payload: { note: 'записать это не должны', status: 'done' }, headers: { cookie },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).error).toBe('not_verified')
      const row = await app.db.prepare('SELECT note, status FROM pd_requests WHERE id = 1').get()
      expect(row.note ?? '').not.toContain('записать это не должны')
      expect(row.status).toBe('pending_unverified')
    })
  })

  describe('оптимистичная блокировка — версия проверяется самой базой', () => {
    it('ожидаемая версия стоит в условии самого UPDATE, а не только в отдельной проверке', async () => {
      // Быстрая проверка по прочитанной строке пропускала того, кто вклинился ПОСЛЕ
      // неё: оба PATCH читали одну версию, оба проходили, оба отвечали 200, и второй
      // молча затирал первого. Лечится тем, что условие проверяет сама база, атомарно
      // с записью.
      //
      // Раньше этот тест воспроизводил чередование напрямую — вклинивал «чужую»
      // запись сразу после SELECT'а обработчика. Так делать больше НЕЛЬЗЯ, и это
      // хорошая новость: после переноса чтения под `FOR UPDATE` (третий раунд ревью,
      // барьер восстановления) строка заблокирована до конца транзакции, и чужая
      // запись честно ждёт — на настоящем Postgres такой тест просто вешался бы, а
      // под pg-mem проходил бы ложно-зелёным, потому что блокировок строк там нет.
      // То есть более поздняя правка сделала само окно недостижимым. Проверяем то,
      // что осталось проверяемым и от чего защита зависит: предикат в самом UPDATE.
      // Поведение «устаревшая версия → 409» покрыто отдельно, в блоке «CRUD + конфликты».
      const created = await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов', note: 'исходная' }, headers: { cookie } })
      const before = JSON.parse(created.body).item

      watch = watchPool(app.db.pool)
      const res = await app.inject({
        method: 'PATCH', url: '/api/crm/contacts/1',
        payload: { note: 'моя правка', expectedUpdatedAt: before.updated_at }, headers: { cookie },
      })
      expect(res.statusCode).toBe(200)

      const upd = watch.sql.find((q) => q.includes('UPDATE contacts SET'))
      expect(upd, 'ожидали UPDATE контакта').toBeTruthy()
      expect(upd.includes('updated_at = $'), 'версия не попала в условие UPDATE').toBe(true)
      expect(/WHERE id = \$\d+ AND updated_at = \$\d+/.test(upd), `предикат без версии: ${upd}`).toBe(true)
    })

    it('без expectedUpdatedAt поведение прежнее — условие не навязывается', async () => {
      // Клиенты, которые версию не шлют (например, внутренние вызовы), не должны
      // начать получать 409 из-за этой правки.
      await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов' }, headers: { cookie } })
      const res = await app.inject({
        method: 'PATCH', url: '/api/crm/contacts/1',
        payload: { note: 'без версии' }, headers: { cookie },
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).item.note).toBe('без версии')
    })
  })
})

// ---------------------------------------------------------------------------
// Второй раунд ревью: дыры, открытые самими правками первого раунда
// ---------------------------------------------------------------------------
// Первый раунд закрыл границы транзакций, но аренда ключа идемпотентности была
// сделана без «ограждения» (fencing), а безусловный DELETE в idempotencyAbandon
// стал опасен ровно потому, что закрытие ключа переехало ВНУТРЬ транзакции.
// Обе находки — прямые последствия предыдущей правки, не предсуществующие баги.

describe('идемпотентность: перезахват по аренде огорожен', () => {
  let watch
  afterEach(() => { watch?.restore(); watch = null })

  it('перезахват заводит НОВУЮ строку, а прежний id перестаёт существовать', async () => {
    // Аренда — догадка о смерти владельца, не доказательство. Пока перезахват
    // сдвигал created_at у ТОЙ ЖЕ строки, у ожившего прежнего владельца
    // оставался годный ключ, и он дописывал свою работу поверх чужой.
    await app.db
      .prepare('INSERT INTO idempotency_keys (scope, request_id, status_code, created_at) VALUES (?, ?, NULL, ?)')
      .run('pd_requests', 'pd-fence', new Date(Date.now() - 5 * 60_000).toISOString())
    const before = await app.db
      .prepare('SELECT id FROM idempotency_keys WHERE scope = ? AND request_id = ?').get('pd_requests', 'pd-fence')

    const res = await app.inject({
      method: 'POST', url: '/api/pd-requests',
      payload: { contact: 'marina@x.ru', request_id: 'pd-fence' },
    })
    expect(res.statusCode).toBe(204)

    const after = await app.db
      .prepare('SELECT id, status_code FROM idempotency_keys WHERE scope = ? AND request_id = ?').get('pd_requests', 'pd-fence')
    expect(after.status_code).toBe(204)
    // ГЛАВНОЕ: id другой. Прежний владелец, если оживёт, не найдёт своей строки.
    expect(after.id).not.toBe(before.id)
    expect((await app.db.prepare('SELECT COUNT(*) c FROM idempotency_keys WHERE id = ?').get(before.id)).c).toBe(0)
  })

  it('оживший прежний владелец откатывает свою работу, а не дописывает вторую запись', async () => {
    // Полное чередование: A застолбил ключ и завис; аренда истекла; B перехватил
    // и всё сделал; A ожил и продолжил с того же места. Раньше A спокойно
    // дописывал ВТОРОЙ запрос по ПДн и второе уведомление — второй 10-дневный
    // срок по 152-ФЗ на одно обращение.
    //
    // Сам откат pg-mem не исполняет (см. it.skip выше), поэтому проверяем не
    // содержимое таблиц, а чем закончилась транзакция A: ROLLBACK против COMMIT.
    // Это наблюдаемо и различает исправленный код от прежнего однозначно.
    watch = watchPool(app.db.pool)
    const key = { contact: 'marina@x.ru', request_id: 'pd-revive' }
    // сразу после того, как A застолбил ключ: состарить его захват и впустить B
    watch.afterOnce('INSERT INTO idempotency_keys', async () => {
      await app.db
        .prepare('UPDATE idempotency_keys SET created_at = ? WHERE scope = ? AND request_id = ?')
        .run(new Date(Date.now() - 5 * 60_000).toISOString(), 'pd_requests', 'pd-revive')
      const b = await app.inject({ method: 'POST', url: '/api/pd-requests', payload: key })
      expect(b.statusCode).toBe(204)
    })

    const a = await app.inject({ method: 'POST', url: '/api/pd-requests', payload: key })
    // A отвечает результатом B — с точки зрения сайта это одна и та же отправка
    expect(a.statusCode).toBe(204)

    // Последний заведённый лог — это соединение самого A: B отработал целиком
    // раньше, внутри хука. Более ранние логи под pg-mem накапливают и чужие
    // запросы (см. оговорку у watchPool), поэтому смотрим именно последний.
    const txA = watch.transactions().at(-1)
    expect(txA.some((q) => q.includes('INSERT INTO pd_requests')), 'ожидали транзакцию A').toBe(true)
    expect(txA.includes('ROLLBACK'), 'транзакция ожившего владельца обязана откатиться').toBe(true)
    expect(txA.includes('COMMIT'), 'оживший владелец закоммитил вторую запись').toBe(false)
  })

  it('потерянное подтверждение COMMIT не уничтожает уже закрытый ключ', async () => {
    // Транзакция успела закоммитить запрос, уведомление и status_code = 204, но
    // подтверждение COMMIT потерялось по сети. withTransaction видит отказ,
    // обработчик зовёт idempotencyAbandon — и безусловный DELETE сносил ключ с
    // уже закоммиченным успешным ответом. Повтор сайта заводил второй запрос
    // при существующем первом.
    //
    // Отказ ПОСЛЕ успешного выполнения — единственный честный способ это
    // воспроизвести. Сорвать сам COMMIT нельзя: тогда его и правда не было, и на
    // настоящем Postgres всё откатится, то есть проверялся бы не тот сценарий.
    // Здесь COMMIT реально проходит, а ошибку получает уже вызывающий код.
    watch = watchPool(app.db.pool)
    watch.failAfterOnce('COMMIT')
    const payload = { contact: 'marina@x.ru', request_id: 'pd-ambiguous' }
    await app.inject({ method: 'POST', url: '/api/pd-requests', payload })

    const key = await app.db
      .prepare('SELECT status_code FROM idempotency_keys WHERE scope = ? AND request_id = ?').get('pd_requests', 'pd-ambiguous')
    expect(key, 'завершённый ключ не должен удаляться при неоднозначном коммите').toBeTruthy()
    expect(key.status_code).toBe(204)

    // и повтор получает свой законный кешированный ответ, не заводя второй запрос
    watch.restore(); watch = null
    const retry = await app.inject({ method: 'POST', url: '/api/pd-requests', payload })
    expect(retry.statusCode).toBe(204)
    expect((await app.db.prepare('SELECT COUNT(*) c FROM pd_requests').get()).c).toBe(1)
  })
})

describe('восстановление и стадии сделки — запись заперта на время операции', () => {
  let watch
  afterEach(() => { watch?.restore(); watch = null })

  it('импорт запирает запись во все свои таблицы ДО первого удаления', async () => {
    // DELETE/INSERT берут лишь ROW EXCLUSIVE и параллельную вставку не блокируют.
    // Значит между чтением MAX(id)/last_value и setval успевает вклиниться заявка
    // с сайта, занять следующий id, а setval потом откатывает счётчик назад —
    // и эта вставка сталкивается с восстановленной строкой по PRIMARY KEY.
    // Монотонный GREATEST один этого не лечит: он сравнивает значения,
    // прочитанные ДО вставки конкурента. pg-mem LOCK TABLE не разбирает, поэтому
    // проверяем сам факт и позицию команды.
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов' }, headers: { cookie } })
    const dump = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })).body)

    watch = watchPool(app.db.pool)
    expect((await app.inject({ method: 'POST', url: '/api/crm/import', payload: dump, headers: { cookie } })).statusCode).toBe(200)

    const tx = watch.transactions().find((t) => t.some((q) => q.includes('DELETE FROM contacts')))
    expect(tx, 'импорт обязан идти транзакцией').toBeTruthy()
    const firstLock = tx.findIndex((q) => q.includes('LOCK TABLE') && q.includes('EXCLUSIVE MODE'))
    expect(firstLock, 'импорт не запер запись').toBeGreaterThanOrEqual(0)
    expect(firstLock).toBeLessThan(tx.findIndex((q) => q.includes('DELETE FROM')))
    // заперты все таблицы, которые импорт трогает, а не только сущности CRUD
    const lock = tx[firstLock]
    // idempotency_keys и outbox в списке НЕТ намеренно: их трогают пути мимо барьера
    // (захват ключа идёт до withMutation, воркер очереди работает сам по себе), и
    // блокировка вешала бы их на неограниченное ожидание — шагом раньше, чем
    // срабатывает потолок. Обе таблицы чистятся импортом безусловно.
    for (const t of ['contacts', 'deals', 'consents', 'tasks', 'interactions', 'pd_requests', 'audit_log', 'winback_sequences']) {
      expect(lock.includes(t), `${t} не заперта`).toBe(true)
    }
  })

  it('смена стадии и воронка возврата — одна транзакция по заблокированной сделке', async () => {
    // T1 переводит «Новый»→«Проиграно» и ещё не завёл серию; T2 с законной
    // версией переводит «Проиграно»→«Переговоры», видит старую стадию, зовёт
    // отмену — и не находит ничего; затем T1 создаёт серию. Итог: сделка снова
    // в работе, а напоминания «клиент ушёл» на ней висят, и оба запроса ответили
    // 200. Настоящую блокировку строки pg-mem не исполняет, поэтому проверяем
    // то, от чего она зависит: сделка читается FOR UPDATE, и вся производная
    // работа идёт тем же соединением до COMMIT.
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов' }, headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/crm/deals', payload: { contact_id: 1, title: 'Пилот' }, headers: { cookie } })

    watch = watchPool(app.db.pool)
    const res = await app.inject({
      method: 'PATCH', url: '/api/crm/deals/1',
      payload: { stage: 'Проиграно', lostReason: 'дорого' }, headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).winback).toMatchObject({ started: true })

    // Самый поздний лог = последняя открытая транзакция (см. оговорку у watchPool).
    // Если серия заводится СВОЕЙ транзакцией, последней окажется она — и в ней не
    // будет ни FOR UPDATE, ни UPDATE deals. Здесь всё обязано быть в одной.
    const tx = watch.transactions().at(-1)
    expect(tx[0]).toBe('BEGIN')
    const at = (needle) => tx.findIndex((q) => q.includes(needle))
    expect(at('FROM deals WHERE id = $1 FOR UPDATE'), 'сделка обязана читаться под FOR UPDATE').toBeGreaterThanOrEqual(0)
    expect(at('UPDATE deals SET')).toBeGreaterThan(at('FOR UPDATE'))
    expect(at('INSERT INTO winback_sequences'), 'серия заводится вне транзакции стадии').toBeGreaterThan(at('UPDATE deals SET'))
    expect(at('COMMIT')).toBeGreaterThan(at('INSERT INTO winback_sequences'))
  })

  it('возврат сделки в работу снимает серию той же транзакцией', async () => {
    // Парный к предыдущему: отмена тоже производная от стадии и обязана быть
    // в той же транзакции, иначе разъезжается симметрично.
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов' }, headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/crm/deals', payload: { contact_id: 1, title: 'Пилот' }, headers: { cookie } })
    await app.inject({ method: 'PATCH', url: '/api/crm/deals/1', payload: { stage: 'Проиграно' }, headers: { cookie } })

    watch = watchPool(app.db.pool)
    const res = await app.inject({
      method: 'PATCH', url: '/api/crm/deals/1', payload: { stage: 'Переговоры' }, headers: { cookie },
    })
    expect(JSON.parse(res.body).winback).toMatchObject({ cancelled: true })

    const tx = watch.transactions().at(-1)
    const at = (needle) => tx.findIndex((q) => q.includes(needle))
    expect(at('FROM deals WHERE id = $1 FOR UPDATE'), 'сделка обязана читаться под FOR UPDATE').toBeGreaterThanOrEqual(0)
    expect(at("UPDATE winback_sequences SET status = 'cancelled'")).toBeGreaterThan(at('UPDATE deals SET'))
    expect(at('COMMIT')).toBeGreaterThan(at("UPDATE winback_sequences SET status = 'cancelled'"))
  })

  it('стадия и closed_at считаются по заблокированной строке, а не по прочитанной заранее', async () => {
    // closed_at тоже производный от «стадия действительно поменялась», поэтому
    // переехал внутрь транзакции вместе с решением о воронке. Регрессия на то,
    // что перенос не сломал прежнее поведение.
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов' }, headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/crm/deals', payload: { contact_id: 1, title: 'Пилот' }, headers: { cookie } })
    const paid = await app.inject({ method: 'PATCH', url: '/api/crm/deals/1', payload: { stage: 'Оплачено' }, headers: { cookie } })
    const closedAt = JSON.parse(paid.body).item.closed_at
    expect(closedAt).toBeTruthy()
    // повторный PATCH той же стадией не переставляет дату закрытия
    const again = await app.inject({
      method: 'PATCH', url: '/api/crm/deals/1', payload: { stage: 'Оплачено', note: 'правка' }, headers: { cookie },
    })
    expect(JSON.parse(again.body).item.closed_at).toBe(closedAt)
  })
})

// ---------------------------------------------------------------------------
// Третий раунд ревью: дыры, открытые правками второго раунда
// ---------------------------------------------------------------------------
// Две из четырёх находок — прямые последствия предыдущих правок: аренда ключа,
// заведённая для pd-requests, оказалась опасна и для лидов (там её сознательно
// оставили без ограждения, и обоснование «дубль погасит дедупликация» было
// неверным), а `audit(..., tx)`, добавленный ради атомарности журнала, глушил
// свою же ошибку внутри транзакции.

describe('приём лида — владение ключом проверяется до коммита', () => {
  let watch
  afterEach(() => { watch?.restore(); watch = null })

  it('заявка, уведомление и закрытие ключа идут одной транзакцией', async () => {
    // Раньше enqueue и закрытие ключа шли ПОСЛЕ коммита, и потеря владения только
    // писалась в лог. Обоснование было «повтор погасит дедупликация» — оно неверно:
    // дедупликация читает базу ДО транзакции, а перехватчик и прежний владелец
    // работают ОДНОВРЕМЕННО и оба видят «контакта нет», пока ни один не закоммитил.
    watch = watchPool(app.db.pool)
    const res = await app.inject({
      method: 'POST', url: '/api/leads',
      payload: { name: 'Марина', contact: 'marina@x.ru', request_id: 'lead-atomic' },
    })
    expect(res.statusCode).toBe(204)

    const tx = watch.transactions().find((t) => t.some((q) => q.includes('INSERT INTO contacts')))
    expect(tx, 'заявка обязана писаться в транзакции').toBeTruthy()
    const at = (needle) => tx.findIndex((q) => q.includes(needle))
    expect(at('INSERT INTO outbox'), 'уведомление ушло мимо транзакции').toBeGreaterThan(at('INSERT INTO contacts'))
    expect(at('UPDATE idempotency_keys'), 'ключ закрывается мимо транзакции').toBeGreaterThan(at('INSERT INTO outbox'))
    expect(at('COMMIT'), 'COMMIT обязан быть последним').toBeGreaterThan(at('UPDATE idempotency_keys'))
  })

  it('оживший прежний владелец откатывает заявку, а не заводит вторую карточку', async () => {
    // Полное чередование, то же что у pd-requests: A застолбил ключ и завис, аренда
    // истекла, B перехватил и всё сделал, A ожил. Дедупликация здесь бессильна —
    // оба читали базу до того, как кто-либо закоммитил.
    watch = watchPool(app.db.pool)
    const key = { name: 'Марина', contact: 'marina@x.ru', request_id: 'lead-revive' }
    // Хук стоит на захвате ключа — то есть ДО того, как A откроет транзакцию. Раньше
    // он стоял на запросе дедупликации, чтобы оба увидели «контакта нет»; после того
    // как дедупликация переехала ВНУТРЬ транзакции (барьер восстановления), так делать
    // нельзя: B запускался бы посреди открытой транзакции A, а под pg-mem оба идут по
    // одному соединению, и разбор по границам BEGIN/COMMIT их путает (см. оговорку у
    // watchPool). Проверяемое свойство от переноса не пострадало: A всё равно доходит
    // до своей транзакции с чужим ключом и обязан откатиться — просто теперь он идёт
    // по ветке переиспользования контакта, а не создания.
    watch.afterOnce('INSERT INTO idempotency_keys', async () => {
      await app.db
        .prepare('UPDATE idempotency_keys SET created_at = ? WHERE scope = ? AND request_id = ?')
        .run(new Date(Date.now() - 5 * 60_000).toISOString(), 'leads', 'lead-revive')
      const b = await app.inject({ method: 'POST', url: '/api/leads', payload: key })
      expect(b.statusCode).toBe(204)
    })

    const a = await app.inject({ method: 'POST', url: '/api/leads', payload: key })
    expect(a.statusCode).toBe(204) // отвечаем результатом перехватчика

    // Контакт ровно один: вторая карточка и есть тот самый дубль. Проверяется
    // только на живой базе — pg-mem откат не исполняет, у него строки ожившего
    // владельца остаются, сколько бы ROLLBACK ни выполнил код (то же ограничение,
    // из-за которого пропущены тесты атомарности импорта).
    if (REAL_PG) expect((await app.db.prepare('SELECT COUNT(*) c FROM contacts').get()).c).toBe(1)

    const txA = watch.transactions().at(-1)
    // Слепок согласия пишется на КАЖДУЮ отправку, обеими ветками (и созданием
    // контакта, и переиспользованием) — по нему транзакцию A и опознаём.
    expect(txA.some((q) => q.includes('INSERT INTO consents')), 'ожидали транзакцию A').toBe(true)
    expect(txA.includes('ROLLBACK'), 'транзакция ожившего владельца обязана откатиться').toBe(true)
    expect(txA.includes('COMMIT'), 'оживший владелец закоммитил вторую заявку').toBe(false)
  })
})

describe('журнал действий внутри транзакции не может провалиться молча', () => {
  let watch
  afterEach(() => { watch?.restore(); watch = null })

  it('сбой записи в журнал отменяет саму операцию, а не отвечает 200', async () => {
    // `audit` намеренно глушит ошибку — журнал не должен ломать сохранение контакта.
    // Но ВНУТРИ транзакции это ломает всё: в Postgres упавший оператор переводит
    // транзакцию в состояние отказа, и следующий COMMIT молча выполняется как
    // ROLLBACK. То есть операция отменялась, а обработчик отвечал 200 — правка
    // исчезала бесследно. Снаружи транзакции прежнее поведение сохраняется.
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов' }, headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/crm/deals', payload: { contact_id: 1, title: 'Пилот' }, headers: { cookie } })

    watch = watchPool(app.db.pool)
    watch.failOnce('INSERT INTO audit_log')
    const res = await app.inject({
      method: 'PATCH', url: '/api/crm/deals/1',
      payload: { stage: 'Проиграно' }, headers: { cookie },
    })
    expect(res.statusCode, 'молчаливый 200 при отменённой операции').not.toBe(200)

    const tx = watch.transactions().at(-1)
    expect(tx.includes('ROLLBACK'), 'транзакция обязана откатиться').toBe(true)
  })

  it('снаружи транзакции журнал по-прежнему не ломает запрос', async () => {
    // Обратная сторона: для путей, где audit вызывается БЕЗ tx, потерянная строка
    // журнала не повод отменять операцию — это и было исходным решением, оно в силе.
    // Пример такого пути — удаление: сама цепочка удаления идёт транзакцией, а запись
    // в журнал делается уже после неё, на пуле. (Создание записи сюда больше не
    // годится: оно тоже стало транзакционным ради барьера восстановления, и журнал
    // там теперь обязан разделять судьбу вставки.)
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов' }, headers: { cookie } })
    watch = watchPool(app.db.pool)
    watch.failOnce('INSERT INTO audit_log')
    const res = await app.inject({
      method: 'DELETE', url: '/api/crm/contacts/1', headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    expect((await app.db.prepare('SELECT COUNT(*) c FROM contacts').get()).c).toBe(0)
  })

  it('создание записи теперь тоже транзакционно — сбой журнала отменяет вставку', async () => {
    // Парный к предыдущему: создание переехало под барьер обслуживания, значит
    // audit получает tx, значит его сбой обязан отменить саму вставку, а не оставить
    // контакт без следа в журнале.
    watch = watchPool(app.db.pool)
    watch.failOnce('INSERT INTO audit_log')
    const res = await app.inject({
      method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов' }, headers: { cookie },
    })
    expect(res.statusCode, 'молчаливый 200 при отменённой вставке').not.toBe(200)
    const tx = watch.transactions().at(-1)
    expect(tx.includes('ROLLBACK'), 'транзакция обязана откатиться').toBe(true)
  })
})

describe('обезличивание ПДн сверяет проект контакта заново', () => {
  it('контакт, уехавший в другой проект, обезличить по старому запросу нельзя', async () => {
    // Границу проекта стерегла единственная проверка на пути смены привязки. Но
    // контакт можно перенести в другой проект обычным PATCH — и подтверждённый
    // запрос «Лаб ИИ» продолжал указывать на контакт, уехавший в «Визор».
    // Обезличивание необратимо стирало человека ЧУЖОГО бизнеса.
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов', email: 'i@x.ru' }, headers: { cookie } })
    await app.inject({
      method: 'POST', url: '/api/crm/pd-requests',
      payload: { contact_id: 1, kind: 'delete', requester: 'i@x.ru' }, headers: { cookie },
    })
    // перенос контакта в другой проект — штатная возможность CRM
    const moved = await app.inject({
      method: 'PATCH', url: '/api/crm/contacts/1',
      payload: { project_id: 'nevarium-vizor' }, headers: { cookie },
    })
    expect(JSON.parse(moved.body).item.project_id).toBe(2)

    const res = await app.inject({
      method: 'PATCH', url: '/api/crm/pd-requests/1',
      payload: { anonymize: true }, headers: { cookie },
    })
    expect(res.statusCode, 'обезличили контакт чужого проекта').toBe(400)
    expect(JSON.parse(res.body).error).toBe('bad_reference')
    const c = await app.db.prepare('SELECT anonymized_at FROM contacts WHERE id = 1').get()
    expect(c.anonymized_at, 'контакт всё-таки обезличен').toBeFalsy()
  })

  it('контакт в своём проекте обезличивается как прежде', async () => {
    // Парный: проверка не должна сломать законный путь.
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов', email: 'i@x.ru' }, headers: { cookie } })
    await app.inject({
      method: 'POST', url: '/api/crm/pd-requests',
      payload: { contact_id: 1, kind: 'delete', requester: 'i@x.ru' }, headers: { cookie },
    })
    const res = await app.inject({
      method: 'PATCH', url: '/api/crm/pd-requests/1',
      payload: { anonymize: true }, headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    const c = await app.db.prepare('SELECT anonymized_at FROM contacts WHERE id = 1').get()
    expect(c.anonymized_at).toBeTruthy()
  })
})

describe('мутации читают строку под блокировкой, а не мимо неё', () => {
  let watch
  afterEach(() => { watch?.restore(); watch = null })

  it('PATCH любой сущности читает цель внутри транзакции и под FOR UPDATE', async () => {
    // Импорт дампа берёт EXCLUSIVE на таблицы, но EXCLUSIVE намеренно ПУСКАЕТ
    // обычные SELECT. Значит PATCH мог прочитать строку ДО восстановления,
    // подождать на UPDATE и записать уже в ВОССТАНОВЛЕННУЮ строку с тем же id —
    // возможно, совсем другой сущности. FOR UPDATE требует ROW SHARE, а он с
    // EXCLUSIVE конфликтует: запрос ждёт ещё до чтения.
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов' }, headers: { cookie } })

    watch = watchPool(app.db.pool)
    const res = await app.inject({
      method: 'PATCH', url: '/api/crm/contacts/1',
      payload: { note: 'правка' }, headers: { cookie },
    })
    expect(res.statusCode).toBe(200)

    const tx = watch.transactions().at(-1)
    expect(tx[0]).toBe('BEGIN')
    const at = (needle) => tx.findIndex((q) => q.includes(needle))
    expect(at('FROM contacts WHERE id = $1 FOR UPDATE'), 'цель читается мимо блокировки').toBeGreaterThanOrEqual(0)
    expect(at('UPDATE contacts SET')).toBeGreaterThan(at('FOR UPDATE'))
    expect(at('COMMIT')).toBeGreaterThan(at('UPDATE contacts SET'))
  })

  it('404 и «нечего менять» по-прежнему отвечают как раньше', async () => {
    // Перенос чтения внутрь транзакции не должен поменять внешнее поведение.
    const missing = await app.inject({
      method: 'PATCH', url: '/api/crm/contacts/999', payload: { note: 'x' }, headers: { cookie },
    })
    expect(missing.statusCode).toBe(404)

    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов' }, headers: { cookie } })
    const empty = await app.inject({
      method: 'PATCH', url: '/api/crm/contacts/1', payload: { чужое_поле: 'x' }, headers: { cookie },
    })
    expect(empty.statusCode).toBe(200)
    expect(JSON.parse(empty.body).item.name).toBe('Иванов')
  })
})

// ---------------------------------------------------------------------------
// Четвёртый раунд ревью: барьер «восстановление против обычной работы»
// ---------------------------------------------------------------------------
// Табличные блокировки третьего раунда защищали только ЗАПИСЬ: EXCLUSIVE намеренно
// пускает обычные SELECT. Значит обработчик успевал прочитать данные до
// восстановления и записать уже по восстановленным строкам с теми же id. Плюс сам
// порядок захвата таблиц оказался встречным у импорта и у раздела ПДн — то есть
// готовая взаимная блокировка.

describe('барьер обслуживания: чтение мутаций тоже по эту сторону восстановления', () => {
  let watch
  afterEach(() => { watch?.restore(); watch = null })

  const barrierOf = (tx) => tx.findIndex((q) => q.includes('pg_advisory_xact_lock'))

  it('импорт берёт ИСКЛЮЧИТЕЛЬНЫЙ барьер, и берёт его самым первым', async () => {
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов' }, headers: { cookie } })
    const dump = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })).body)

    watch = watchPool(app.db.pool)
    expect((await app.inject({ method: 'POST', url: '/api/crm/import', payload: dump, headers: { cookie } })).statusCode).toBe(200)

    const tx = watch.transactions().find((t) => t.some((q) => q.includes('DELETE FROM contacts')))
    expect(tx, 'импорт обязан идти транзакцией').toBeTruthy()
    const b = barrierOf(tx)
    expect(b, 'импорт не взял барьер').toBeGreaterThanOrEqual(0)
    expect(tx[b].includes('pg_advisory_xact_lock_shared'), 'импорту нужен исключительный барьер, не разделяемый').toBe(false)
    // Барьер — раньше любого обращения к данным (перед ним допустима только
    // служебная подготовка: BEGIN и снятие потолка ожидания у самого восстановления).
    const firstData = tx.findIndex((q) => /^s*(SELECT|INSERT|UPDATE|DELETE)/i.test(q) && !q.includes('pg_advisory_xact_lock'))
    expect(firstData === -1 || b < firstData, `до барьера уже прочитали данные: ${tx.slice(0, b + 1).join(' | ')}`).toBe(true)
    expect(b).toBeLessThan(tx.findIndex((q) => q.includes('LOCK TABLE')))
  })

  // Мутации берут РАЗДЕЛЯЕМЫЙ барьер — такие друг с другом не конфликтуют, поэтому
  // штатная работа не сериализуется; ждать приходится только вокруг восстановления.
  for (const [name, run] of [
    ['удаление контакта', async (app, cookie) => {
      await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов' }, headers: { cookie } })
      return app.inject({ method: 'DELETE', url: '/api/crm/contacts/1', headers: { cookie } })
    }],
    ['прямое обезличивание контакта', async (app, cookie) => {
      await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов' }, headers: { cookie } })
      return app.inject({ method: 'POST', url: '/api/crm/contacts/1/anonymize', headers: { cookie } })
    }],
    ['правка контакта', async (app, cookie) => {
      await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов' }, headers: { cookie } })
      return app.inject({ method: 'PATCH', url: '/api/crm/contacts/1', payload: { note: 'x' }, headers: { cookie } })
    }],
    ['приём заявки с сайта', async (app) => app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'М', contact: 'm@x.ru' } })],
    ['приём запроса по ПДн', async (app) => app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'm@x.ru' } })],
  ]) {
    it(`${name} берёт разделяемый барьер первым действием`, async () => {
      watch = watchPool(app.db.pool)
      const res = await run(app, cookie)
      expect(res.statusCode).toBeLessThan(400)

      const tx = watch.transactions().at(-1)
      expect(tx[0]).toBe('BEGIN')
      const b = barrierOf(tx)
      expect(b, 'мутация не взяла барьер — её чтение может прийтись на дореcторные данные').toBeGreaterThanOrEqual(0)
      expect(tx[b].includes('pg_advisory_xact_lock_shared'), 'мутации нужен РАЗДЕЛЯЕМЫЙ барьер, иначе они сериализуются между собой').toBe(true)
      // Барьер обязан стоять РАНЬШЕ любого обращения к данным — барьер после чтения
      // не защищает ничего. Проверяем это по существу, а не по номеру позиции:
      // перед ним допустима только служебная подготовка (BEGIN, SET LOCAL).
      const firstData = tx.findIndex((q) => /^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.test(q) && !q.includes('pg_advisory_xact_lock'))
      expect(firstData === -1 || b < firstData, `до барьера уже прочитали данные: ${tx.slice(0, b + 1).join(' | ')}`).toBe(true)
    })
  }

  it('удаление контакта со сделками по-прежнему отвечает 409, а не удаляет', async () => {
    // Проверка «есть ли сделки» переехала внутрь транзакции — внешнее поведение
    // обязано остаться прежним.
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов' }, headers: { cookie } })
    await app.inject({ method: 'POST', url: '/api/crm/deals', payload: { contact_id: 1, title: 'Пилот' }, headers: { cookie } })
    const res = await app.inject({ method: 'DELETE', url: '/api/crm/contacts/1', headers: { cookie } })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toBe('has_deals')
    expect((await app.db.prepare('SELECT COUNT(*) c FROM contacts').get()).c).toBe(1)
  })

  it('раздел ПДн и импорт больше не берут таблицы встречным порядком', async () => {
    // Раздел ПДн блокировал pd_requests, затем contacts; импорт — contacts, затем
    // pd_requests. Встречное ожидание давало 40P01, а обработчик импорта переводит
    // любую ошибку в «битый файл» — владелец увидел бы «дамп повреждён» на целом
    // бэкапе. Теперь обе стороны начинают с ОДНОГО барьера, и цикл замкнуть нечем.
    await app.inject({ method: 'POST', url: '/api/crm/contacts', payload: { name: 'Иванов', email: 'i@x.ru' }, headers: { cookie } })
    await app.inject({
      method: 'POST', url: '/api/crm/pd-requests',
      payload: { contact_id: 1, kind: 'delete', requester: 'i@x.ru' }, headers: { cookie },
    })

    watch = watchPool(app.db.pool)
    const res = await app.inject({
      method: 'PATCH', url: '/api/crm/pd-requests/1', payload: { note: 'уточнение' }, headers: { cookie },
    })
    expect(res.statusCode).toBe(200)

    const tx = watch.transactions().at(-1)
    const b = barrierOf(tx)
    expect(b, 'раздел ПДн не взял барьер').toBeGreaterThanOrEqual(0)
    // барьер РАНЬШЕ первой блокировки строки — иначе порядок захвата снова свой
    const firstRowLock = tx.findIndex((q) => q.includes('FOR UPDATE'))
    expect(firstRowLock).toBeGreaterThan(b)
  })
})

// ---------------------------------------------------------------------------
// Пятый раунд (gstack /review, шесть специалистов): блокеры восстановления
// ---------------------------------------------------------------------------
// Два из трёх блокеров ниже — предсуществующие, а не последствия правок: они стали
// фатальными именно после перехода на Postgres, где появились настоящие внешние ключи.

describe('восстановление из дампа: блокеры, найденные ревью специалистов', () => {
  let watch
  afterEach(() => { watch?.restore(); watch = null })

  it('дамп больше 1 МБ не отбивается потолком тела запроса', async () => {
    // У Fastify потолок по умолчанию 1 МБ, и без явного bodyLimit импорт отвечал 413
    // ещё ДО обработчика — то есть единственный путь аварийного восстановления
    // (ADR-013) не работал на любой реальной базе. Проверено независимым ревью на
    // дампе 1.89 МБ. Здесь берём заведомо больший объём и самый дешёвый повод для
    // отказа (версия из будущего), чтобы тест мерил именно приём тела, а не вставку.
    const payload = { version: DUMP_VERSION + 1, contacts: [], _pad: 'x'.repeat(1_500_000) }
    const res = await app.inject({ method: 'POST', url: '/api/crm/import', payload, headers: { cookie } })
    expect(res.statusCode, 'тело дампа отбито потолком — восстановление невозможно').not.toBe(413)
    expect(JSON.parse(res.body).error).toBe('newer_version')
  })

  it('очередь уведомлений очищается импортом — иначе уйдут ПДн другого человека', async () => {
    // outbox намеренно обезличен: в нём только contactId, а имя и телефон достаются
    // из БД В МОМЕНТ ОТПРАВКИ (ADR-009). После восстановления контакты заменены
    // целиком, и пережившая импорт строка разрешила бы свой contactId в другого
    // человека — его ПДн ушли бы в MAX под видом свежей заявки.
    await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'm@x.ru' } })
    expect((await app.db.prepare('SELECT COUNT(*) c FROM outbox').get()).c).toBeGreaterThan(0)

    const dump = JSON.parse((await app.inject({ method: 'GET', url: '/api/crm/export', headers: { cookie } })).body)
    expect((await app.inject({ method: 'POST', url: '/api/crm/import', payload: dump, headers: { cookie } })).statusCode).toBe(200)
    expect((await app.db.prepare('SELECT COUNT(*) c FROM outbox').get()).c, 'очередь пережила восстановление').toBe(0)
  })

  itPg('поиск дубля у заявки идёт ВНУТРИ транзакции, после барьера', async () => {
    // ТОЛЬКО на живой базе: под pg-mem connect() отдаёт сам пул, поэтому запрос,
    // отправленный МИМО транзакции, всё равно попадает в её лог — тест был бы
    // ложно-зелёным (проверено: с откаченной правкой он проходит под pg-mem и
    // краснеет под настоящим Postgres).
    // Барьер защищает только то, что за ним. Дедупликация решает, ЗАВЕСТИ контакт или
    // дописать в существующий; читая её через пул, мы принимали решение до барьера,
    // а писали после — во время восстановления это смешивало ПДн двух людей.
    watch = watchPool(app.db.pool)
    const res = await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Марина', contact: 'm@x.ru' } })
    expect(res.statusCode).toBe(204)

    const tx = watch.transactions().find((t) => t.some((q) => q.includes('INSERT INTO consents')))
    expect(tx, 'ожидали транзакцию приёма заявки').toBeTruthy()
    const at = (needle) => tx.findIndex((q) => q.includes(needle))
    expect(at('pg_advisory_xact_lock'), 'заявка не взяла барьер').toBeGreaterThanOrEqual(0)
    expect(at('archived FROM contacts'), 'дедупликация читается мимо транзакции').toBeGreaterThan(at('pg_advisory_xact_lock'))
  })

  itPg('поиск контакта у запроса по ПДн идёт ВНУТРИ транзакции, после барьера', async () => {
    // Здесь цена ошибки выше всего: этот contact_id потом служит основанием для
    // НЕОБРАТИМОГО обезличивания.
    watch = watchPool(app.db.pool)
    const res = await app.inject({ method: 'POST', url: '/api/pd-requests', payload: { contact: 'm@x.ru' } })
    expect(res.statusCode).toBe(204)

    const tx = watch.transactions().find((t) => t.some((q) => q.includes('INSERT INTO pd_requests')))
    expect(tx, 'ожидали транзакцию приёма запроса').toBeTruthy()
    const at = (needle) => tx.findIndex((q) => q.includes(needle))
    expect(at('pg_advisory_xact_lock'), 'запрос не взял барьер').toBeGreaterThanOrEqual(0)
    expect(at('SELECT id FROM contacts WHERE anonymized_at IS NULL'), 'поиск контакта мимо транзакции')
      .toBeGreaterThan(at('pg_advisory_xact_lock'))
  })

  itPg('настоящая ошибка базы НЕ глотается как «движок не умеет»', async () => {
    // Три функции адаптера отличали эмулятор от боевого отказа подстрокой в тексте,
    // и все три ошибались опасно: настоящий Postgres выдаёт `syntax error` при кривом
    // LOCK TABLE, а `permission denied for function pg_advisory_xact_lock` содержит имя
    // функции. Теперь разделитель — SQLSTATE: у боевой ошибки код есть всегда.
    // Под pg-mem непроверяемо: там у ошибок кода нет вовсе, на том и построен разбор.
    await expect(lockTablesForRestore(app.db, ['не существует такой таблицы']))
      .rejects.toThrow()
  })

  itPg('мутация не ждёт барьер вечно, а отвечает 503 и освобождает соединение', async () => {
    // Соединение пула занято и BEGIN уже выполнен к моменту ожидания барьера. Без
    // потолка десяти публичных запросов во время восстановления хватало, чтобы выпить
    // пул и подвесить ВСЁ, включая проверку сессии и чтения дашборда — ровно то, чего
    // мы избегали, выбирая EXCLUSIVE вместо ACCESS EXCLUSIVE.
    const holder = await app.db.pool.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock($1)', [4127001])
      const started = Date.now()
      const res = await app.inject({ method: 'POST', url: '/api/leads', payload: { name: 'Ждун', contact: 'w@x.ru' } })
      const waited = Date.now() - started
      expect(res.statusCode, 'запрос обязан отказаться, а не висеть').toBe(503)
      expect(JSON.parse(res.body).error).toBe('maintenance')
      expect(waited, 'ждал дольше собственного потолка').toBeLessThan(15000)
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      holder.release()
    }
    // Потолок теста заведомо больше BARRIER_WAIT_MS (5 с): по умолчанию у vitest
    // ровно 5 с, и тест падал бы по таймауту раньше, чем сработает проверяемый отказ.
  }, 30000)
})
