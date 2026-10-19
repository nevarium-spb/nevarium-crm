// Проверка каналов уведомлений о заявках из консоли сервера: `npm run test-notify` (оба канала),
// `npm run test-notify max` или `npm run test-notify tg`. По шагам: токен принят → чат найден и активен →
// тестовое сообщение дошло. На каждом шаге — что именно не так и что поправить. Токены не печатаются: только
// «задан» и длина. Тестовое сообщение без персональных данных (как и все уведомления, ADR-018).
import { MAX_API, channelError } from './telegram.js'

const TEST_TEXT = '🔧 Невариум CRM: проверка связи. Если вы это читаете — уведомления о новых заявках будут приходить сюда.'

/** Настройки без секретов. */
export function describeNotifyConfig(env = process.env) {
  const tgToken = String(env.TG_BOT_TOKEN || '').trim()
  const maxToken = String(env.MAX_BOT_TOKEN || '').trim()
  return {
    tg: { tokenSet: tgToken.length > 0, tokenLength: tgToken.length, chatId: String(env.TG_CHAT_ID || '').trim() },
    max: { tokenSet: maxToken.length > 0, tokenLength: maxToken.length, chatId: String(env.MAX_CHAT_ID || '').trim() },
  }
}

async function jsonOrNull(res) {
  try { return await res.json() } catch { return null }
}

/** Один шаг проверки: возвращает { name, ok, info?, error?, hint? }. */
async function step(name, fn) {
  try { return { name, ok: true, ...(await fn()) } } catch (err) {
    return { name, ok: false, error: String(err?.message || err), hint: err?.hint || '' }
  }
}

const hinted = (message, hint) => Object.assign(new Error(message), { hint })

/** MAX: токен → чат → тестовое сообщение. fetchImpl подменяется в тесте. */
export async function checkMax(env = process.env, fetchImpl = fetch) {
  const token = String(env.MAX_BOT_TOKEN || '').trim()
  const chatId = String(env.MAX_CHAT_ID || '').trim()
  const steps = []
  const missing = [!token && 'MAX_BOT_TOKEN', !chatId && 'MAX_CHAT_ID'].filter(Boolean)
  if (missing.length) {
    steps.push({ name: 'настройки', ok: false, error: `не заданы: ${missing.join(', ')}`, hint: 'Добавьте их в настройки приложения Timeweb и перезапустите приложение.' })
    return steps
  }
  if (!/^-?\d+$/.test(chatId)) {
    steps.push({ name: 'настройки', ok: false, error: 'MAX_CHAT_ID должен быть числом (может быть отрицательным), а там что-то другое', hint: 'Скопируйте числовой идентификатор чата или канала, а не ссылку и не название.' })
    return steps
  }
  steps.push({ name: 'настройки', ok: true, info: `токен задан, чат ${chatId}` })
  const headers = { Authorization: token }
  const timeout = () => AbortSignal.timeout(10_000)

  const me = await step('токен бота', async () => {
    const res = await fetchImpl(`${MAX_API}/me`, { headers, signal: timeout() })
    if (res.status === 401) throw hinted('MAX не принял токен (401)', 'Проверьте MAX_BOT_TOKEN: токен бота скопирован целиком, без пробелов и кавычек, и это токен именно этого бота.')
    if (!res.ok) throw await channelError('MAX', res)
    const body = await jsonOrNull(res)
    return { info: `бот «${body?.first_name || body?.name || '?'}»${body?.username ? ` (@${body.username})` : ''}` }
  })
  steps.push(me)
  if (!me.ok) return steps

  const chat = await step('чат', async () => {
    const res = await fetchImpl(`${MAX_API}/chats/${chatId}`, { headers, signal: timeout() })
    if (res.status === 401) throw hinted('MAX не принял токен (401)', 'Проверьте MAX_BOT_TOKEN.')
    if (!res.ok) {
      const err = await channelError('MAX', res)
      err.hint = 'Чат не найден или бота в нём нет: добавьте бота в этот чат (в канале — администратором, с правом писать) и проверьте MAX_CHAT_ID; идентификатор может быть отрицательным.'
      throw err
    }
    const body = await jsonOrNull(res)
    if (body?.status && body.status !== 'active') {
      throw hinted(`чат в состоянии «${body.status}»`, 'Бот исключён из чата, вышел из него или чат закрыт: добавьте бота снова либо создайте новый чат и обновите MAX_CHAT_ID.')
    }
    return { info: `${body?.type || 'чат'} «${body?.title || 'без названия'}», участников: ${body?.participants_count ?? '?'}` }
  })
  steps.push(chat)
  if (!chat.ok) return steps

  steps.push(await step('тестовое сообщение', async () => {
    const url = new URL(`${MAX_API}/messages`)
    url.searchParams.set('chat_id', chatId)
    const res = await fetchImpl(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ text: TEST_TEXT, format: 'html' }), signal: timeout() })
    if (!res.ok) {
      const err = await channelError('MAX', res)
      err.hint = 'MAX принял токен и нашёл чат, но отклонил сообщение — причина в тексте выше.'
      throw err
    }
    return { info: 'отправлено — проверьте чат' }
  }))
  return steps
}

