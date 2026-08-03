import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'

// Единый срок жизни сессии: cookie и токен всегда истекают вместе.
export const SESSION_TTL_DAYS = 30

// Минимальная длина пароля. Для роли admin — 16, а не 8: аудит показал, что
// лимитеры логина не могут одновременно жёстко ограничить перебор и гарантировать
// владельцу вход без блокировки (см. server/app.js, /api/auth/login) — там выбор
// сделан в пользу владельца. Значит настоящую защиту админского аккаунта даёт
// стойкость самого пароля: на одном vCPU bcrypt ограничивает перебор физически,
// но короткий пароль всё равно перебирается за разумное время. Для участников
// порог остаётся прежним — они не имеют доступа к экспорту и обезличиванию.
export const MIN_PASSWORD_LENGTH = 8
export const MIN_ADMIN_PASSWORD_LENGTH = 16

// Асинхронный bcrypt: pure-JS реализация с cost 12 при синхронном вызове
// блокировала бы event loop на ~1 c на каждый логин.
export function hashPassword(password) {
  return bcrypt.hash(password, 12)
}

// Сколько заняла последняя реальная проверка пароля. Нужна, чтобы подделать то же
// время ответа паузой, не тратя CPU (см. fakeVerifyDelay). Самокалибруется под
// железо и текущую нагрузку: на медленной машине пауза растёт вместе с bcrypt.
let lastBcryptMs = 250

export async function verifyPassword(password, hash) {
  const started = Date.now()
  try {
    return await bcrypt.compare(password, hash)
  } finally {
    lastBcryptMs = Math.max(1, Date.now() - started)
  }
}

/**
 * Пауза вместо bcrypt: тот же порядок времени ответа при нулевой цене по CPU.
 * Нужна на одном узком пути — когда лимит по IP исчерпан И пользователя не
 * существует. Иначе выбор был бы между «жечь CPU на каждом мусорном email»
 * (отказ в обслуживании) и «отвечать мгновенно» (тайминговая энумерация).
 */
export function fakeVerifyDelay() {
  return new Promise((resolve) => setTimeout(resolve, lastBcryptMs))
}


const b64u = (buf) => Buffer.from(buf).toString('base64url')

// Компактный HS256-токен: payload = { uid, tv, exp }; подпись HMAC-SHA256.
export function signToken({ uid, tokenVersion }, secret, ttlDays = SESSION_TTL_DAYS) {
  const payload = b64u(JSON.stringify({ uid, tv: tokenVersion, exp: Date.now() + ttlDays * 864e5 }))
  const sig = b64u(crypto.createHmac('sha256', secret).update(payload).digest())
  return `${payload}.${sig}`
}

export function verifyToken(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null
  const [payload, sig] = token.split('.')
  const expected = b64u(crypto.createHmac('sha256', secret).update(payload).digest())
  const a = Buffer.from(sig), b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString())
    if (typeof data.uid !== 'number' || Date.now() > data.exp) return null
    return data
  } catch {
    return null
  }
}

/**
 * Потолок ОДНОВРЕМЕННО обрабатываемых запросов /api/auth/login, ДО reserveVerify.
 * Независимая проверка (Codex, 6-й раунд) нашла: reserveVerify резервирует слот
 * синхронно (это правильно — закрывает гонку), но САМА фаза «жду свой слот» не
 * ограничена по числу параллельных ожидающих запросов — до 10 с (MAX_RESERVE_WAIT_MS)
 * на каждый, сколько бы их ни пришло разом. Флуд на любой email копит открытые
 * соединения/промисы/таймеры быстрее, чем дело доходит до bcrypt-очереди, и способен
 * исчерпать память/лимит соединений раньше. Это потолок на ЗАПРОС, не на email —
 * не выдаёт, существует ли аккаунт, и не портит троттлинг конкретного ключа.
 */
export const MAX_INFLIGHT_LOGIN_REQUESTS = 500

let inFlightLoginRequests = 0

/** Занять место в потолке /api/auth/login. false — потолок исчерпан, впускать нельзя. */
export function admitLoginRequest() {
  if (inFlightLoginRequests >= MAX_INFLIGHT_LOGIN_REQUESTS) return false
  inFlightLoginRequests += 1
  return true
}

/** Освободить место — вызывать в finally, на любом выходе из обработчика. */
export function releaseLoginRequest() {
  inFlightLoginRequests = Math.max(0, inFlightLoginRequests - 1)
}

export function inFlightLoginCount() {
  return inFlightLoginRequests
}

