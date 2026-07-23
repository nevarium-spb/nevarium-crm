# Невариум CRM

Единый инбокс заявок и воронка сделок для всех проектов Невариум (Лаб ИИ, Визор и будущих).
Заявки с форм и чат-ботов сайтов попадают сюда автоматически; сделки двигаются по стадиям,
задачи и история держат клиентов в поле зрения.

## Стек

- **Бэкенд:** Node.js + Fastify + better-sqlite3 (SQLite), авторизация bcrypt + cookie-сессия
- **Фронтенд:** React 18 + react-router (Vite), без Tailwind — обычный CSS + токены
- **Хранение:** SQLite-файл (`data/dev.sqlite`) — на российском VPS законно по 152-ФЗ и просто в бэкапе

## Запуск локально

```bash
npm install
node server/dev.js        # бэкенд на :3001 (dev-дефолты: JWT_SECRET, DB_FILE=./data/dev.sqlite)
npm run dev               # фронтенд на :5173 (проксирует /api на :3001)
npm run seed-admin        # создать первого администратора (интерактивно)
npm test                  # 49 тестов (парсер + API)
```

Открыть `http://localhost:5173/` → перекинет на `/crm`.

## Прод

Бэкенд (`server/index.js`) требует `JWT_SECRET` (≥16 симв.) и `DB_FILE`. Готовый деплой —
в `deploy/` (Dockerfile + docker-compose + Caddyfile, SPA-fallback и HTTPS). Подробности —
`deploy/README.md`.

## Документы

- `CLAUDE.md` — конвенции и архитектура для ИИ-агента
- `docs/DECISIONS.md` — журнал ключевых решений (ADR)
- `HANDOFF.md` — текущее состояние и следующий шаг
- `docs/designs/nevarium-crm.md` — утверждённый дизайн-спек «Приборная панель»
