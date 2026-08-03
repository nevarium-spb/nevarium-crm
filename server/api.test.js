// @vitest-environment node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp, mskToday } from './app.js'
import { hashPassword, resetThrottle, verifyPassword, volatileSize, reserveVerify, serializeVerify, verifyOrFake, admitLoginRequest, releaseLoginRequest, inFlightLoginCount, MAX_BUCKETS, MAX_QUEUED_PER_KEY, MAX_QUEUED_PER_SOURCE, MAX_INFLIGHT_LOGIN_REQUESTS, THROTTLE_IP_FREE_ATTEMPTS } from './auth.js'
import { bootstrapAdmin } from './bootstrap.js'
import { validSeedInput } from './seed-admin.js'
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
})

describe('APP_ORIGIN: строгая CSRF-проверка, когда домен CRM настроен явно', () => {
  // Независимый аудит: сравнение с X-Forwarded-Host — это сравнение с заголовком,
  // который в общем случае подставляет клиент, а не прокси. Явный APP_ORIGIN
  // такой лазейки не оставляет — сравниваем строго с настроенным значением.
  let strictApp, strictCookie

  beforeEach(async () => {
    strictApp = buildApp({ secure: false, appOrigin: 'https://crm-nevarium.ru' })
    strictApp.db.prepare('INSERT INTO users (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)')
      .run('Админ', 'a@a.ru', await hashPassword('password123'), 'admin', now())
    await strictApp.ready()
    strictCookie = (await strictApp.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@a.ru', password: 'password123' } })).headers['set-cookie']
  })
  afterEach(() => strictApp.close())

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
    const env = { BOOTSTRAP_ADMIN_EMAIL: 'Boss@Example.ru', BOOTSTRAP_ADMIN_PASSWORD: 'supersecret12345' }
    const created = await bootstrapAdmin(app.db, { log: silent, env })
    expect(created).toBe(true)
    const user = app.db.prepare('SELECT * FROM users WHERE email = ?').get('boss@example.ru')
    expect(user).toMatchObject({ role: 'admin', name: 'Админ' })
    expect(await verifyPassword('supersecret12345', user.password_hash)).toBe(true)
  })

  it('не трогает базу, если пользователи уже есть', async () => {
    const before = app.db.prepare('SELECT COUNT(*) c FROM users').get().c
    const created = await bootstrapAdmin(app.db, {
      log: silent,
      env: { BOOTSTRAP_ADMIN_EMAIL: 'x@x.ru', BOOTSTRAP_ADMIN_PASSWORD: 'supersecret12345' },
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

  it('ровно 15 символов — отказ, ровно 16 — создаётся (граница MIN_ADMIN_PASSWORD_LENGTH)', async () => {
    app.db.exec('DELETE FROM users')
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