// Троттлинг логина: окно 15 минут, дальше экспоненциальная задержка с потолком 5 мин.
// Логин считает ДВА ключа с разными порогами (см. loginThrottle):
//  - по email, тугой: против подбора пароля к конкретному аккаунту;
//  - по IP, широкий: против флуда уникальными несуществующими email. Каждый такой
//    запрос гонит bcrypt (cost 12, ~200 мс) ради постоянного времени ответа, и без
//    второго ключа поток уникальных адресов сжигал бы CPU без ограничений.
// Порог по IP щедрый: за одним адресом может сидеть весь офис (и CGNAT в РФ), а
// цена ошибки тут — задержка входа, тогда как цена бездействия — недоступность CRM.
const THROTTLE_WINDOW_MS = 15 * 60_000
const THROTTLE_FREE_ATTEMPTS = 5
export const THROTTLE_IP_FREE_ATTEMPTS = 20


// ДВА хранилища, и разделение принципиально для безопасности.
//
// accounts — корзины реально существующих аккаунтов. Не вытесняются НИКОГДА.
// Их число ограничено количеством пользователей CRM (два-три), расти неоткуда:
// завести аккаунт снаружи нельзя.
//
// volatile_ — всё остальное: неизвестные адреса и корзины по IP. С потолком и
// вытеснением, иначе спрей уникальных адресов растит память до OOM.
//
// Почему не одно хранилище: если корзину аккаунта можно вытеснить, само вытеснение
// становится способом сбросить лимит. Атакующий заливает MAX_BUCKETS мусорных
// адресов, выбивает корзину владельца, получает новые бесплатные попытки — и так
// по кругу, то есть перебор без предела. Разделение делает корзину аккаунта
// недосягаемой для спрея.
const accounts = new Map()
const volatile_ = new Map()

/** Потолок числа вытесняемых корзин: спрей уникальных адресов не должен расти до OOM. */
export const MAX_BUCKETS = 5000
/** Минимальный интервал между проверками пароля для одного ключа после порога. */
const RESERVE_INTERVAL_MS = 2000
/**
 * Потолок ожидания в очереди. Дальше НЕ отказываем — ждём потолок и всё равно
 * проверяем пароль. Отказ до проверки был бы блокировкой владельца под видом
 * «неверный пароль»: атакующий держал бы очередь переполненной, и настоящий пароль
 * никогда бы не сверялся. Цена решения — при массовой параллельной атаке предел
 * пропускной способности размывается до этого потолка; см. комментарий в app.js.
 */
const MAX_RESERVE_WAIT_MS = 10_000

function pruneStore(store, nowMs) {
  if (store.size < 1000) return
  for (const [key, rec] of store) {
    if (nowMs - rec.first > THROTTLE_WINDOW_MS) store.delete(key)
  }
}

/**
 * Вытеснение только в volatile_ и только «холодных» записей: тех, что не под
 * ограничением. Иначе спрей выбивал бы активно атакуемую корзину и сбрасывал лимит.
 * Map хранит порядок вставки, поэтому идём с самых старых.
 */
function evictIfFull(key) {
  if (volatile_.has(key) || volatile_.size < MAX_BUCKETS) return
  const nowMs = Date.now()
  for (const [k, rec] of volatile_) {
    const hot = rec.count > THROTTLE_IP_FREE_ATTEMPTS || (rec.nextAt || 0) > nowMs
    if (!hot) {
      volatile_.delete(k)
      return
    }
  }
  // Все корзины «горячие» — не вытесняем ничего: потерять живой лимит хуже,
  // чем на время превысить потолок. Рост при этом всё равно ограничен окном TTL.
}

function storeFor(durable) {
  return durable ? accounts : volatile_
}

/**
 * Занять слот на проверку пароля и вернуть, сколько до него ждать (мс).
 *
 * Почему резервирование, а не «поспать N секунд»: сон ограничивает задержку каждого
 * запроса по отдельности, но не пропускную способность. Сто параллельных попыток
 * отспят одни и те же N секунд одновременно и затем проверятся все — перебор почти
 * не замедлится. Резервирование двигает общий счётчик времени синхронно, до первого
 * await, поэтому попытки выстраиваются в очередь.
 *
 * durable=true для существующих аккаунтов: их корзина живёт в невытесняемом
 * хранилище. Логика и тайминги одинаковы для существующих и несуществующих адресов —
 * иначе разница во времени ответа сама выдаёт, какой аккаунт есть.
 */
