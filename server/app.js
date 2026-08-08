import fs from 'node:fs'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import staticPlugin from '@fastify/static'
import { DEFAULT_PROJECT_ID, DUMP_TABLES, DUMP_VERSION, PD_REQUEST_KINDS, WINBACK_STEPS, addWorkdays, buildDump, openDb, now, STAGES, TERMINAL_STAGES } from './db.js'
import { hashPassword, verifyPassword, fakeVerifyDelay, verifyOrFake, signToken, verifyToken, reserveVerify, loginSucceeded, sleep, admitLoginRequest, releaseLoginRequest, SESSION_TTL_DAYS, MIN_PASSWORD_LENGTH, MIN_ADMIN_PASSWORD_LENGTH } from './auth.js'
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
// Тот же экранировщик, что в telegram.js (leadMessage/leadMessageFull) — уведомления
// идут с format: 'html', и непроверенный текст в них ломает разметку. Нужен здесь
// отдельно: kind в /api/pd-requests теперь сохраняется как прислано (см. ниже), и
// именно НЕРАСПОЗНАННЫЙ (то есть непроверенный, публикой присланный) kind попадает
// в текст уведомления, если его не экранировать.
const escHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Доверенных прокси-хопов по умолчанию — один (App Platform). Тесты и dev создают
// приложение без прокси: с trustProxy=1 и без X-Forwarded-For req.ip = адрес сокета.
const TRUST_PROXY = Number(process.env.TRUST_PROXY_HOPS) || 1

// Явно настроенный домен CRM для CSRF-проверки Origin на мутациях — например
// https://crm-nevarium.ru. Не задан по умолчанию: заполняется в деплое (см.
// deploy/.env.example), а в dev/тестах фронт и бэкенд на разных портах, и
// единственного правильного значения нет — там остаётся прежний, менее строгий
// путь сравнения с X-Forwarded-Host.
const APP_ORIGIN = trim(process.env.APP_ORIGIN, 300) || null

