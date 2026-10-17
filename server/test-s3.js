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
  const s3 = createS3()
  if (!s3.configured) {
    console.error(`\n${explainS3Error({ code: 'S3_NOT_CONFIGURED' })}`)
    process.exit(1)
  }
  const steps = await checkS3(s3)
  let code = 0
  for (const s of steps) {
    console.log(`\n${s.name}: ${s.ok ? 'OK' : 'ОШИБКА'}`)
    if (!s.ok) {
      code = 1
      console.error(`  код: ${s.err?.code || '—'}`)
      console.error(`  что это значит: ${explainS3Error(s.err)}`)
    }
  }
  if (!code) console.log('\nГотово: хранилище работает, фото из заявок можно принимать.')
  process.exit(code)
}
