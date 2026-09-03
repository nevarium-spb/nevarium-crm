import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from './app.js'
import { bootstrapAdmin } from './bootstrap.js'
import { startOutboxWorker } from './telegram.js'
import { scheduleBackups } from './backup.js'

const secret = process.env.JWT_SECRET
if (!secret || secret.length < 16) {
  console.error('JWT_SECRET не задан или короче 16 символов — сервер не стартует.')
  process.exit(1)
}

// server/ и dist/ лежат рядом в собранном образе (см. deploy/Dockerfile) — путь
// считаем от расположения этого файла, а не от текущей рабочей директории.
const staticDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')

// DB_FILE (путь к SQLite) заменён на DATABASE_URL (строка подключения к Postgres) —
// перевод на Postgres, план в nevarium-lab#3. buildApp — теперь async.
const app = await buildApp({
  dbConfig: process.env.DATABASE_URL,
  secret,
  secure: process.env.NODE_ENV !== 'development',
  logger: true,
  staticDir,
})

await bootstrapAdmin(app.db, { log: app.log })

startOutboxWorker(app.db, { log: app.log })
scheduleBackups(app.db, { log: app.log })

const port = Number(process.env.PORT || 3001)
app.listen({ port, host: '0.0.0.0' }).then(() => {
  app.log.info(`CRM API on :${port}`)
})
