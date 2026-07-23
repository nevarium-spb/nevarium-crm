import { buildApp } from './app.js'
import { startOutboxWorker } from './telegram.js'
import { scheduleBackups } from './backup.js'

const secret = process.env.JWT_SECRET
if (!secret || secret.length < 16) {
  console.error('JWT_SECRET не задан или короче 16 символов — сервер не стартует.')
  process.exit(1)
}

const app = buildApp({
  dbFile: process.env.DB_FILE || './data/crm.sqlite',
  secret,
  secure: process.env.NODE_ENV !== 'development',
  logger: true,
})

startOutboxWorker(app.db, { log: app.log })
scheduleBackups(app.db, { log: app.log })

const port = Number(process.env.PORT || 3001)
app.listen({ port, host: '0.0.0.0' }).then(() => {
  app.log.info(`CRM API on :${port}`)
})
