// Вход клиента в кабинет через Яндекс ID (ADR-029; задание сайта Визора 2026-11-01, nevarium_vizor/docs/tasks/2026-11-01-crm-yandex-id.md).
//
// Привязка — только из кабинета по личной ссылке: клиент открывает `#/c/<ключ>`, жмёт «Привязать Яндекс ID», входит в Яндекс — CRM
// запоминает пару «аккаунт ↔ клиент». Дальше на странице входа «Яндекс ID» открывает его кабинет без ссылки. От Яндекса нужен только
// идентификатор аккаунта (`id`): запрашивается единственное право `login:avatar` (Яндекс не регистрирует приложение без прав; самое нейтральное), логин, имя, почта, телефон и токены Яндекса НЕ сохраняются.
//
// Маршруты (CORS — домены сайта, как у остальных `/api/client/*`):
//   POST /api/client/auth/yandex/start     {intent: 'link'|'login', token?} → {url} на oauth.yandex.ru
//   GET  /api/client/auth/yandex/callback  возврат от Яндекса → 302 на `<сайт>/#/yandex?status=…`
//   POST /api/client/auth/yandex/exchange  {ticket} → {token, expiresAt} — сессия кабинета
//   POST /api/client/auth/yandex/unlink    {token} → 204
//
// Ключ сессии — строка `client_links` (kind = 'session', живёт 12 часов, хранится только хеш): его принимают все маршруты кабинета наравне
// с ключом ссылки, «Отозвать все ссылки» гасит и его. Сессия не живёт дольше доступа клиента (срок Free переносится в expires_on).
// Адрес возврата — только Origin запроса `start`, проверенный по списку сайтов; из тела запроса его не берём никогда.
// В журналы не пишем ни `code`, ни `state`, ни `ticket`, ни токены, ни идентификатор аккаунта Яндекса.
import crypto from 'node:crypto'
import { clientAccessFor, hashToken, newToken, resolveClientKey } from './entitlements.js'

export const STATE_TTL_MS = 10 * 60_000
export const TICKET_TTL_MS = 60_000
export const SESSION_TTL_MS = 12 * 60 * 60_000
const PROVIDER = 'yandex'
const AUTHORIZE_URL = 'https://oauth.yandex.ru/authorize'
const TOKEN_URL = 'https://oauth.yandex.ru/token'
const INFO_URL = 'https://login.yandex.ru/info?format=json'
const REQUEST_TIMEOUT_MS = 8000
const SUBJECT_RE = /^[\w-]{1,64}$/

const sha256url = (s) => crypto.createHash('sha256').update(s).digest('base64url')
const systemReq = { user: { id: null, email: 'client' } }
const plusMs = (ms) => new Date(Date.now() + ms).toISOString()
const asString = (v, max) => (typeof v === 'string' && v.length <= max ? v.trim() : '')

/**
 * @param deps.config — { clientId, clientSecret, redirectUri } либо null (не настроено → start отвечает 503, summary без поля `auth`)
 * @param deps.originAllowed — async (origin) => boolean: домены сайтов (projects.origins)
 * @param deps.cabinetBaseUrl — куда вернуть, если адрес возврата неизвестен (state не найден)
 * @param deps.fetchImpl — подмена для тестов
 */
