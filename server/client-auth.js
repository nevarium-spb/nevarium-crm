// Вход клиента в кабинет через внешний аккаунт: Яндекс ID (ADR-029; задание сайта Визора 2026-11-01) и VK ID (ADR-031; задание 2026-11-02).
//
// Привязка — только из кабинета по личной ссылке: клиент открывает `#/c/<ключ>`, жмёт «Привязать …», входит в аккаунт — CRM запоминает пару
// «аккаунт ↔ клиент». Дальше на странице входа кнопка провайдера открывает его кабинет без ссылки. От провайдера нужен только идентификатор
// аккаунта: логин, имя, почта, телефон, фото и токены НЕ сохраняются. У Яндекса запрашивается единственное право `login:avatar` (без прав приложение не
// регистрируется). У VK ID параметр scope не передаётся: по документации тогда действует `vkid.personal_info` (имя, пол, фото, дата рождения —
// клиент видит это на экране согласия, CRM читает из ответа обмена только `user_id`; уменьшить набор нельзя).
//
// Маршруты на провайдера (CORS — домены сайта, как у остальных `/api/client/*`), `<p>` — `yandex` или `vk`:
//   POST /api/client/auth/<p>/start     {intent: 'link'|'login', token?} → {url} на страницу авторизации провайдера
//   GET  /api/client/auth/<p>/callback  возврат от провайдера → 302 на `<сайт>/#/<p>?status=…`
//   POST /api/client/auth/<p>/exchange  {ticket} → {token, expiresAt} — сессия кабинета
//   POST /api/client/auth/<p>/unlink    {token} → 204
//
// Ключ сессии — строка `client_links` (kind = 'session', живёт 12 часов, хранится только хеш): его принимают все маршруты кабинета наравне
// с ключом ссылки, «Отозвать все ссылки» гасит и его. Сессия не живёт дольше доступа клиента (срок Free переносится в expires_on).
// Адрес возврата — только Origin запроса `start`, проверенный по списку сайтов; из тела запроса его не берём никогда.
// `state` и тикет помнят провайдера (`oauth_states.provider`): значение из потока одного провайдера у другого не принимается.
// В журналы не пишем ни `code`, ни `state`, ни `ticket`, ни `device_id`, ни токены, ни идентификатор аккаунта.
import crypto from 'node:crypto'
import { clientAccessFor, hashToken, newToken, resolveClientKey } from './entitlements.js'

export const STATE_TTL_MS = 10 * 60_000
export const TICKET_TTL_MS = 60_000
export const SESSION_TTL_MS = 12 * 60 * 60_000
const REQUEST_TIMEOUT_MS = 8000
const SUBJECT_RE = /^[\w-]{1,64}$/

const sha256url = (s) => crypto.createHash('sha256').update(s).digest('base64url')
const systemReq = { user: { id: null, email: 'client' } }
const plusMs = (ms) => new Date(Date.now() + ms).toISOString()
const asString = (v, max) => (typeof v === 'string' && v.length <= max ? v.trim() : '')

/**
 * Провайдеры. `configured(config)` — достаточно ли настроек; `authorizeParams` — параметры сверх общих (response_type, client_id, redirect_uri,
 * state, PKCE); `fetchSubject` — обмен кода на идентификатор аккаунта (строка), токены нигде не сохраняются и не логируются.
 */
