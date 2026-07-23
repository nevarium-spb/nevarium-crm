// Локальная разработка: значения по умолчанию, чтобы стартовать одной командой.
process.env.JWT_SECRET ||= 'dev-secret-dev-secret'
process.env.NODE_ENV ||= 'development'
process.env.DB_FILE ||= './data/dev.sqlite'
await import('./index.js')