export function registerYandexAuth(app, { db, withMutation, audit, now, mskToday, hardRateLimited, applyCors, corsPreflight, originAllowed, cabinetBaseUrl, config, fetchImpl = fetch }) {
  const configured = Boolean(config?.clientId && config?.clientSecret && config?.redirectUri)

  app.options('/api/client/auth/yandex/start', corsPreflight)
  app.options('/api/client/auth/yandex/exchange', corsPreflight)
  app.options('/api/client/auth/yandex/unlink', corsPreflight)

  // ---- 1. начать вход или привязку ----
  app.post('/api/client/auth/yandex/start', { bodyLimit: 4 * 1024 }, async (req, reply) => {
    await applyCors(req, reply)
    if (hardRateLimited('yandex_start', req.ip)) return reply.code(429).send()
    const origin = asString(req.headers.origin, 200)
    if (!origin || !(await originAllowed(origin))) return reply.code(403).send({ error: 'forbidden_origin' })
    const intent = req.body?.intent
    if (intent !== 'link' && intent !== 'login') return reply.code(400).send({ error: 'bad_intent' })
    let contactId = null
    if (intent === 'link') {
      const key = await resolveClientKey(db, req.body?.token, mskToday(), now())
      if (!key) return reply.code(404).send({ error: 'not_found' })
      contactId = key.contact_id
    }
    if (!configured) return reply.code(503).send({ error: 'yandex_unavailable' })

    const state = newToken()
    const verifier = crypto.randomBytes(32).toString('base64url')
    await withMutation(async (tx) => {
      await tx.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(now())
      await tx.prepare("INSERT INTO oauth_states (kind, hash, intent, contact_id, return_origin, code_verifier, created_at, expires_at) VALUES ('state', ?, ?, ?, ?, ?, ?, ?)")
        .run(hashToken(state), intent, contactId, origin, verifier, now(), plusMs(STATE_TTL_MS))
    })
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: 'login:avatar',
      state,
      code_challenge: sha256url(verifier),
      code_challenge_method: 'S256',
    })
    return { url: `${AUTHORIZE_URL}?${params}` }
  })

  /** Код → токен → идентификатор аккаунта. Токен нигде не сохраняется и не логируется. */
  async function fetchYandexId(code, verifier) {
    const tokenRes = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: config.clientId, client_secret: config.clientSecret, code_verifier: verifier }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!tokenRes.ok) throw new Error(`token_http_${tokenRes.status}`)
    const accessToken = asString((await tokenRes.json())?.access_token, 2000)
    if (!accessToken) throw new Error('token_missing')
    const infoRes = await fetchImpl(INFO_URL, { headers: { authorization: `OAuth ${accessToken}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!infoRes.ok) throw new Error(`info_http_${infoRes.status}`)
    const id = String((await infoRes.json())?.id ?? '').trim()
    if (!SUBJECT_RE.test(id)) throw new Error('id_missing')
    return id
  }

  // ---- 2. возврат от Яндекса ----
  app.get('/api/client/auth/yandex/callback', async (req, reply) => {
    if (hardRateLimited('yandex_callback', req.ip)) return reply.code(429).send()
    const q = req.query || {}
    // Параметры идут во фрагменте (после #): на сервер сайта и в его журналы не попадают, сайт сразу убирает их из адреса.
    const back = (origin, status, extra = '') => reply
      .header('cache-control', 'no-store').header('referrer-policy', 'no-referrer')
      .redirect(`${origin}/#/yandex?status=${status}${extra}`, 302)

    const stateRaw = asString(q.state, 200)
    if (!configured || !stateRaw) return back(cabinetBaseUrl, 'error')
    // state гасим сразу и безусловно (одноразовый): повтор той же ссылки — ошибка.
    const st = await withMutation(async (tx) => {
      const row = await tx.prepare("SELECT * FROM oauth_states WHERE kind = 'state' AND hash = ? FOR UPDATE").get(hashToken(stateRaw))
      if (row) await tx.prepare('DELETE FROM oauth_states WHERE id = ?').run(row.id)
      return row || null
    })
    if (!st) return back(cabinetBaseUrl, 'error')
    const origin = st.return_origin
    if (st.expires_at <= now()) return back(origin, 'error')
    if (asString(q.error, 100)) return back(origin, q.error === 'access_denied' ? 'denied' : 'error')
    const code = asString(q.code, 500)
    if (!code) return back(origin, 'error')

    let subject
    try {
      subject = await fetchYandexId(code, st.code_verifier)
    } catch (err) {
      // Только тип сбоя: тело ответа и тексты ошибок могут нести code/токен.
      app.log?.warn?.({ reason: String(err?.message || err?.name || 'unknown').slice(0, 40) }, 'yandex: обмен кода не удался')
      return back(origin, 'error')
    }

    let outcome
    try {
      outcome = await withMutation(async (tx) => {
        const ts = now()
        if (st.intent === 'link') {
          const contact = await tx.prepare('SELECT id FROM contacts WHERE id = ? AND anonymized_at IS NULL FOR UPDATE').get(st.contact_id)
          if (!contact) return { status: 'error' }
          const owner = await tx.prepare('SELECT contact_id FROM client_identities WHERE provider = ? AND subject = ?').get(PROVIDER, subject)
          if (owner) return { status: owner.contact_id === st.contact_id ? 'linked' : 'already_linked' }
          const mine = await tx.prepare('SELECT id FROM client_identities WHERE provider = ? AND contact_id = ?').get(PROVIDER, st.contact_id)
          if (mine) {
            // У клиента уже был другой аккаунт Яндекса: ключ ссылки у него действующий, так что перепривязка — его право (отвязать он вправе и так).
            await tx.prepare('UPDATE client_identities SET subject = ?, created_at = ?, last_login_at = NULL WHERE id = ?').run(subject, ts, mine.id)
            await audit(systemReq, 'update', 'client_identities', mine.id, `Яндекс ID перепривязан из кабинета: контакт #${st.contact_id}`, tx)
          } else {
            const info = await tx.prepare('INSERT INTO client_identities (contact_id, provider, subject, created_at) VALUES (?, ?, ?, ?) RETURNING id')
              .run(st.contact_id, PROVIDER, subject, ts)
            await audit(systemReq, 'create', 'client_identities', info.lastInsertRowid, `Яндекс ID привязан из кабинета: контакт #${st.contact_id}`, tx)
          }
          return { status: 'linked' }
        }
        // login: вход возможен только по привязке, созданной из кабинета по ключу, и только пока у клиента есть доступ.
        const ident = await tx.prepare('SELECT id, contact_id FROM client_identities WHERE provider = ? AND subject = ?').get(PROVIDER, subject)
        if (!ident) return { status: 'not_linked' }
        const contact = await tx.prepare('SELECT id FROM contacts WHERE id = ? AND anonymized_at IS NULL').get(ident.contact_id)
        if (!contact || !(await clientAccessFor(tx, ident.contact_id, mskToday())).ok) return { status: 'not_linked' }
        const ticket = newToken()
        await tx.prepare("INSERT INTO oauth_states (kind, hash, intent, contact_id, created_at, expires_at) VALUES ('ticket', ?, 'login', ?, ?, ?)")
          .run(hashToken(ticket), ident.contact_id, ts, plusMs(TICKET_TTL_MS))
        await tx.prepare('UPDATE client_identities SET last_login_at = ? WHERE id = ?').run(ts, ident.id)
        await audit(systemReq, 'login', 'client_identities', ident.id, `вход в кабинет через Яндекс ID: контакт #${ident.contact_id}`, tx)
        return { status: 'logged_in', ticket }
      })
    } catch (err) {
      // Одновременная привязка этого же аккаунта двумя клиентами: уникальность (provider, subject) — единственный, кто победил.
      outcome = { status: err?.code === '23505' ? 'already_linked' : 'error' }
      if (err?.code !== '23505') app.log?.warn?.({ reason: String(err?.code || err?.name || 'unknown').slice(0, 40) }, 'yandex: запись входа не удалась')
    }
    return back(origin, outcome.status, outcome.ticket ? `&ticket=${outcome.ticket}` : '')
  })

  // ---- 3. обменять ticket на сессию ----
  app.post('/api/client/auth/yandex/exchange', { bodyLimit: 4 * 1024 }, async (req, reply) => {
    await applyCors(req, reply)
    if (hardRateLimited('yandex_exchange', req.ip)) return reply.code(429).send()
    const ticket = asString(req.body?.ticket, 200)
    if (!ticket) return reply.code(404).send({ error: 'not_found' })
    const session = await withMutation(async (tx) => {
      // Тикет гасится при первой же попытке, в том числе неудачной.
      const row = await tx.prepare("SELECT * FROM oauth_states WHERE kind = 'ticket' AND hash = ? FOR UPDATE").get(hashToken(ticket))
      if (!row) return null
      await tx.prepare('DELETE FROM oauth_states WHERE id = ?').run(row.id)
      if (row.expires_at <= now()) return null
      const contact = await tx.prepare('SELECT id FROM contacts WHERE id = ? AND anonymized_at IS NULL').get(row.contact_id)
      const access = contact ? await clientAccessFor(tx, row.contact_id, mskToday()) : { ok: false }
      if (!access.ok) return null
      const token = newToken()
      const expiresAt = plusMs(SESSION_TTL_MS)
      await tx.prepare("DELETE FROM client_links WHERE contact_id = ? AND kind = 'session' AND expires_at < ?").run(row.contact_id, now())
      const info = await tx.prepare("INSERT INTO client_links (contact_id, token_hash, created_at, expires_on, kind, expires_at) VALUES (?, ?, ?, ?, 'session', ?) RETURNING id")
        .run(row.contact_id, hashToken(token), now(), access.expiresOn, expiresAt)
      await audit(systemReq, 'create', 'client_links', info.lastInsertRowid, `сессия кабинета выдана (вход через Яндекс ID): контакт #${row.contact_id}`, tx)
      return { token, expiresAt }
    })
    if (!session) return reply.code(404).send({ error: 'not_found' })
    return session
  })

  // ---- 4. отвязать ----
  app.post('/api/client/auth/yandex/unlink', { bodyLimit: 4 * 1024 }, async (req, reply) => {
    await applyCors(req, reply)
    if (hardRateLimited('yandex_unlink', req.ip)) return reply.code(429).send()
    const key = await resolveClientKey(db, req.body?.token, mskToday(), now())
    if (!key) return reply.code(404).send({ error: 'not_found' })
    await withMutation(async (tx) => {
      const res = await tx.prepare('DELETE FROM client_identities WHERE provider = ? AND contact_id = ?').run(PROVIDER, key.contact_id)
      if (res?.changes) await audit(systemReq, 'delete', 'client_identities', key.contact_id, `Яндекс ID отвязан клиентом: контакт #${key.contact_id}`, tx)
    })
    return reply.code(204).send()
  })
}
