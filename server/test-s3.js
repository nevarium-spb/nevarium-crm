// Проверка хранилища фото из консоли сервера: node server/test-s3.js  (или `npm run test-s3`).
// Пишет в бакет маленький служебный файл, читает его обратно и удаляет — так видно, что адрес, имя бакета,
// регион и ключи верны, а доступ на запись, чтение и удаление есть. Ключи не печатаются: только «задан».
import crypto from 'node:crypto'
import { createS3 } from './photos.js'

/** Настройки без секретов. */
export function describeS3Config(env = process.env) {
  return {
    endpoint: String(env.S3_ENDPOINT || '').trim(),
    bucket: String(env.S3_BUCKET || '').trim(),
    region: String(env.S3_REGION || 'ru-1').trim(),
    accessKeySet: String(env.S3_ACCESS_KEY || '').trim().length > 0,
    secretSet: String(env.S3_SECRET_KEY || '').trim().length > 0,
    limitMb: Number(env.PHOTO_STORAGE_LIMIT_MB) || 1024,
  }
}

/** Подсказка по коду ошибки хранилища — человеческим языком. */
export function explainS3Error(err) {
  const code = String(err?.code || '')
  if (code === 'S3_NOT_CONFIGURED') return 'Не заданы S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY или S3_SECRET_KEY.'
  if (code === 'HTTP_403') return 'Хранилище отказало в доступе: неверная пара ключей, ключ без прав на этот бакет или неверный регион (S3_REGION, у Timeweb обычно ru-1).'
  if (code === 'HTTP_404') return 'Бакет не найден: проверьте S3_BUCKET (имя ровно как в панели Timeweb) и S3_ENDPOINT.'
  if (code === 'ETIMEDOUT' || code === 'ECONNECTION') return 'Не удалось связаться с хранилищем: проверьте S3_ENDPOINT (https://s3.twcstorage.ru) и что сервер выходит в интернет по HTTPS.'
  if (code === 'MISMATCH') return 'Файл записался, но прочитался другим — хранилище работает некорректно, обратитесь в поддержку Timeweb.'
  if (code === 'NO_LIMIT') return 'Хранилище приняло файл больше лимита из подписи — ограничение размера не работает; видео напрямую в бакет включать нельзя, напишите в поддержку Timeweb (POST policy, content-length-range).'
  if (code === 'POST_REJECTED') return 'Хранилище не приняло загрузку по подписанной форме (POST policy). Подробности ответа — выше; без этого видео клиента напрямую в бакет не загрузить.'
  if (code.startsWith('HTTP_')) return 'Хранилище ответило ошибкой (код выше). Частые причины: переполнен тариф, неверное имя бакета или адрес.'
  return 'Неизвестная ошибка — приложите вывод выше, когда будете обращаться за помощью.'
}

/** Вынесено ради теста. Возвращает шаги проверки; запись упала — дальше не идём, чтение упало — всё равно пробуем удалить. */
export async function checkS3(s3) {
  const key = `healthcheck/${crypto.randomBytes(8).toString('hex')}.txt`
  const payload = Buffer.from(`nevarium-crm s3 check ${new Date().toISOString()}`)
  const steps = []
  const run = async (name, fn) => {
    try { await fn(); steps.push({ name, ok: true }); return true } catch (err) { steps.push({ name, ok: false, err }); return false }
  }
  if (!(await run('запись', () => s3.put(key, payload, 'text/plain')))) return steps
  await run('чтение', async () => {
    const back = await s3.get(key)
    if (!back || !back.equals(payload)) throw Object.assign(new Error('mismatch'), { code: 'MISMATCH' })
  })
  await run('удаление', () => s3.del(key))
  return steps
}

/**
 * Видео клиента идёт с телефона прямо в бакет по подписанной форме (ADR-025). Проверяем на настоящем хранилище: маленький «видеофайл»
 * загружается по форме, лежит нужного размера, а файл больше лимита из подписи отклоняется. Служебный файл тут же удаляется.
 */