/**
 * MAX: какие чаты видит бот. Список чатов у MAX отключён, поэтому идентификатор берём из событий бота (GET /updates):
 * нажали «Начать» в боте, написали ему или добавили его в чат — в событии есть числовой chat_id. Текст сообщений
 * НЕ читаем и не выводим — только идентификатор и тип события. Возвращает { chats: [{chatId, via}], error? }.
 */
export async function discoverMaxChats(env = process.env, fetchImpl = fetch) {
  const token = String(env.MAX_BOT_TOKEN || '').trim()
  if (!token) return { chats: [], error: 'MAX_BOT_TOKEN не задан' }
  const url = new URL(`${MAX_API}/updates`)
  url.searchParams.set('limit', '100')
  url.searchParams.set('timeout', '5')
  let res
  try {
    res = await fetchImpl(url, { headers: { Authorization: token }, signal: AbortSignal.timeout(20_000) })
  } catch (err) {
    return { chats: [], error: `не удалось связаться с MAX: ${err?.message || err}` }
  }
  if (res.status === 401) return { chats: [], error: 'MAX не принял токен (401): проверьте MAX_BOT_TOKEN' }
  if (!res.ok) return { chats: [], error: String((await channelError('MAX', res)).message) }
  const body = await jsonOrNull(res)
  const seen = new Map()
  for (const u of body?.updates || []) {
    const via = String(u?.update_type || u?.type || 'событие')
    const ids = [u?.chat_id, u?.message?.recipient?.chat_id, u?.callback?.message?.recipient?.chat_id]
    for (const id of ids) {
      if (id === undefined || id === null || !/^-?\d+$/.test(String(id))) continue
      const key = String(id)
      if (!seen.has(key)) seen.set(key, new Set())
      seen.get(key).add(via)
    }
  }
  return { chats: [...seen].map(([chatId, vias]) => ({ chatId, via: [...vias].join(', ') })) }
}