export const PROVIDERS = {
  yandex: {
    slug: 'yandex',
    name: 'Яндекс ID',
    authorizeUrl: 'https://oauth.yandex.ru/authorize',
    configured: (c) => Boolean(c?.clientId && c?.clientSecret && c?.redirectUri),
    authorizeParams: () => ({ scope: 'login:avatar' }),
    async fetchSubject({ config, code, verifier, fetchImpl }) {
      const tokenRes = await fetchImpl('https://oauth.yandex.ru/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: config.clientId, client_secret: config.clientSecret, code_verifier: verifier }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!tokenRes.ok) throw new Error(`token_http_${tokenRes.status}`)
      const accessToken = asString((await tokenRes.json())?.access_token, 2000)
      if (!accessToken) throw new Error('token_missing')
      const infoRes = await fetchImpl('https://login.yandex.ru/info?format=json', { headers: { authorization: `OAuth ${accessToken}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      if (!infoRes.ok) throw new Error(`info_http_${infoRes.status}`)
      return String((await infoRes.json())?.id ?? '').trim()
    },
  },
  vk: {
    slug: 'vk',
    name: 'VK ID',
    // Документация VK ID — id.vk.ru (id.vk.com в задании сайта — не тот хост). Приложение «Публичное»: секрета при обмене кода нет, защита — PKCE и state.
    authorizeUrl: 'https://id.vk.ru/authorize',
    configured: (c) => Boolean(c?.clientId && c?.redirectUri),
    authorizeParams: () => ({}),
    async fetchSubject({ config, code, verifier, fetchImpl, state, query }) {
      // device_id приходит в адресе возврата вместе с code и обязателен при обмене.
      const deviceId = asString(query?.device_id, 200)
      if (!deviceId) throw new Error('device_id_missing')
      const res = await fetchImpl('https://id.vk.ru/oauth2/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: config.redirectUri, client_id: config.clientId, device_id: deviceId, state }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`token_http_${res.status}`)
      const body = await res.json()
      // Документация: state в ответе обязан совпасть с отправленным, иначе ответ считается подменённым.
      if (body?.state !== undefined && body.state !== state) throw new Error('state_mismatch')
      const id = body?.user_id
      return typeof id === 'number' || typeof id === 'string' ? String(id).trim() : ''
    },
  },
}

/**
 * @param provider — ключ из PROVIDERS
 * @param deps.config — настройки провайдера либо null (не настроено → start отвечает 503, summary без поля `auth`)
 * @param deps.originAllowed — async (origin) => boolean: домены сайтов (projects.origins)
 * @param deps.cabinetBaseUrl — куда вернуть, если адрес возврата неизвестен (state не найден)
 * @param deps.fetchImpl — подмена для тестов
 */
export function registerClientAuth(app, provider, { db, withMutation, audit, now, mskToday, hardRateLimited, applyCors, corsPreflight, originAllowed, cabinetBaseUrl, config, fetchImpl = fetch }) {
  const P = PROVIDERS[provider]
  const slug = P.slug
  const base = `/api/client/auth/${slug}`
  const configured = P.configured(config)

  app.options(`${base}/start`, corsPreflight)
  app.options(`${base}/exchange`, corsPreflight)
  app.options(`${base}/unlink`, corsPreflight)

  // ---- 1. начать вход или привязку ----
  app.post(`${base}/start`, { bodyLimit: 4 * 1024 }, async (req, reply) => {
    await applyCors(req, reply)
    if (hardRateLimited(`${slug}_start`, req.ip)) return reply.code(429).send()
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
    if (!configured) return reply.code(503).send({ error: `${slug}_unavailable` })

    const state = newToken()
    const verifier = crypto.randomBytes(32).toString('base64url')
    await withMutation(async (tx) => {
      await tx.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(now())
      await tx.prepare("INSERT INTO oauth_states (kind, provider, hash, intent, contact_id, return_origin, code_verifier, created_at, expires_at) VALUES ('state', ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(slug, hashToken(state), intent, contactId, origin, verifier, now(), plusMs(STATE_TTL_MS))
    })
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      ...P.authorizeParams(),
      state,
      code_challenge: sha256url(verifier),
      code_challenge_method: 'S256',
    })
    return { url: `${P.authorizeUrl}?${params}` }
  })

  // ---- 2. возврат от провайдера ----
  app.get(`${base}/callback`, async (req, reply) => {
    if (hardRateLimited(`${slug}_callback`, req.ip)) return reply.code(429).send()
    const q = req.query || {}
    // Параметры идут во фрагменте (после #): на сервер сайта и в его журналы не попадают, сайт сразу убирает их из адреса.
    const back = (origin, status, extra = '') => reply
      .header('cache-control', 'no-store').header('referrer-policy', 'no-referrer')
      .redirect(`${origin}/#/${slug}?status=${status}${extra}`, 302)

    const stateRaw = asString(q.state, 200)
    if (!configured || !stateRaw) return back(cabinetBaseUrl, 'error')
    // state гасим сразу и безусловно (одноразовый): повтор той же ссылки — ошибка. Чужого провайдера — тоже ошибка, но гасится.
    const st = await withMutation(async (tx) => {
      const row = await tx.prepare("SELECT * FROM oauth_states WHERE kind = 'state' AND hash = ? FOR UPDATE").get(hashToken(stateRaw))
      if (row) await tx.prepare('DELETE FROM oauth_states WHERE id = ?').run(row.id)
      return row && row.provider === slug ? row : null
    })
    if (!st) return back(cabinetBaseUrl, 'error')
    const origin = st.return_origin
    if (st.expires_at <= now()) return back(origin, 'error')
    if (asString(q.error, 100)) return back(origin, q.error === 'access_denied' ? 'denied' : 'error')
    const code = asString(q.code, 500)
    if (!code) return back(origin, 'error')

    let subject
    try {
      subject = await P.fetchSubject({ config, code, verifier: st.code_verifier, fetchImpl, state: stateRaw, query: q })
      if (!SUBJECT_RE.test(subject)) throw new Error('id_missing')
    } catch (err) {
      // Только тип сбоя: тело ответа и тексты ошибок могут нести code/токен.
      app.log?.warn?.({ reason: String(err?.message || err?.name || 'unknown').slice(0, 40) }, `${slug}: обмен кода не удался`)
      return back(origin, 'error')
    }

    let outcome
    try {
      outcome = await withMutation(async (tx) => {
        const ts = now()
        if (st.intent === 'link') {
          const contact = await tx.prepare('SELECT id FROM contacts WHERE id = ? AND anonymized_at IS NULL FOR UPDATE').get(st.contact_id)
          if (!contact) return { status: 'error' }
          const owner = await tx.prepare('SELECT contact_id FROM client_identities WHERE provider = ? AND subject = ?').get(slug, subject)
          if (owner) return { status: owner.contact_id === st.contact_id ? 'linked' : 'already_linked' }
          const mine = await tx.prepare('SELECT id FROM client_identities WHERE provider = ? AND contact_id = ?').get(slug, st.contact_id)
          if (mine) {
            // У клиента уже был другой аккаунт этого провайдера: ключ ссылки у него действующий, так что перепривязка — его право (отвязать он вправе и так).
            await tx.prepare('UPDATE client_identities SET subject = ?, created_at = ?, last_login_at = NULL WHERE id = ?').run(subject, ts, mine.id)
            await audit(systemReq, 'update', 'client_identities', mine.id, `${P.name} перепривязан из кабинета: контакт #${st.contact_id}`, tx)
          } else {
            const info = await tx.prepare('INSERT INTO client_identities (contact_id, provider, subject, created_at) VALUES (?, ?, ?, ?) RETURNING id')
              .run(st.contact_id, slug, subject, ts)
            await audit(systemReq, 'create', 'client_identities', info.lastInsertRowid, `${P.name} привязан из кабинета: контакт #${st.contact_id}`, tx)
          }
          return { status: 'linked' }
        }
        // login: вход возможен только по привязке, созданной из кабинета по ключу, и только пока у клиента есть доступ.
        const ident = await tx.prepare('SELECT id, contact_id FROM client_identities WHERE provider = ? AND subject = ?').get(slug, subject)
        if (!ident) return { status: 'not_linked' }
        const contact = await tx.prepare('SELECT id FROM contacts WHERE id = ? AND anonymized_at IS NULL').get(ident.contact_id)
        if (!contact || !(await clientAccessFor(tx, ident.contact_id, mskToday())).ok) return { status: 'not_linked' }
        const ticket = newToken()
        await tx.prepare("INSERT INTO oauth_states (kind, provider, hash, intent, contact_id, created_at, expires_at) VALUES ('ticket', ?, ?, 'login', ?, ?, ?)")
          .run(slug, hashToken(ticket), ident.contact_id, ts, plusMs(TICKET_TTL_MS))
        await tx.prepare('UPDATE client_identities SET last_login_at = ? WHERE id = ?').run(ts, ident.id)
        await audit(systemReq, 'login', 'client_identities', ident.id, `вход в кабинет через ${P.name}: контакт #${ident.contact_id}`, tx)
        return { status: 'logged_in', ticket }
      })
    } catch (err) {
      // Одновременная привязка этого же аккаунта двумя клиентами: уникальность (provider, subject) — единственный, кто победил.
      outcome = { status: err?.code === '23505' ? 'already_linked' : 'error' }
      if (err?.code !== '23505') app.log?.warn?.({ reason: String(err?.code || err?.name || 'unknown').slice(0, 40) }, `${slug}: запись входа не удалась`)
    }
    return back(origin, outcome.status, outcome.ticket ? `&ticket=${outcome.ticket}` : '')
  })

  // ---- 3. обменять ticket на сессию ----
  app.post(`${base}/exchange`, { bodyLimit: 4 * 1024 }, async (req, reply) => {
    await applyCors(req, reply)
    if (hardRateLimited(`${slug}_exchange`, req.ip)) return reply.code(429).send()
    const ticket = asString(req.body?.ticket, 200)
    if (!ticket) return reply.code(404).send({ error: 'not_found' })
    const session = await withMutation(async (tx) => {
      // Тикет гасится при первой же попытке, в том числе неудачной.
      const row = await tx.prepare("SELECT * FROM oauth_states WHERE kind = 'ticket' AND hash = ? FOR UPDATE").get(hashToken(ticket))
      if (!row) return null
      await tx.prepare('DELETE FROM oauth_states WHERE id = ?').run(row.id)
      if (row.provider !== slug || row.expires_at <= now()) return null
      const contact = await tx.prepare('SELECT id FROM contacts WHERE id = ? AND anonymized_at IS NULL').get(row.contact_id)
      const access = contact ? await clientAccessFor(tx, row.contact_id, mskToday()) : { ok: false }
      if (!access.ok) return null
      const token = newToken()
      const expiresAt = plusMs(SESSION_TTL_MS)
      await tx.prepare("DELETE FROM client_links WHERE contact_id = ? AND kind = 'session' AND expires_at < ?").run(row.contact_id, now())
      const info = await tx.prepare("INSERT INTO client_links (contact_id, token_hash, created_at, expires_on, kind, expires_at) VALUES (?, ?, ?, ?, 'session', ?) RETURNING id")
        .run(row.contact_id, hashToken(token), now(), access.expiresOn, expiresAt)
      await audit(systemReq, 'create', 'client_links', info.lastInsertRowid, `сессия кабинета выдана (вход через ${P.name}): контакт #${row.contact_id}`, tx)
      return { token, expiresAt }
    })
    if (!session) return reply.code(404).send({ error: 'not_found' })
    return session
  })

  // ---- 4. отвязать ----
  app.post(`${base}/unlink`, { bodyLimit: 4 * 1024 }, async (req, reply) => {
    await applyCors(req, reply)
    if (hardRateLimited(`${slug}_unlink`, req.ip)) return reply.code(429).send()
    const key = await resolveClientKey(db, req.body?.token, mskToday(), now())
    if (!key) return reply.code(404).send({ error: 'not_found' })
    await withMutation(async (tx) => {
      const res = await tx.prepare('DELETE FROM client_identities WHERE provider = ? AND contact_id = ?').run(slug, key.contact_id)
      if (res?.changes) await audit(systemReq, 'delete', 'client_identities', key.contact_id, `${P.name} отвязан клиентом: контакт #${key.contact_id}`, tx)
    })
    return reply.code(204).send()
  })
}

export const registerYandexAuth = (app, deps) => registerClientAuth(app, 'yandex', deps)
export const registerVkAuth = (app, deps) => registerClientAuth(app, 'vk', deps)