export function buildApp({ dbFile = ':memory:', secret = 'dev-secret', secure = true, logger = false, staticDir = null, trustProxy = TRUST_PROXY, appOrigin = APP_ORIGIN } = {}) {
  const db = openDb(dbFile)
  // trustProxy — число доверенных прокси-хопов, НЕ `true`. С `true` Fastify берёт
  // самый левый X-Forwarded-For как req.ip, а его подставляет клиент — тогда всё,
  // что смотрит на req.ip, обманывается сменой заголовка. Безопасность логина от
  // этого больше не зависит (троттлинг ключуется по email, см. ниже), но req.ip
  // ещё нужен антиспаму заявок (leadSuspicious) и логам. С числом N доверяем N
  // хопам с правого края, где реальный прокси проставил IP. На App Platform перед
  // контейнером один прокси → 1; за ним внешний клиент не может подделать свой IP
  // (его инъекция остаётся левее доверенного хопа). Если у Timeweb окажется больше
  // хопов, req.ip выродится в общий IP прокси — антиспам станет глобальнее, не
  // слабее. Подкручивается переменной TRUST_PROXY_HOPS без правки кода.
  const app = Fastify({ logger, trustProxy })
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
  // Жёсткий потолок поверх мягкого leadSuspicious (ТЗ сайта Визор, п.1.2,
  // docs/CRM-REQUIREMENTS.md в G:\nevarium_vizor). leadSuspicious специально
  // никогда не отказывает (см. выше) — но совсем без верхней границы публичный
  // эндпоинт беззащитен перед прямым POST в обход браузера: адреса и структура
  // payload видны в открытом JS-бандле сайта, curl их бьёт напрямую, минуя всю
  // клиентскую защиту (honeypot, maxLength). Порог здесь НАМНОГО щедрее примера
  // из ТЗ («5 за 10 минут») — тот заденет офис на одном IP/CGNAT после пары
  // настоящих заявок подряд, а весь смысл мягкого лимита выше — не отказывать
  // именно таким. Раздельные счётчики на leads и pd-requests: флуд одного не
  // должен спускать лимит соседнему. При превышении — 429 (сайт трактует его как
  // «доставка не подтверждена, повторить с тем же Idempotency-Key» — заявка не
  // теряется, если идемпотентность включена, см. ниже).
  const HARD_LIMIT_WINDOW_MS = 10 * 60_000
  const HARD_LIMIT_MAX = 30
  const hardHits = { leads: new Map(), pd_requests: new Map() }
  // Массив на IP держим ОГРАНИЧЕННЫМ: раз решили «уже сверх лимита», новые метки
  // времени больше не добавляем — независимая проверка нашла, что без этого сам
  // счётчик становится усилителем атаки: при затяжном флуде массив растёт на каждый
  // запрос без верхней границы, а filter() каждый раз перебирает его целиком —
  // O(n²) суммарно и неограниченная память ровно во время атаки, которую лимитер
  // должен сдерживать. Раз список уже не растёт после HARD_LIMIT_MAX, filter() и
  // при непрерывном флуде остаётся O(HARD_LIMIT_MAX) — константа, не размер атаки.
  function hardRateLimited(scope, ip) {
    const nowMs = Date.now()
    const store = hardHits[scope]
    const list = (store.get(ip) || []).filter((t) => nowMs - t < HARD_LIMIT_WINDOW_MS)
    if (list.length >= HARD_LIMIT_MAX) {
      store.set(ip, list)
      return true
    }
    list.push(nowMs)
    store.set(ip, list)
    return false
  }

  // Срок хранения idempotency_keys — сильно больше любого разумного окна ретраев
  // (сайт ждёт таймаут 10 с и предлагает повтор человеку, не часами) но не вечно:
  // независимая проверка указала, что публичный неаутентифицированный эндпоинт без
  // потолка на хранение — durable-поверхность для флуда уникальными ключами (в
  // отличие от leadHits/hardHits, это таблица в БД на диске, не Map в памяти,
  // которая хотя бы обнуляется рестартом). Сутки — с большим запасом.
  const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60_000

  const leadSweep = setInterval(() => {
    const nowMs = Date.now()
    for (const [ip, list] of leadHits) {
      if (!list.length || nowMs - list[list.length - 1] > LEAD_WINDOW_MS) leadHits.delete(ip)
    }
    for (const store of Object.values(hardHits)) {
      for (const [ip, list] of store) {
        if (!list.length || nowMs - list[list.length - 1] > HARD_LIMIT_WINDOW_MS) store.delete(ip)
      }
    }
    try {
      db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(new Date(nowMs - IDEMPOTENCY_RETENTION_MS).toISOString())
    } catch {
      // База может быть уже закрыта при выключении (onClose гонится с последним
      // тиком интервала) — не роняем процесс из-за фонового обслуживания.
    }
  }, 5 * 60_000)
  leadSweep.unref?.()
  app.addHook('onClose', (_i, done) => {
    clearInterval(leadSweep)
    done()
  })

  // Идемпотентность публичного приёма (ТЗ сайта, п.1.1). Сайт при таймауте/обрыве
  // повторяет POST с ТЕМ ЖЕ ключом (заголовок Idempotency-Key ИЛИ поле request_id
  // в теле — оба, на случай если прокси срежет нестандартный заголовок). Повтор
  // обязан вернуть тот же код ответа, а не создать вторую заявку/запрос — для
  // запроса по ПДн дубль это ещё и второй 10-дневный срок по 152-ФЗ.
  //
  // Осознанно НЕ защищено от гонки между ДВУМЯ ПРОЦЕССАМИ, читающими один и тот же
  // ключ одновременно (независимая проверка подняла это как отдельный риск): при
  // истинной многопроцессности оба могли бы пройти idempotencyReplay ДО того, как
  // любой из них закоммитит, и оба выполнили бы бизнес-запись. В деплое этого
  // проекта это недостижимо — один контейнер, один процесс Node, better-sqlite3
  // синхронный (ADR-003: SQLite — однопроцессный писатель по конструкции), и внутри
  // ОДНОГО процесса JS однопоточный: между idempotencyReplay и записью ключа внутри
  // db.transaction() нет ни одного await, событийному циклу неоткуда вклиниться со
  // вторым запросом на той же самой проверке. Добавлять кросс-процессную блокировку
  // здесь значило бы решать проблему архитектуры, которой в проекте нет и не
  // планируется (App Platform, 1 контейнер).
  // Не обрезаем длинный ключ до 200 символов — два РАЗНЫХ ключа, различающихся только
  // после символа 200, иначе схлопнулись бы в один и потеряли бы одну из отправок.
  // Контракт сайта — UUID (36 символов), 200 уже щедрый запас; ключ длиннее просто
  // не участвует в идемпотентности (как будто его не прислали), не обрубается вслепую.
  function idempotencyKey(req, b) {
    const raw = String(req.headers['idempotency-key'] ?? '').trim() || String(b?.request_id ?? '').trim()
    return raw.length > 0 && raw.length <= 200 ? raw : ''
  }
  // ОСОЗНАННО ПРИНЯТЫЙ ОСТАТОЧНЫЙ РИСК, поднятый независимой проверкой ЧЕТЫРЕЖДЫ
  // подряд (раунды адверсариального ревью этой сессии) — не оставленный без внимания,
  // а рассмотренный и отклонённый: НЕ сверяем содержимое повтора с исходным (ключ,
  // переиспользованный для ДРУГОГО контента, тихо вернул бы кешированный ответ первой
  // отправки). Это прямо противоречило бы контракту сайта: «ключ одинаковый на всех
  // повторах ОДНОЙ ЛОГИЧЕСКОЙ отправки. Сайт специально НЕ генерирует новый ключ при
  // повторном нажатии» (ТЗ, §1.1, docs/CRM-REQUIREMENTS.md в G:\nevarium_vizor) —
  // переиспользование ключа для РАЗНОГО контента означало бы клиента, нарушающего
  // СОБСТВЕННЫЙ контракт (баг на стороне сайта или чужой интегратор), а не штатный
  // сценарий, который эта система обязана обслуживать. Проверка содержимого добавила
  // бы хеш полезной нагрузки, новую схему и новый код ответа (409), которого сайт
  // вообще не ждёт по своей же таблице интерпретации ответов (2xx/4xx/5xx/429) — не
  // соразмерно риску, который сам контракт объявляет невозможным. Если это когда-нибудь
  // изменится (сайт начнёт легитимно переиспользовать ключи для разного контента) —
  // это отдельная, согласованная с сайтом смена контракта, не тихий фикс здесь.
  function idempotencyReplay(scope, requestId) {
    if (!requestId) return null
    const row = db.prepare('SELECT status_code FROM idempotency_keys WHERE scope = ? AND request_id = ?').get(scope, requestId)
    return row ? row.status_code : null
  }
  // Пишем только терминальные исходы (200/204/400) — НЕ 429: тот обязан оставаться
  // повторяемым, застолбить ключ на первом же отказе по лимиту значило бы, что
  // повтор с тем же ключом навсегда получает 429, даже когда лимит уже снят.
  function idempotencyRecord(scope, requestId, statusCode) {
    if (!requestId) return
    try {
      db.prepare('INSERT INTO idempotency_keys (scope, request_id, status_code, created_at) VALUES (?, ?, ?, ?)').run(scope, requestId, statusCode, now())
    } catch (err) {
      // Ловим ТОЛЬКО ожидаемый UNIQUE-конфликт (параллельный повтор той же логической
      // отправки уже записал этот ключ первым — наш ответ клиенту всё равно верный).
      // Любую другую ошибку (диск, повреждение БД) пробрасываем дальше — независимая
      // проверка нашла: широкий catch{} проглотил бы её молча, и для путей БЕЗ общей
      // транзакции (honeypot/пустой лид — этот вызов сам по себе, не внутри чужого
      // db.transaction()) это означало бы «мы решили, что записали ключ, а на самом
      // деле нет» без единого следа.
      if (err.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err
    }
  }

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
      const origin = req.headers.origin
      if (appOrigin) {
        // Независимая проверка нашла: сравнение с X-Forwarded-Host — это сравнение
        // с заголовком, который в общем случае подставляет КЛИЕНТ, а не только
        // прокси (Fastify доверяет ему целиком при любом truthy trustProxy — число
        // хопов защищает разбор X-Forwarded-For как списка, но X-Forwarded-Host не
        // список, там нечего разбирать по хопам). Когда домен CRM настроен явно,
        // сравниваем строго с ним и клиентским заголовкам вообще не доверяем.
        // Отсутствие Origin здесь ТОЖЕ запрещено (в мягком пути ниже — нет): настоящий
        // браузер шлёт Origin на мутирующий fetch даже в пределах одного домена,
        // поэтому легитимный фронт это не заденет, а обходной путь «просто не
        // прислать заголовок» закрывается.
        if (origin !== appOrigin) return reply.code(403).send({ error: 'forbidden' })
      } else if (origin) {
        // APP_ORIGIN не настроен (dev/тесты, где фронт и бэкенд на разных портах,
        // единственного верного значения нет) — прежний, более мягкий путь: за
        // прокси (Caddy/Vite) реальный хост приходит в X-Forwarded-Host.
        const selfHost = req.headers['x-forwarded-host'] || req.headers.host
        if (new URL(origin).host !== selfHost) return reply.code(403).send({ error: 'forbidden' })
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
    // Потолок на ЗАПРОС, до всего остального: reserveVerify резервирует слот
    // синхронно (закрывает гонку «проверил — потом сделал»), но сама фаза ожидания
    // своего слота ничем не была ограничена по числу одновременных ожидающих —
    // независимая проверка (Codex, 6-й раунд) нашла, что это истощение ресурсов
    // само по себе, раньше, чем дело дойдёт до bcrypt-очереди. Потолок общий на все
    // email — ничего не выдаёт про конкретный аккаунт, троттлинг ключа не трогает.
    if (!admitLoginRequest()) return reply.code(503).send({ error: 'overloaded' })
    try {
      const email = trim(req.body?.email, 200).toLowerCase()
      const password = String(req.body?.password ?? '')
      // Логин не отвечает 401-до-проверки по конкретному аккаунту нигде: отказ до
      // проверки пароля позволял бы любому, кто знает адрес владельца (а он
      // опубликован на сайте), запереть его в CRM пятью запросами. Вместо отказа —
      // очередь на проверку (reserveVerify), и верный пароль проходит, как только
      // слот подошёл. Ответы всегда 401 или 200, поэтому по коду ответа тоже ничего
      // не утекает (503 выше — про общую перегрузку сервера, не про этот email).
      const emailKey = `email:${email}`
      // Слот резервируем СИНХРОННО, до первого await, и для ЛЮБОГО email — существует
      // аккаунт или нет. Синхронность закрывает гонку «проверил — потом сделал»: иначе
      // пачка параллельных запросов читает старое значение и проходит лимит целиком.
      // Одинаковость для существующих и несуществующих закрывает оракул: если ждать
      // только на реальных адресах, разница во времени ответа сама выдаёт, какой
      // аккаунт есть.
      // Пользователя ищем здесь же: поиск синхронный (better-sqlite3), значит остаётся
      // в том же неразрывном участке. Существующие аккаунты получают корзину в
      // невытесняемом хранилище — иначе спрей мусорных адресов выбивал бы корзину
      // владельца и тем самым сбрасывал его лимит.
      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email)
      const emailWait = reserveVerify(emailKey, { durable: Boolean(user) })

      // Ждём свой слот. Отказ ЗДЕСЬ, до какой-либо проверки, был бы плохим: атакующий,
      // держа очередь резервирования переполненной, не давал бы владельцу дойти даже
      // до попытки войти. Ниже, после ожидания, ограничение другого рода — не отказ,
      // а решение «настоящий bcrypt или дешёвая заглушка», см. verifyOrFake.
      if (emailWait) await sleep(emailWait)

      // Несуществующий email — ВСЕГДА fakeVerifyDelay, и ВСЕГДА мимо очереди bcrypt.
      // Раньше первые THROTTLE_IP_FREE_ATTEMPTS несуществующих email на IP шли на
      // настоящий bcrypt (против DUMMY_PASSWORD_HASH) и тоже вставали в общий шлюз —
      // а для КАЖДОГО нового уникального email слот резервируется мгновенно (это его
      // первое обращение, emailWait=0). Независимая проверка поймала: поток из тысяч
      // уникальных несуществующих адресов уходил в ту же очередь, что и настоящий
      // логин владельца, и вставал впереди него — без потолка на длину очереди
      // владелец ждал бы весь этот поток целиком. fakeVerifyDelay же не тратит CPU —
      // это просто setTimeout, параллелить его безопасно и незачем через что-либо
      // проводить: тайминг совпадает с реальным bcrypt (self-calibrated, см. auth.js).
      //
      // Существующий email тоже больше не идёт в очередь безусловно: verifyOrFake
      // (auth.js) пускает на реальный bcrypt не больше MAX_QUEUED_PER_KEY проверок
      // ОДНОГО ключа одновременно, а сверх потолка — тот же дешёвый fakeVerifyDelay.
      // Это закрывает находку Codex: флуд на известный email владельца (он опубликован
      // на сайте) раньше вставал в serializeVerify БЕЗ ограничения на длину очереди —
      // при тысячах параллельных попыток владелец мог ждать очередь целиком (~20 минут
      // при 5000 попытках).
      //
      // req.ip — источник для ВТОРОГО потолка (MAX_QUEUED_PER_SOURCE) внутри
      // verifyOrFake: без него первая версия потолка была гонкой за свободный слот,
      // которую при НЕПРЕРЫВНОМ флуде с одного адреса атакующий выигрывал числом
      // попыток. Один слот на источник гарантирует: попытка с ДРУГОГО адреса, чем у
      // атакующего, всегда находит свободный слот немедленно. req.ip в этом деплое
      // доверенный (TRUST_PROXY_HOPS, см. выше), не подделывается клиентским
      // заголовком. Осознанный остаточный риск (Codex, 6-й раунд): если владелец
      // физически окажется за тем же внешним IP, что и атакующий (CGNAT, офисный
      // NAT — в РФ не редкость, см. leadSuspicious про ту же тему на приёме заявок),
      // источниковый потолок не различает их — как и распределённая атака с
      // MAX_QUEUED_PER_KEY и более разных источников. От такого защищает не этот
      // файл, а стойкость самого пароля (16 символов для admin, см. auth.js) и
      // инфраструктурные меры (rate limit на прокси) — сознательно вне этого диффа.
      const ok = user
        ? await verifyOrFake(emailKey, req.ip, () => verifyPassword(password, user.password_hash))
        : await fakeVerifyDelay().then(() => false)
      if (!user || !ok) {
        // Счётчик уже увеличен выше, при входе в обработчик — повторно не считаем.
        return reply.code(401).send({ error: 'invalid_credentials' })
      }
      loginSucceeded(emailKey, { durable: true })
      const token = signToken({ uid: user.id, tokenVersion: user.token_version }, secret)
      reply.setCookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: SESSION_TTL_DAYS * 86400 })
      return { id: user.id, name: user.name, email: user.email, role: user.role }
    } finally {
      releaseLoginRequest()
    }
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
    return buildDump(db)
  })

  app.post('/api/crm/import', async (req, reply) => {
    if (req.user.role !== 'admin') return reply.code(403).send({ error: 'admin_only' })
    const data = req.body
    if (!data || typeof data !== 'object' || !Array.isArray(data.contacts)) return reply.code(400).send({ error: 'bad_file' })
    if (data.version > DUMP_VERSION) return reply.code(400).send({ error: 'newer_version' })
    // Дамп v1 (до 2026-07-30) не содержал запросов ПДн и журнала. Такой файл
    // восстанавливать можно, но затирать им сегодняшние записи об исполнении
    // запросов нельзя — их там просто нет, а не «нет ни одной».
    const hasCompliance = Array.isArray(data.pd_requests)
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
    // У таблиц вне ENTITIES нет конфига CRUD — перечисляем их колонки явно.
    const PLAIN_COLS = {
      pd_requests: ['contact_id', 'kind', 'status', 'requester', 'note', 'source', 'project_id', 'due_date', 'resolved_at', 'resolved_by', 'verified_at', 'created_at', 'updated_at'],
      audit_log: ['user_id', 'user_email', 'action', 'entity', 'entity_id', 'detail', 'created_at'],
    }
    const allowedCols = (n) =>
      PLAIN_COLS[n]
        ? new Set(PLAIN_COLS[n])
        : new Set([...ENTITIES[n].fields, ...(EXTRA_COLS[n] ?? []), 'demo', 'created_at', 'updated_at', 'created_by'])
    const counts = {}
    try {
      db.transaction(() => {
        // winback_sequences ссылается на deals и contacts НАСТОЯЩИМ внешним ключом и в
        // дамп не входит — без этой очистки его строки блокируют `DELETE FROM deals`
        // и импорт падает с «FOREIGN KEY constraint failed» на любой базе, где хоть
        // одна сделка проигрывалась. Серии восстановлению не подлежат: они выводятся
        // из стадии сделки, а стадия в дампе есть.
        db.prepare('DELETE FROM winback_sequences').run()
        // idempotency_keys тоже вне дампа и тоже чистится безусловно (независимая
        // проверка поймала риск: ОСТАВШИЙСЯ старый ключ после импорта более раннего
        // бэкапа ссылался бы на заявку/запрос, которых после restore уже нет — повтор
        // клиента с этим ключом получил бы закешированный 204 «успех», а сервер не
        // воссоздал бы пропавшую запись — тихая потеря данных именно в момент
        // восстановления, худшее время для этого). Ключи короткоживущие по смыслу
        // (окно ретраев формы — секунды-минуты), восстанавливать их из бэкапа не нужно.
        db.prepare('DELETE FROM idempotency_keys').run()
        // Таблицы восстанавливаем те, что есть в дампе: из старого файла (v1)
        // запросы ПДн и журнал не придут, и стирать существующие мы не станем.
        const tables = hasCompliance ? DUMP_TABLES : ENTITY_NAMES
        // удаляем детей раньше родителей (FK), вставляем в прямом порядке
        for (const n of [...tables].reverse()) db.prepare(`DELETE FROM ${n}`).run()
        for (const n of tables) {
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
        // Старый дамп (v1) запросов ПДн не содержит: существующие оставляем как
        // юридический след, но привязку к контакту рвём — контакты только что
        // заменены целиком, и ссылка могла бы указать на ДРУГОГО человека с тем же id.
        // Сам запрос остаётся читаемым: в нём есть адрес заявителя, вид, срок и статус.
        if (!hasCompliance) {
          db.prepare('UPDATE pd_requests SET contact_id = NULL, updated_at = ? WHERE contact_id IS NOT NULL').run(now())
        } else if (!(data.pd_requests ?? []).some((r) => Object.prototype.hasOwnProperty.call(r, 'verified_at'))) {
          // Бэкфилл — ТОЛЬКО если verified_at ОТСУТСТВУЕТ как ключ у ВСЕХ строк дампа
          // (значит дамп снят до появления этой колонки). hasOwnProperty проверяет
          // именно наличие ключа в исходном JSON, не итоговое значение в БД (там null
          // неотличим от null) — иначе безусловный бэкфилл путал бы «поля не было» с
          // «поле было и было null» (последнее — законно неподтверждённый запрос из
          // АКТУАЛЬНОГО дампа, см. соседний тест «актуальный дамп с законным null»).
          //
          // И даже для по-настоящему старого дампа — не грандфазеринг всего подряд,
          // тем же правилом, что в миграции v10 (db.js): открытые публичные запросы
          // (source='site-form', status='new' — единственный статус открытого запроса
          // до появления pending_unverified) НИКОГДА не проходили верификацию, задним
          // числом объявлять их подтверждёнными значило бы восстановить бэкапом ровно
          // ту дыру для имперсонации, ради закрытия которой verified_at появился.
          // 'done'/'rejected' — явным списком, а не «status != 'new'»: у ИМПОРТА (в
          // отличие от миграции, где pending_unverified раньше физически не мог
          // существовать) дамп мог быть текущего формата с уже вырезанным ключом
          // verified_at (см. тест) — тогда status='pending_unverified' у публичного
          // запроса уже стоит, и «!= 'new'» ошибочно засчитал бы его закрытым.
          db.prepare(`UPDATE pd_requests SET verified_at = COALESCE(resolved_at, created_at)
            WHERE verified_at IS NULL AND (source = 'manual' OR status IN ('done', 'rejected'))`).run()
          db.prepare(`UPDATE pd_requests SET status = 'pending_unverified'
            WHERE verified_at IS NULL AND source != 'manual' AND status NOT IN ('done', 'rejected')`).run()
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
    const newRole = role === 'admin' ? 'admin' : 'member'
    // Админский пароль держит стойкость сам, раз лимитеры логина её не гарантируют
    // (см. auth.js) — порог выше и для новых админов, не только для bootstrap.
    const minLen = newRole === 'admin' ? MIN_ADMIN_PASSWORD_LENGTH : MIN_PASSWORD_LENGTH
    if (!name || !email || !password || password.length < minLen) return reply.code(400).send({ error: 'bad_input' })
    try {
      const info = db.prepare('INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)').run(trim(name, 100), trim(email, 200).toLowerCase(), await hashPassword(password), newRole, now())
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
    if (password) {
      // Валидация — ДО любой записи. Раньше имя уже уходило в UPDATE, а невалидный
      // пароль возвращал 400 уже после этого: ответ «ничего не сохранено», а на
      // самом деле имя изменилось — Codex поймал это как частичную запись.
      // Порог зависит от РОЛИ ЦЕЛИ, не от того, кто меняет пароль: смена пароля
      // существующему админу обязана требовать те же 16 символов, что и создание —
      // иначе минимум обходится через смену пароля после создания слабой учётки.
      const target = db.prepare('SELECT role FROM users WHERE id = ?').get(id)
      const minLen = target?.role === 'admin' ? MIN_ADMIN_PASSWORD_LENGTH : MIN_PASSWORD_LENGTH
      if (typeof password !== 'string' || password.length < minLen) return reply.code(400).send({ error: 'bad_input' })
    }
    if (name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(trim(name, 100), id)
    if (password) {
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
  // pending_unverified — дефолтный статус для публичного приёма (source='site-form',
  // см. POST /api/pd-requests ниже): личность отправителя веб-форма не подтверждает,
  // им может быть кто угодно, знающий контакт жертвы. Ручной ввод сотрудником
  // (source='manual') сразу получает 'new' — личность уже подтверждена самим фактом
  // разговора. PATCH .../anonymize блокирует исполнение, пока статус не переведён
  // дальше pending_unverified — это и есть шаг «человек проверил» (ADR-015).
  const PD_STATUSES = ['pending_unverified', 'new', 'done', 'rejected']

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
        ${where} ORDER BY r.status IN ('new', 'pending_unverified') DESC, r.due_date, r.id DESC LIMIT 500`)
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
    // verified_at сразу — ручной ввод сотрудником уже подтверждён самим фактом
    // разговора/переписки, вторично верифицировать в интерфейсе нечего.
    const info = db.prepare(`INSERT INTO pd_requests (contact_id, kind, requester, note, source, project_id, due_date, verified_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(contactId, kind, requester, trim(b.note, 1000), 'manual', projectId, addWorkdays(mskToday()), ts, ts, ts)
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

    // Сначала ВСЯ валидация, ни одной записи в БД — только потом мутации одной
    // транзакцией (обход, который на этом настоял: {status:'new', anonymize:true}
    // одним PATCH иначе успевал записать status ДО того, как anonymize его проверит).
    let contactId = row.contact_id
    let contactChanged = false
    if (b.contact_id !== undefined) {
      contactId = b.contact_id === null || b.contact_id === '' ? null : Number(b.contact_id)
      if (contactId !== null) {
        // ВНУТРИ проекта запроса, не просто «существует» — независимая проверка
        // нашла: без этого запрос из одного бизнеса можно привязать к контакту
        // ДРУГОГО (Лаб ИИ ↔ Визор), «подтвердить» и в итоге обезличить чужого
        // человека. Та же граница, что уже применена к автопоиску контакта выше
        // (ADR-014) и должна была быть здесь с самого начала этого эндпоинта.
        const target = db.prepare('SELECT project_id FROM contacts WHERE id = ?').get(contactId)
        if (!target || target.project_id !== row.project_id) return reply.code(400).send({ error: 'bad_reference' })
      }
      contactChanged = contactId !== row.contact_id
    }
    // Обезличивание — необратимо и по чувствительности сравнимо с прямым
    // POST /api/crm/contacts/:id/anonymize, у которого уже есть admin_only.
    // У ЭТОГО пути такой проверки не было вообще — независимая проверка нашла
    // прямой обход: участник (не admin) мог сам подтвердить личность запроса и
    // тем же PATCH обезличить контакт.
    if (b.anonymize === true && req.user.role !== 'admin') return reply.code(403).send({ error: 'admin_only' })
    if (b.status !== undefined && !PD_STATUSES.includes(b.status)) return reply.code(400).send({ error: 'bad_input' })
    // done/anonymize сверяются с `row.verified_at` — фактом, который НЕЛЬЗЯ обнулить
    // никаким последующим PATCH статуса, а не с текущим `status`. Независимая
    // проверка нашла обход прежней версии (гейт «status ≠ pending_unverified»):
    // 'rejected' достижим БЕЗ верификации (отказ ничего не раскрывает, поэтому
    // разрешён), но сам по себе снимает pending_unverified — PATCH1 {status:
    // 'rejected'}, PATCH2 {anonymize:true} проходил ЛОЖНО. verified_at выставляется
    // РОВНО один раз — при явном переходе pending_unverified → new (см. ниже).
    //
    // НО verified_at подтверждает личность ПРО КОНКРЕТНЫЙ contact_id, а не вообще:
    // если contact_id меняют В ЭТОМ ЖЕ запросе (contactChanged), старая верификация
    // была про ДРУГОГО человека — независимая проверка поймала именно это: привязать
    // «проверенный» запрос к чужому контакту и тут же обезличить его одним PATCH.
    if (b.status === 'done' && (contactChanged || !row.verified_at)) return reply.code(400).send({ error: 'not_verified' })
    // «Подтвердить личность» (переход в new из pending_unverified) без привязанного
    // контакта бессмысленен и опасен: подтверждать личность полагается по каналу ИЗ
    // КАРТОЧКИ в CRM, а без contactId такой карточки просто нет. Отклонить (rejected)
    // без контакта по-прежнему можно — отказ ничего не раскрывает.
    //
    // effectiveStatus, а не row.status напрямую: смена контакта (relink) сбрасывает
    // верификацию УЖЕ В ЭТОМ ЖЕ запросе (см. мутацию ниже) — без этого учёта
    // {contact_id: новый, status: 'new'} одним PATCH проходил бы валидацию (row.status
    // мог быть 'new' ДО этого запроса, не 'pending_unverified'), записывал бы status='new',
    // но verified_at остался бы NULL: снаружи выглядит «в порядке», а через интерфейс
    // не исполнить никогда — независимая проверка поймала эту дыру. С effectiveStatus
    // relink+verify одним запросом становится тем же легитимным действием, что и
    // самая первая привязка контакта («привязать и тут же подтвердить — можно»).
    const invalidatesVerification = contactChanged && Boolean(row.verified_at)
    const effectiveStatus = invalidatesVerification ? 'pending_unverified' : row.status
    const verifying = b.status === 'new' && effectiveStatus === 'pending_unverified'
    if (verifying && !contactId) return reply.code(400).send({ error: 'no_contact' })
    // Обезличивание — только по явному запросу и только для «удалить»/«прекратить»:
    // на «узнать, какие данные есть» стирать ничего не надо. pending_unverified:
    // публичная форма не подтверждает личность отправителя — им может быть кто
    // угодно, знающий контакт жертвы (ADR-015, сценарий атаки в ТЗ сайта: чужой
    // email/телефон + kind=delete по умолчанию).
    if (b.anonymize === true) {
      if (contactChanged || !row.verified_at) return reply.code(400).send({ error: 'not_verified' })
      if (!contactId) return reply.code(400).send({ error: 'no_contact' })
      if (!['delete', 'stop'].includes(row.kind)) return reply.code(400).send({ error: 'kind_not_erasable' })
    }

    let anonymized = null
    db.transaction(() => {
      if (b.contact_id !== undefined) {
        db.prepare('UPDATE pd_requests SET contact_id = ?, updated_at = ? WHERE id = ?').run(contactId, ts, id)
        // Смена привязки аннулирует прежнюю верификацию — та подтверждала личность
        // про СТАРЫЙ контакт, а не про нового. Первичная привязка (row.contact_id
        // был NULL) не аннулирует ничего — верифицировать было ещё нечего.
        if (contactChanged && row.verified_at) {
          db.prepare("UPDATE pd_requests SET verified_at = NULL, status = 'pending_unverified' WHERE id = ?").run(id)
        }
      }
      if (b.note !== undefined) db.prepare('UPDATE pd_requests SET note = ?, updated_at = ? WHERE id = ?').run(trim(b.note, 1000), ts, id)
      if (b.status !== undefined) {
        const unresolved = b.status === 'new' || b.status === 'pending_unverified'
        db.prepare('UPDATE pd_requests SET status = ?, resolved_at = ?, resolved_by = ?, updated_at = ? WHERE id = ?')
          .run(b.status, unresolved ? null : ts, unresolved ? null : req.user.id, ts, id)
        if (verifying) db.prepare('UPDATE pd_requests SET verified_at = ? WHERE id = ?').run(ts, id)
        audit(req, 'update', 'pd_requests', id, `статус: ${b.status}`)
      }
      if (b.anonymize === true) anonymized = anonymizeContact(contactId, req)
    })()
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
      .header('access-control-allow-headers', 'content-type, idempotency-key')
      .header('access-control-max-age', '86400')
      .code(204)
      .send()
  })

  /**
   * Телефон к сравнимому виду: только цифры, российская «восьмёрка» → 7,
   * дальше сравниваем последние 10 цифр. Так «+7 921 555-14-88», «89215551488»
   * и «921 5551488» опознаются как один номер.
   */
  function phoneKey(raw) {
    let d = String(raw || '').replace(/\D/g, '')
    if (d.length === 11 && d.startsWith('8')) d = '7' + d.slice(1)
    return d.length >= 10 ? d.slice(-10) : ''
  }

  /**
   * Тот же человек уже писал? Ищем строго по точному совпадению контакта —
   * почта, телефон или ник. По имени НЕ ищем: «Иван» без фамилии есть у каждого,
   * и склеить двух разных клиентов хуже, чем завести им две карточки.
   *
   * Ищем только внутри проекта: Лаб ИИ и Визор — разные бизнесы, и один человек
   * может быть клиентом обоих независимо. Обезличенных пропускаем: они отозвали
   * согласие, и если пишут снова — это новое согласие и новая карточка (ADR-011).
   *
   * Перебор в JS, а не в SQL: нормализацию телефона на SQLite не выразить без
   * лишней колонки. Контактов у малого бизнеса тысячи, не миллионы — приемлемо.
   */
  function findExistingContact(contactInfo, projectId) {
    const raw = trim(contactInfo, 300).toLowerCase()
    if (!raw) return null
    const key = phoneKey(raw)
    const rows = db
      .prepare('SELECT id, name, email, phone, messenger, archived FROM contacts WHERE project_id = ? AND anonymized_at IS NULL ORDER BY id DESC')
      .all(projectId)
    return rows.find((c) => {
      if (key) return [c.phone, c.messenger].some((v) => phoneKey(v) === key)
      return [c.email, c.messenger].some((v) => String(v || '').toLowerCase() === raw)
    }) || null
  }

  // bodyLimit явно занижен относительно дефолта Fastify: публичный неаутентифицированный
  // эндпоинт, поля и так обрезаются trim()'ом при записи, но разбор тела (JSON.parse)
  // сам по себе стоит CPU/памяти ДО этого — с запасом хватает 64 КБ (transcript ≤ 4000
  // символов + остальные поля). НЕ трогает /api/crm/import — там нужен полный дамп базы.
  app.post('/api/leads', { bodyLimit: 65536 }, async (req, reply) => {
    applyLeadCors(req, reply)
    const b = req.body ?? {}
    const requestId = idempotencyKey(req, b)
    const replay = idempotencyReplay('leads', requestId)
    if (replay !== null) return reply.code(replay).send()
    if (hardRateLimited('leads', req.ip)) return reply.code(429).send()

    // honeypot: скрытое поле website видят только боты — молчаливый дроп. Отвечаем
    // КАК ПРИ УСПЕХЕ (иначе бот подберёт обход по коду ответа), но не сохраняем и
    // не уведомляем. IP-эвристика (leadSuspicious) остаётся отдельным мягким
    // сигналом — только буквальная ловушка даёт жёсткий дроп, честной заявке
    // с шумного IP терять данные нельзя (CGNAT).
    if (b.website) {
      idempotencyRecord('leads', requestId, 204)
      return reply.code(204).send()
    }
    const suspicious = leadSuspicious(req.ip)
    const contactInfo = trim(b.contact, 300)
    const isChat = b.source === 'chat' || (!b.name && b.detail !== undefined)
    const name = trim(b.name, 200) || (contactInfo ? contactInfo.split(/[,;]/)[0].trim() : '') || 'Без имени'
    const title = isChat ? trim(b.task, 300) || 'Заявка из чата' : [trim(b.task, 200), b.scale ? `масштаб: ${trim(b.scale, 100)}` : ''].filter(Boolean).join(', ') || 'Заявка с сайта'
    const note = isChat ? trim(b.detail, 1000) : trim(b.note, 1000)
    // Полная переписка с «Невой» — отдельной записью во взаимодействия, а не в note
    // сделки: так карточка сделки остаётся короткой сутью, а весь диалог всё равно
    // виден на карточке контакта. ПДн тут можно — CRM на РФ-сервере, доступ только у сотрудников.
    const transcript = isChat ? trim(b.transcript, 4000) : ''
    if (!contactInfo && name === 'Без имени') {
      idempotencyRecord('leads', requestId, 204)
      return reply.code(204).send()
    }

    // Проект: домен сайта (Origin — доверенный сигнал) → поле формы (запасной путь,
    // только когда Origin не пришёл или не опознан) → проект по умолчанию. Раньше
    // поле формы могло молча ПЕРЕКРЫТЬ уже определённый по Origin проект —
    // недоверенный клиент мог так загрязнить инбокс соседнего бизнеса (ТЗ сайта,
    // §2: «project передаёт сам недоверенный клиент»).
    // Заявку не отвергаем никогда: потерянный лид хуже, чем лид не в том проекте —
    // второе видно в CRM и правится одним кликом, первое не восстановить.
    const byOrigin = projectByOrigin(req.headers.origin)
    let projectId = byOrigin ? byOrigin.id : DEFAULT_PROJECT_ID
    if (!byOrigin) {
      const asked = trim(b.project, 100)
      if (asked) {
        const pid = resolveProjectId(asked)
        if (pid) projectId = pid
        else app.log?.warn?.({ asked, origin: req.headers.origin }, 'lead: неизвестный проект, беру запасной')
      }
    }

    // Дубли: тот же человек мог заполнить форму, а потом написать в чат. Две карточки
    // на одного клиента рвут историю пополам, поэтому вторую не заводим — привязываем
    // заявку к существующей (ADR-014). Ошибочную склейку видно сразу и она поправима:
    // у сделки и у действия можно сменить контакт в обычной форме редактирования.
    const existing = findExistingContact(contactInfo, projectId)
    const ts = now()
    // Запись идемпотентного ключа — ВНУТРИ той же транзакции, что и сама заявка
    // (независимая проверка нашла: раньше это были отдельные шаги ПОСЛЕ commit —
    // сбой/исключение между ними оставлял заявку сохранённой, но ключ незаписанным,
    // и повтор с тем же ключом создавал вторую заявку — ровно то, от чего был весь
    // этот механизм). Атомарно: либо и заявка, и ключ, либо ни то ни другое.
    const result = db.transaction(() => {
      const inner = (() => {
      if (!existing) {
        const isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactInfo)
        const email = isEmail ? contactInfo : ''
        const messenger = isEmail ? '' : contactInfo
        const cid = db.prepare('INSERT INTO contacts (name, email, messenger, note, source, suspicious, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(name, email, messenger, '', isChat ? 'site-chat' : 'site-form', suspicious ? 1 : 0, projectId, ts, ts).lastInsertRowid
        db.prepare('INSERT INTO deals (contact_id, title, stage, note, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(cid, title, 'Новый', note, projectId, ts, ts)
        if (transcript) {
          db.prepare('INSERT INTO interactions (contact_id, type, note, happened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(cid, 'сообщение', transcript, ts, ts, ts)
        }
        return { contactId: cid, repeat: false }
      }

      const cid = existing.id
      // Из архива возвращаем: иначе повторная заявка не покажется в инбоксе,
      // то есть тихо потеряется — а терять заявки нам нельзя ни при каких условиях.
      if (existing.archived) db.prepare('UPDATE contacts SET archived = 0, updated_at = ? WHERE id = ?').run(ts, cid)
      else db.prepare('UPDATE contacts SET updated_at = ? WHERE id = ?').run(ts, cid)

      // Открытая сделка уже есть — значит это то же самое обращение, а не новое:
      // второй карточкой в воронке та же возможность считалась бы дважды.
      const termMarks = TERMINAL_STAGES.map(() => '?').join(',')
      const openDeal = db
        .prepare(`SELECT id FROM deals WHERE contact_id = ? AND stage NOT IN (${termMarks}) ORDER BY id DESC LIMIT 1`)
        .get(cid, ...TERMINAL_STAGES)
      let dealId
      if (openDeal) {
        dealId = openDeal.id
        db.prepare('UPDATE deals SET updated_at = ? WHERE id = ?').run(ts, dealId)
      } else {
        // Все сделки закрыты — человек вернулся с новой задачей, это новая сделка.
        dealId = db.prepare('INSERT INTO deals (contact_id, title, stage, note, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(cid, title, 'Новый', note, projectId, ts, ts).lastInsertRowid
      }

      // Повторное обращение записываем в историю целиком: заголовок и заметка
      // новой заявки иначе потерялись бы, ведь сделку мы переиспользовали.
      const lines = [
        openDeal ? 'Повторная заявка (сделка уже в работе)' : 'Клиент вернулся с новой заявкой',
        title ? `Задача: ${title}` : '',
        note ? `Заметка: ${note}` : '',
        `Источник: ${isChat ? 'чат Невы' : 'форма на сайте'}`,
      ].filter(Boolean).join('\n')
      db.prepare('INSERT INTO interactions (contact_id, deal_id, type, note, happened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(cid, dealId, 'сообщение', lines, ts, ts, ts)
      if (transcript) {
        db.prepare('INSERT INTO interactions (contact_id, deal_id, type, note, happened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(cid, dealId, 'сообщение', transcript, ts, ts, ts)
      }

      // Клиент написал сам — напоминания «узнать, не передумал ли» больше не нужны
      // и выглядели бы невнимательностью. Снимаем незакрытые, выполненные не трогаем.
      const seqs = db.prepare("SELECT id FROM winback_sequences WHERE contact_id = ? AND status = 'active'").all(cid)
      for (const seq of seqs) {
        db.prepare('DELETE FROM tasks WHERE winback_sequence_id = ? AND done = 0').run(seq.id)
        db.prepare("UPDATE winback_sequences SET status = 'cancelled', finished_at = ? WHERE id = ?").run(ts, seq.id)
      }
        return { contactId: cid, repeat: true, returned: seqs.length > 0 }
      })()

      // В уведомление кладём только обезличенное: проект, источник, ссылку на карточку.
      // Имя, контакт и текст заявки остаются в CRM на российском сервере — Telegram
      // зарубежный, и отправка туда ПДн была бы трансграничной передачей (152-ФЗ).
      const project = db.prepare('SELECT display_name FROM projects WHERE id = ?').get(projectId)
      enqueue(db, 'lead', {
        projectName: project?.display_name || '',
        source: isChat ? 'чат' : 'форма',
        contactId: inner.contactId,
        suspicious,
        // repeat/returned — не ПДн: это про историю обращения, а не про человека
        repeat: Boolean(inner.repeat),
        returned: Boolean(inner.returned),
      })
      if (requestId) {
        try {
          db.prepare('INSERT INTO idempotency_keys (scope, request_id, status_code, created_at) VALUES (?, ?, ?, ?)').run('leads', requestId, 204, ts)
        } catch (err) {
          // Только ожидаемый UNIQUE-конфликт — см. комментарий у idempotencyRecord.
          // Любая другая ошибка обязана откатить ВСЮ транзакцию (мы внутри неё), а не
          // молча закоммитить бизнес-запись без идемпотентного ключа.
          if (err.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err
        }
      }
      return inner
    })()
    const contactId = result.contactId

    app.log?.info?.({ contactId, projectId, suspicious, repeat: result.repeat }, 'lead accepted')
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
      .header('access-control-allow-headers', 'content-type, idempotency-key')
      .header('access-control-max-age', '86400')
      .code(204)
      .send()
  })

  app.post('/api/pd-requests', { bodyLimit: 65536 }, async (req, reply) => {
    applyLeadCors(req, reply)
    const b = req.body ?? {}
    const requestId = idempotencyKey(req, b)
    const replay = idempotencyReplay('pd_requests', requestId)
    if (replay !== null) return reply.code(replay).send()
    if (hardRateLimited('pd_requests', req.ip)) return reply.code(429).send()

    // honeypot — НЕ молчаливый дроп, в отличие от лидов. Независимая проверка указала
    // на асимметрию: скрытое поле обычно не подделывает ничего, кроме ботов, но
    // потерянный лид — упущенная продажа, а потерянный запрос по ПДн — просроченное
    // законное обязательство (10 рабочих дней, ADR-011) без единого следа, при этом
    // отправителю показан «успех». Цена ложного срабатывания здесь категорически выше
    // цены пропустить часть спама — поэтому только помечаем подозрительным (как раньше
    // до этой сессии), запрос всё равно регистрируется и попадает в срок.
    const requester = trim(b.contact, 300)
    if (!requester) {
      idempotencyRecord('pd_requests', requestId, 400)
      return reply.code(400).send({ error: 'contact_required' })
    }
    // ПОЛНОСТЬЮ опущенное поле — прежний дефолт «удалить» сохранён: так вело себя
    // публичное API до этой сессии, и уже развёрнутый клиент (сайт), который его не
    // передаёт, не должен тихо получить другой смысл запроса.
    //
    // ЯВНО присланный, но нераспознанный kind (опечатка, рассинхрон версий клиента и
    // сервера, чужой интегратор) — независимая проверка нашла: любой автоматический
    // ремап (в т.ч. на менее опасный «access», как было здесь раньше) тихо ПОДМЕНЯЕТ
    // юридический смысл запроса — «удалить» превращается в «узнать», сотрудник
    // выполнит не то обязательство. Правильно — сохранить как прислано и оставить
    // видимым для ручной классификации: интерфейс (`kinds[row.kind] ?? row.kind`) и
    // так показывает сырое значение, а обезличивание уже блокируется для любого
    // kind вне ['delete','stop'] — нераспознанный автоматически безопасен по этой оси.
    let kind = 'delete'
    if (b.kind !== undefined) {
      kind = trim(b.kind, 50) || 'delete'
      if (!PD_REQUEST_KINDS[kind]) app.log?.warn?.({ kind: b.kind }, 'pd-request: нераспознанный вид запроса, сохраняю как есть — нужна ручная классификация')
    }
    const suspicious = Boolean(b.website) || leadSuspicious(req.ip)

    // Проект: домен сайта (доверенный) → поле формы (запасной путь, только без
    // Origin) → по умолчанию — тот же порядок и та же причина, что у лидов выше.
    const byOrigin = projectByOrigin(req.headers.origin)
    let projectId = byOrigin ? byOrigin.id : DEFAULT_PROJECT_ID
    if (!byOrigin) {
      const asked = trim(b.project, 100)
      if (asked) projectId = resolveProjectId(asked) || projectId
    }

    // Ищем человека в базе сами — по точному совпадению почты или мессенджера, ВНУТРИ
    // проекта (независимая проверка нашла: без project_id тот же email/телефон в
    // Лаб ИИ и Визоре — разных бизнесах — мог склеить чужого человека, и через новый
    // workflow верификации это давало бы «подтверждённое» обезличивание не того
    // контакта). Та же граница, что уже используется в findExistingContact/ADR-014.
    // Не нашли — оставляем contact_id пустым: сотрудник сопоставит вручную, а срок
    // уже идёт, поэтому запрос всё равно должен быть зарегистрирован.
    const found = db
      .prepare('SELECT id FROM contacts WHERE anonymized_at IS NULL AND project_id = ? AND (lower(email) = lower(?) OR lower(messenger) = lower(?) OR phone = ?) ORDER BY id DESC LIMIT 1')
      .get(projectId, requester, requester, requester)

    const dueDate = addWorkdays(mskToday())
    const ts = now()
    const note = [trim(b.note, 800), suspicious ? '⚠️ подозрительная отправка (ловушка или частые обращения с одного адреса)' : '']
      .filter(Boolean).join('\n')
    // status = 'pending_unverified': публичная форма не подтверждает личность
    // отправителя — им может быть кто угодно, знающий контакт жертвы (см. ADR-015).
    // PATCH .../anonymize ниже блокирует исполнение, пока сотрудник не подтвердит
    // личность по каналу из карточки контакта в CRM и не переведёт статус дальше.
    //
    // INSERT + enqueue + запись идемпотентного ключа — ОДНОЙ транзакцией (независимая
    // проверка нашла: раньше это были отдельные шаги ПОСЛЕ commit — сбой между ними
    // оставлял запрос сохранённым, но ключ незаписанным, и повтор с тем же ключом
    // создавал второй запрос, то есть второй 10-дневный срок по 152-ФЗ).
    const base = String(process.env.CRM_BASE_URL || '').trim().replace(/\/+$/, '')
    const infoId = db.transaction(() => {
      const info = db.prepare(`INSERT INTO pd_requests (contact_id, kind, status, requester, note, source, project_id, due_date, created_at, updated_at)
        VALUES (?, ?, 'pending_unverified', ?, ?, ?, ?, ?, ?, ?)`)
        .run(found?.id ?? null, kind, requester, note, 'site-form', projectId, dueDate, ts, ts)

      // Уведомление обезличено для ОБОИХ каналов, в отличие от заявок: здесь ПДн не
      // нужны по существу — важны вид запроса и срок, кто именно — видно в CRM по ссылке.
      enqueue(db, 'text', {
        text: [
          '⚠️ <b>Запрос по персональным данным</b>',
          `Вид: ${PD_REQUEST_KINDS[kind] || `нераспознанный (${escHtml(kind)}) — нужна классификация`}`,
          `Исполнить до: <b>${dueDate}</b>`,
          found ? 'Клиент найден в базе автоматически.' : 'Клиента в базе не нашли — сопоставить вручную.',
          base ? `Открыть: ${base}/crm/privacy` : 'Открыть раздел «Права ПДн» в CRM',
        ].join('\n'),
      })
      if (requestId) {
        try {
          db.prepare('INSERT INTO idempotency_keys (scope, request_id, status_code, created_at) VALUES (?, ?, ?, ?)').run('pd_requests', requestId, 204, ts)
        } catch (err) {
          // см. аналогичный комментарий в /api/leads выше
          if (err.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err
        }
      }
      return info.lastInsertRowid
    })()
    app.log?.info?.({ id: infoId, kind, projectId, matched: Boolean(found), suspicious }, 'pd request accepted')
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