export function reserveVerify(key, { durable = false, free = THROTTLE_FREE_ATTEMPTS } = {}) {
  const nowMs = Date.now()
  const store = storeFor(durable)
  pruneStore(store, nowMs)
  const stale = store.get(key)
  if (stale && nowMs - stale.first > THROTTLE_WINDOW_MS) store.delete(key)
  if (!durable) evictIfFull(key)
  const rec = store.get(key) || { first: nowMs, count: 0, nextAt: 0 }
  rec.count += 1
  rec.last = nowMs
  if (rec.count <= free) {
    rec.nextAt = nowMs
    store.set(key, rec)
    return 0
  }
  // Потолок применяется к САМОМУ слоту (at), а не только к возвращаемому wait —
  // раньше это было раздельно: wait обрезался потолком, а nextAt продолжал расти
  // без ограничения. Внешне это ничего не портило (каждый следующий запрос всё
  // равно видел «горячую» корзину), но означало, что множество запросов, чей
  // истинный слот дальше потолка, получали ОДИНАКОВЫЙ обрезанный wait и просыпались
  // в одну и ту же секунду. Независимая проверка поймала, что при большой
  // параллельной пачке это превращается в одновременный bcrypt-всплеск: секундная
  // «очередь» на деле схлопывалась в толпу, штурмующую bcrypt разом. Симметричный
  // потолок держит wait и nextAt согласованными; от самого «пробуждения пачкой» —
  // ниже, serializeVerify (реальные проверки пароля исполняются строго по одной,
  // сколько бы запросов ни проснулось в одну секунду).
  const at = Math.min(Math.max(nowMs, rec.nextAt || nowMs), nowMs + MAX_RESERVE_WAIT_MS)
  const wait = at - nowMs
  rec.nextAt = at + RESERVE_INTERVAL_MS
  store.set(key, rec)
  return wait
}

/**
 * Общий шлюз на реальное исполнение проверки пароля (bcrypt.compare и его
 * заглушка fakeVerifyDelay). reserveVerify выше решает, КОГДА запросу можно
 * идти проверять пароль, но при большой параллельной пачке несколько запросов
 * получают право «сейчас» одновременно (см. комментарий в reserveVerify) —
 * без этого шлюза они бы и правда выполнялись параллельно, и event loop
 * насыщался бы одновременными bcrypt-вызовами (ровно это поймала независимая
 * проверка: «CPU-эксплуатация» — не то, что кто-то один досрочно переберёт
 * пароль, а то, что процесс целиком подвиснет для всех, включая другие эндпоинты,
 * пока десятки bcrypt-вызовов конкурируют за один поток событий).
 *
 * Гейт глобальный, не по ключу: одновременных логинов у CRM на 2-3 человека
 * практически не бывает, а серилизация ВСЕХ проверок (не только по одному
 * аккаунту) исключает и обходной путь — параллельную атаку сразу на несколько
 * несуществующих адресов, которая не разделяет с владельцем корзину по email.
 */
let verifyQueue = Promise.resolve()
export function serializeVerify(fn) {
  const result = verifyQueue.then(fn, fn)
  // Хвост цепочки не должен нести значение или ошибку конкретного вызова дальше —
  // иначе они утекли бы в результат следующего через .then(fn, fn).
  verifyQueue = result.then(() => undefined, () => undefined)
  return result
}

/**
 * Потолок числа проверок ОДНОГО ключа, одновременно ждущих/исполняющихся в
 * serializeVerify. Независимая проверка (Codex) нашла: reserveVerify после своего
 * потолка ожидания (MAX_RESERVE_WAIT_MS) отдаёт множеству параллельных попыток
 * ОДНО и то же время пробуждения (это не баг очереди времени — оно и задумано,
 * чтобы не держать соединения открытыми часами, см. reserveVerify). Раньше ВСЕ
 * проснувшиеся попытки без исключения шли в serializeVerify — при потоке в тысячи
 * запросов на известный адрес владельца это означало очередь на ~20 минут: не
 * отказ, но фактическая блокировка того же рода, от которой был весь этот файл.
 */
export const MAX_QUEUED_PER_KEY = 3

/**
 * Потолок числа проверок ОДНОГО ключа от ОДНОГО источника (IP) одновременно.
 * Первая версия verifyOrFake ограничивала только общее число слотов на ключ и
 * отдавала свободный слот тому, кто первым до него дозвонился — Codex указал: при
 * НЕПРЕРЫВНОМ флуде с одного источника это не потолок, а гонка, которую атакующий
 * выигрывает почти всегда просто числом попыток, и настоящий пароль владельца
 * может не проверяться вообще, сколько бы времени ни прошло. Резервируя не больше
 * ОДНОГО слота на источник, атакующий с одного IP никогда не займёт больше
 * MAX_QUEUED_PER_SOURCE слотов — при MAX_QUEUED_PER_KEY=3 для владельца (другой
 * источник) всегда остаётся минимум 2 свободных, и его попытка проходит на реальный
 * bcrypt немедленно, независимо от того, как долго и как часто атакующий флудит с
 * ОДНОГО адреса. req.ip в этом деплое доверенный (см. TRUST_PROXY_HOPS в app.js) —
 * не тот заголовок, который клиент может подделать.
 *
 * Честно: это не решает распределённую атаку с MAX_QUEUED_PER_KEY и более разных
 * источников одновременно — такую по счётчикам в процессе не отличить от
 * нескольких настоящих пользователей. Остаточный риск осознанно принят и совпадает
 * с уже задокументированной в этом файле логикой (см. MIN_ADMIN_PASSWORD_LENGTH):
 * от максимально ресурсного распределённого атакующего защищает стойкость самого
 * пароля и инфраструктурные меры (rate limit на прокси), не этот файл.
 */
