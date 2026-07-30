// Локальная разработка: значения по умолчанию, чтобы стартовать одной командой.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.JWT_SECRET ||= 'dev-secret-dev-secret'
process.env.NODE_ENV ||= 'development'
process.env.DB_FILE ||= './data/dev.sqlite'
// MAX требует корневой сертификат Минцифры, которого нет в обычном наборе CA у Node
// (см. deploy/Dockerfile) — без него локальная проверка sendMax() падает по TLS.
process.env.NODE_EXTRA_CA_CERTS ||= path.join(path.dirname(fileURLToPath(import.meta.url)), 'certs', 'russian-trusted-root-ca.pem')
await import('./index.js')