/** Telegram: токен → чат → тестовое сообщение. */
export async function checkTelegram(env = process.env, fetchImpl = fetch) {
  const token = String(env.TG_BOT_TOKEN || '').trim()
  const chatId = String(env.TG_CHAT_ID || '').trim()
  const steps = []
  const missing = [!token && 'TG_BOT_TOKEN', !chatId && 'TG_CHAT_ID'].filter(Boolean)
  if (missing.length) {
    steps.push({ name: 'настройки', ok: false, error: `не заданы: ${missing.join(', ')}`, hint: 'Токен выдаёт @BotFather, chat_id — число чата или группы (для групп отрицательное). Добавьте в настройки приложения Timeweb и перезапустите.' })
    return steps
  }
  steps.push({ name: 'настройки', ok: true, info: `токен задан, чат ${chatId}` })
  const api = (method, body) => fetchImpl(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(10_000) })

  const me = await step('токен бота', async () => {
    const res = await api('getMe')
    if (res.status === 401 || res.status === 404) throw hinted('Telegram не принял токен', 'Проверьте TG_BOT_TOKEN: токен от @BotFather, целиком, без пробелов и кавычек.')
    if (!res.ok) throw await channelError('Telegram', res)
    const body = await jsonOrNull(res)
    return { info: `бот @${body?.result?.username || '?'}` }
  })
  steps.push(me)
  if (!me.ok) return steps

  const chat = await step('чат', async () => {
    const res = await api('getChat', { chat_id: chatId })
    if (!res.ok) {
      const err = await channelError('Telegram', res)
      err.hint = 'Чат не найден или бот в нём не состоит: напишите боту /start (для личного чата) или добавьте его в группу, и проверьте TG_CHAT_ID.'
      throw err
    }
    const body = await jsonOrNull(res)
    return { info: `${body?.result?.type || 'чат'} «${body?.result?.title || body?.result?.first_name || 'без названия'}»` }
  })
  steps.push(chat)
  if (!chat.ok) return steps

  steps.push(await step('тестовое сообщение', async () => {
    const res = await api('sendMessage', { chat_id: chatId, text: TEST_TEXT, parse_mode: 'HTML' })
    if (!res.ok) throw await channelError('Telegram', res)
    return { info: 'отправлено — проверьте чат' }
  }))
  return steps
}

const isMain = import.meta.main ?? process.argv[1]?.endsWith('test-notify.js')

if (isMain) {
  const which = String(process.argv[2] || 'all').toLowerCase()
  const cfg = describeNotifyConfig()
  const run = async (title, cfgPart, check) => {
    console.log(`\n=== ${title} ===`)
    console.log(`  токен: ${cfgPart.tokenSet ? `задан, ${cfgPart.tokenLength} симв.` : '— не задан'}`)
    console.log(`  chat_id: ${cfgPart.chatId || '— не задан'}`)
    const steps = await check()
    let code = 0
    for (const s of steps) {
      console.log(`\n${s.name}: ${s.ok ? 'OK' : 'ОШИБКА'}${s.info ? ` — ${s.info}` : ''}`)
      if (!s.ok) { code = 1; console.error(`  ${s.error}`); if (s.hint) console.error(`  что делать: ${s.hint}`) }
    }
    return code
  }
  let code = 0
  // `npm run test-notify max ids` — найти chat_id: сначала нажмите «Начать» в боте и напишите ему слово (или добавьте бота в чат).
  if (which === 'max' && String(process.argv[3] || '').toLowerCase() === 'ids') {
    const found = await discoverMaxChats()
    console.log('\n=== MAX: какие чаты видит бот ===')
    if (found.error) { console.error(`  ${found.error}`); process.exit(1) }
    if (!found.chats.length) {
      console.log('  Событий нет. Откройте бота в MAX, нажмите «Начать» и напишите ему любое слово (либо добавьте бота в чат и напишите там),')
      console.log('  затем сразу повторите эту команду — события хранятся недолго.')
      process.exit(1)
    }
    for (const c of found.chats) console.log(`  chat_id: ${c.chatId}   (событие: ${c.via})`)
    console.log('\n  Это значение — в MAX_CHAT_ID (настройки приложения Timeweb). Потом перезапустите приложение и выполните `npm run test-notify max`.')
    process.exit(0)
  }
  if (which === 'all' || which === 'max') code |= await run('MAX', cfg.max, () => checkMax())
  if (which === 'all' || which === 'tg' || which === 'telegram') code |= await run('Telegram', cfg.tg, () => checkTelegram())
  if (!['all', 'max', 'tg', 'telegram'].includes(which)) { console.error('Использование: npm run test-notify [max|tg]'); code = 1 }
  process.exit(code)
}