export const MAX_QUEUED_PER_SOURCE = 1

const pendingByKey = new Map()
const pendingBySourceForKey = new Map() // key -> Map(source -> count)

function trackPending(key, delta) {
  const next = (pendingByKey.get(key) || 0) + delta
  if (next <= 0) pendingByKey.delete(key)
  else pendingByKey.set(key, next)
}

function trackPendingSource(key, source, delta) {
  let bySource = pendingBySourceForKey.get(key)
  if (!bySource) {
    if (delta <= 0) return
    bySource = new Map()
    pendingBySourceForKey.set(key, bySource)
  }
  const next = (bySource.get(source) || 0) + delta
  if (next <= 0) bySource.delete(source)
  else bySource.set(source, next)
  if (bySource.size === 0) pendingBySourceForKey.delete(key)
}

/**
 * Проверить пароль через serializeVerify — но только если для этого ключа ещё не
 * набралось MAX_QUEUED_PER_KEY проверок в очереди/исполнении И источник (IP) ещё
 * не занял свой MAX_QUEUED_PER_SOURCE слот. Сверх любого из двух потолков — тот же
 * fakeVerifyDelay, что и для несуществующих email: тот же тайминг (нет оракула),
 * нулевая цена по CPU. Настоящий владелец, попавший «сверх потолка» с ТОГО ЖЕ
 * источника, что уже занят (например, повторный клик на медленной сети), увидит
 * тот же ответ, что при неверном пароле — но освобождающийся слот (bcrypt ~250 мс)
 * открывается за доли секунды. С другого источника, чем у атакующего, потолок по
 * источнику вообще не мешает — см. комментарий у MAX_QUEUED_PER_SOURCE.
 */
export async function verifyOrFake(key, source, verifier) {
  const keyFull = (pendingByKey.get(key) || 0) >= MAX_QUEUED_PER_KEY
  const sourceFull = (pendingBySourceForKey.get(key)?.get(source) || 0) >= MAX_QUEUED_PER_SOURCE
  if (keyFull || sourceFull) {
    return fakeVerifyDelay().then(() => false)
  }
  trackPending(key, 1)
  trackPendingSource(key, source, 1)
  try {
    return await serializeVerify(verifier)
  } finally {
    trackPending(key, -1)
    trackPendingSource(key, source, -1)
  }
}

/** Текущий лимит по ключу без резервирования слота (используется для корзины по IP). */
export function loginThrottle(key, free = THROTTLE_FREE_ATTEMPTS) {
  const nowMs = Date.now()
  const rec = volatile_.get(key)
  if (rec && nowMs - rec.first > THROTTLE_WINDOW_MS) volatile_.delete(key)
  const cur = volatile_.get(key) || { first: nowMs, count: 0 }
  if (cur.count >= free) {
    const waitMs = Math.min(2 ** (cur.count - free) * 5000, 5 * 60_000)
    const since = nowMs - (cur.last || cur.first)
    if (since < waitMs) return Math.ceil((waitMs - since) / 1000)
  }
  return 0
}

/**
 * Учесть обращение по ключу в вытесняемом хранилище. Считать нужно СРАЗУ при входе
 * в обработчик, до проверки пароля: bcrypt занимает ~250 мс, и если увеличивать
 * счётчик после него, пачка параллельных запросов успевает прочитать старое значение
 * и проскочить лимит целиком (гонка «проверил — потом сделал»).
 */
export function loginAttempted(key) {
  const nowMs = Date.now()
  pruneStore(volatile_, nowMs)
  evictIfFull(key)
  const cur = volatile_.get(key) || { first: nowMs, count: 0 }
  cur.count += 1
  cur.last = nowMs
  volatile_.set(key, cur)
}

export function loginSucceeded(key, { durable = false } = {}) {
  storeFor(durable).delete(key)
}

export function resetThrottle() {
  accounts.clear()
  volatile_.clear()
}

/** Размеры хранилищ. Нужны тестам: вытесняемое ограничено потолком, аккаунты — нет. */
export function throttleSize() {
  return volatile_.size + accounts.size
}
export function volatileSize() {
  return volatile_.size
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
