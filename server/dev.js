// Локальная разработка: значения по умолчанию, чтобы стартовать одной командой.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.JWT_SECRET ||= 'dev-secret-dev-secret'
process.env.NODE_ENV ||= 'development'
// DB_FILE (путь к SQLite, самодостаточный по умолчанию) заменён на DATABASE_URL —
// перевод на Postgres, план в nevarium-lab#3. У Postgres нет эквивалента «просто
// файл, который появится сам»: нужен реальный сервер. Без переменной в окружении
// index.js/openDb() упадёт на подключении — с понятным сообщением от `pg`, не молча.
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL не задан — локальный dev-сервер теперь тоже требует Postgres (перевод на Postgres, nevarium-lab#3). Укажите строку подключения в окружении.')
  process.exit(1)
}
// MAX требует корневой сертификат Минцифры, которого нет в обычном наборе CA у Node
// (см. deploy/Dockerfile) — без него локальная проверка sendMax() падает по TLS.
process.env.NODE_EXTRA_CA_CERTS ||= path.join(path.dirname(fileURLToPath(import.meta.url)), 'certs', 'russian-trusted-root-ca.pem')
await import('./index.js')