export async function checkS3Presign(s3, fetchImpl = globalThis.fetch) {
  const key = `healthcheck/${crypto.randomBytes(8).toString('hex')}.mp4`
  const small = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(52, 1)])
  const steps = []
  const run = async (name, fn) => {
    try { await fn(); steps.push({ name, ok: true }); return true } catch (err) { steps.push({ name, ok: false, err }); return false }
  }
  const post = (buf) => {
    const form = s3.presignPost({ key, mime: 'video/mp4', maxBytes: 100, expiresSec: 300 })
    const fd = new FormData()
    for (const [k, v] of Object.entries(form.fields)) fd.append(k, v)
    fd.append('file', new Blob([buf], { type: 'video/mp4' }), 'check.mp4') // файл — последним полем, так требует S3
    return fetchImpl(form.url, { method: 'POST', body: fd, signal: AbortSignal.timeout(30_000) })
  }
  const ok = await run('загрузка по подписанной форме (так телефон клиента будет загружать видео)', async () => {
    const res = await post(small)
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300)
      throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'POST_REJECTED', detail: `HTTP ${res.status} ${detail}` })
    }
  })
  if (!ok) return steps
  await run('файл на месте и нужного размера', async () => {
    const head = await s3.head(key)
    if (!head || head.size !== small.length) throw Object.assign(new Error('size'), { code: 'MISMATCH' })
  })
  await run('файл больше лимита из подписи отклоняется', async () => {
    const res = await post(Buffer.alloc(200, 1))
    if (res.ok) throw Object.assign(new Error('accepted'), { code: 'NO_LIMIT' })
  })
  await run('удаление', () => s3.del(key))
  return steps
}

/** Домены сайта, с которых браузер клиента загружает видео в бакет. Переопределяется S3_CORS_ORIGINS (через запятую). */
export const DEFAULT_CORS_ORIGINS = ['https://nevarium-vizor.ru', 'https://www.nevarium-vizor.ru']

/** Правило CORS бакета: только эти домены, только POST (загрузка по подписанной форме). Чтение файлов браузером не нужно — их отдаёт CRM. */
export function corsXml(origins = DEFAULT_CORS_ORIGINS) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<CORSConfiguration><CORSRule><ID>nevarium-site-video-upload</ID>'
    + origins.map((o) => `<AllowedOrigin>${esc(o)}</AllowedOrigin>`).join('')
    + '<AllowedMethod>POST</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds>'
    + '</CORSRule></CORSConfiguration>'
}

const isMain = import.meta.main ?? process.argv[1]?.endsWith('test-s3.js')

if (isMain) {
  const cfg = describeS3Config()
  console.log('Настройки хранилища фото (ключи не показываются):')
  console.log(`  S3_ENDPOINT: ${cfg.endpoint || '— не задан'}`)
  console.log(`  S3_BUCKET: ${cfg.bucket || '— не задан'}`)
  console.log(`  S3_REGION: ${cfg.region}`)
  console.log(`  S3_ACCESS_KEY: ${cfg.accessKeySet ? 'задан' : '— не задан'}`)
  console.log(`  S3_SECRET_KEY: ${cfg.secretSet ? 'задан' : '— не задан'}`)
  console.log(`  PHOTO_STORAGE_LIMIT_MB: ${cfg.limitMb} (лимит тарифа хранилища для счётчика в «Настройках»)`)
  // Код выхода — через process.exitCode, а не process.exit(): exit() обрывает процесс, не дождавшись, пока консоль Timeweb
  // допишет вывод, и последняя строка («Текущие правила…», «Готово…») терялась.
  process.exitCode = await (async () => {
    const s3 = createS3()
    if (!s3.configured) {
      console.error(`\n${explainS3Error({ code: 'S3_NOT_CONFIGURED' })}`)
      return 1
    }
    const mode = String(process.argv[2] || '').toLowerCase()
    // `npm run test-s3 cors` — показать правила CORS бакета; `npm run test-s3 cors apply` — выставить (только домены сайта, только POST).
    if (mode === 'cors') {
      const origins = String(process.env.S3_CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)
      try {
        if (String(process.argv[3] || '').toLowerCase() === 'apply') {
          await s3.putCors(corsXml(origins.length ? origins : DEFAULT_CORS_ORIGINS))
          console.log(`\nПравило CORS выставлено: POST с ${(origins.length ? origins : DEFAULT_CORS_ORIGINS).join(', ')}`)
        }
        const current = await s3.getCors()
        console.log(`\nТекущие правила CORS бакета:\n${current || '— не заданы (выставить: npm run test-s3 cors apply)'}`)
        return 0
      } catch (err) {
        console.error(`\nОШИБКА: ${err?.code || err?.message}\n  что это значит: ${explainS3Error(err)}`)
        return 1
      }
    }
    let code = 0
    const print = (steps) => {
      for (const s of steps) {
        console.log(`\n${s.name}: ${s.ok ? 'OK' : 'ОШИБКА'}`)
        if (!s.ok) {
          code = 1
          console.error(`  код: ${s.err?.code || '—'}${s.err?.detail ? ` (${s.err.detail})` : ''}`)
          console.error(`  что это значит: ${explainS3Error(s.err)}`)
        }
      }
    }
    print(await checkS3(s3))
    console.log('\n--- Видео с телефона клиента прямо в бакет (подписанная форма) ---')
    print(await checkS3Presign(s3))
    if (!code) console.log('\nГотово: хранилище работает — фото из заявок и фото/видео этапа можно принимать.')
    return code
  })()
}
