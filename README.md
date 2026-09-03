# Невариум CRM

Единый инбокс заявок и воронка сделок для всех проектов Невариум (Лаб ИИ, Визор и будущих).
Заявки с форм и чат-ботов сайтов попадают сюда автоматически; сделки двигаются по стадиям,
задачи и история держат клиентов в поле зрения.

## Стек

- **Бэкенд:** Node.js + Fastify + `pg` (PostgreSQL), авторизация bcrypt + cookie-сессия
- **Фронтенд:** React 18 + react-router (Vite), без Tailwind — обычный CSS + токены
- **Хранение:** управляемый PostgreSQL у российского провайдера (Timeweb) — 152-ФЗ требует
  хранить ПДн в РФ. Схема — одним файлом `server/schema.sql`, применяется на старте
  идемпотентно. Раньше был файл SQLite; перевод — ADR-003 «заменено», план в
  `nevarium-spb/nevarium-lab#3`.

## Запуск локально

```bash
npm install
# DATABASE_URL обязателен: нужен работающий Postgres, файла-базы «из коробки» больше нет
DATABASE_URL=postgresql://user:pass@localhost:5432/nevarium_crm node server/dev.js
npm run dev               # фронтенд на :5173 (проксирует /api на :3001)
npm run seed-admin        # создать первого администратора (интерактивно)
npm test                  # 190 тестов: 188 зелёных + 2 намеренно it.skip (см. CLAUDE.md)
```

Открыть `http://localhost:5173/` → перекинет на `/crm`.

Тесты Postgres не требуют: они поднимают `pg-mem` (эмулятор в памяти) на каждый тест.

## Прод

Бэкенд (`server/index.js`) требует `JWT_SECRET` (≥16 симв.) и `DATABASE_URL`. Готовый деплой —
в `deploy/` (Dockerfile, SPA-fallback и HTTPS). Подробности — `deploy/README.md`.

## Документы

- `CLAUDE.md` — конвенции и архитектура для ИИ-агента
- `docs/DECISIONS.md` — журнал ключевых решений (ADR)
- `HANDOFF.md` — текущее состояние и следующий шаг
- `docs/designs/nevarium-crm.md` — утверждённый дизайн-спек «Приборная панель»
