import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'

// Единый срок жизни сессии: cookie и токен всегда истекают вместе.
export const SESSION_TTL_DAYS = 30

// Асинхронный bcrypt: pure-JS реализация с cost 12 при синхронном вызове
// блокировала бы event loop на ~1 c на каждый логин.
export function hashPassword(password) {
  return bcrypt.hash(password, 12)
}

export function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash)
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

// Троттлинг логина: ключ = ip|email, окно 15 минут, порог 5 — далее задержка.
const THROTTLE_WINDOW_MS = 15 * 60_000
const THROTTLE_FREE_ATTEMPTS = 5
const attempts = new Map()

function pruneAttempts(nowMs) {
  // защита от разрастания на публичном логине (спрей несуществующих email)
  if (attempts.size < 1000) return
  for (const [key, rec] of attempts) {
    if (nowMs - rec.first > THROTTLE_WINDOW_MS) attempts.delete(key)
  }
}

export function loginThrottle(key) {
  const nowMs = Date.now()
  const rec = attempts.get(key)
  if (rec && nowMs - rec.first > THROTTLE_WINDOW_MS) attempts.delete(key)
  const cur = attempts.get(key) || { first: nowMs, count: 0 }
  if (cur.count >= THROTTLE_FREE_ATTEMPTS) {
    const waitMs = Math.min(2 ** (cur.count - THROTTLE_FREE_ATTEMPTS) * 5000, 5 * 60_000)
    const since = nowMs - (cur.last || cur.first)
    if (since < waitMs) return Math.ceil((waitMs - since) / 1000)
  }
  return 0
}
export function loginFailed(key) {
  const nowMs = Date.now()
  pruneAttempts(nowMs)
  const cur = attempts.get(key) || { first: nowMs, count: 0 }
  cur.count += 1
  cur.last = nowMs
  attempts.set(key, cur)
}
export function loginSucceeded(key) {
  attempts.delete(key)
}
export function resetThrottle() {
  attempts.clear()
}
