# Развёртывание: Невариум CRM на Timeweb Cloud

Хостинг — **Timeweb Cloud** (ADR-004 в `docs/DECISIONS.md`): дешевле и проще для одной
Docker-машины с постоянным диском под SQLite, чем Яндекс.Cloud. Один VPS/Cloud App
(~450 ₽/мес, 1 ГБ RAM достаточно) хостит бэкенд CRM, приём лидов и фронт CRM (`/crm`).
Маркетинговые сайты (nevarium1, nevarium_vizor) — отдельные проекты, хостятся отдельно
(Vercel), сюда только шлют заявки через `POST /api/leads`.

## Что нужно от вас (один раз)

1. **Аккаунт Timeweb Cloud** — создать самостоятельно (я не создаю аккаунты за вас), timeweb.cloud.
2. **Домен/поддомен** для CRM (например, `crm.nevarium-lab.ru` — как поддомен уже купленного nevarium-lab.ru, DNS через Ru-Center) или отдельный.
3. **VPS или Cloud App в Timeweb**: Ubuntu 22.04+, 1–2 ГБ RAM, Docker (на VPS — `curl -fsSL https://get.docker.com | sh`; Cloud Apps ставит сам).
4. **Telegram-бот**: напишите @BotFather → `/newbot` → получите токен. Добавьте бота в рабочую группу. Узнайте chat_id группы: добавьте туда @getmyid_bot (он покажет id вида `-100…`) и удалите его.
5. **DNS**: A-запись поддомена → IP VPS (или CNAME, если Cloud Apps даёт свой адрес).

## Установка (на VPS)

```bash
git clone https://github.com/nevarium-spb/nevarium-crm.git && cd nevarium-crm

# 1. Секреты
cp deploy/.env.example deploy/.env
nano deploy/.env          # JWT_SECRET (openssl rand -hex 32), TG_BOT_TOKEN, TG_CHAT_ID

# 2. Домен
nano deploy/Caddyfile     # замените example.ru на ваш поддомен CRM

# 3. Сборка фронта CRM (на VPS или локально с копированием dist/)
docker run --rm -v "$PWD":/app -w /app node:20-alpine sh -c "npm ci --ignore-scripts && npm run build"

# 4. Запуск
cd deploy && docker compose up -d --build

# 5. Первый администратор (пароль запрашивается интерактивно, в env не хранится)
docker compose exec app node server/seed-admin.js
```

### 6. Домены сайтов, с которых принимаются заявки

Без этого браузер заблокирует отправку формы (CORS), а заявка не определит свой проект.
Домены хранятся в БД, в колонке `projects.origins` — через запятую, без слеша на конце:

```bash
docker compose exec app node -e "
  const { openDb } = await import('./server/db.js');
  const db = openDb(process.env.DB_FILE || '/data/crm.sqlite');
  db.prepare(\"UPDATE projects SET origins = ? WHERE slug = ?\")
    .run('https://nevarium-lab.ru,https://www.nevarium-lab.ru', 'nevarium1');
  db.prepare(\"UPDATE projects SET origins = ? WHERE slug = ?\")
    .run('https://домен-визора', 'nevarium-vizor');
  console.log(db.prepare('SELECT slug, origins FROM projects').all());
"
```

У «Невариум Лаб ИИ» домены уже прописаны миграцией; **у Визора пусто — впишите его домен
перед подключением форм этого сайта.**

Проверка: откройте `https://ваш-домен/crm` → логин → дашборд. Отправьте тестовую заявку с сайта — она должна появиться в «Новых лидах», а в Telegram-группу придёт обезличенное уведомление со ссылкой на карточку (имя и телефон в уведомление не попадают — так требует 152-ФЗ, см. ADR-006).

> **Docker Hub из РФ**: если `docker compose build` не может скачать образы, раскомментируйте зеркало в `deploy/Dockerfile` (mirror.gcr.io) или настройте registry-mirror в `/etc/docker/daemon.json` (huecker.io, dockerhub.timeweb.cloud).

## Обновление

```bash
git pull
docker run --rm -v "$PWD":/app -w /app node:20-alpine sh -c "npm ci --ignore-scripts && npm run build"
cd deploy && docker compose up -d --build
```

## Откат

```bash
git checkout <прошлый-коммит> && # пересборка как выше
```

## Бэкапы

- Автоматически: каждую ночь в 04:00 МСК сервер делает `VACUUM INTO` (безопасно для SQLite в WAL) и отправляет файл в Telegram. 7 копий хранятся в volume `crm-data`.
- Восстановление: остановить app, заменить `/data/crm.sqlite` файлом бэкапа, запустить:
  ```bash
  docker compose stop app
  docker compose cp ./crm-2026-07-10.sqlite app:/data/crm.sqlite
  docker compose start app
  ```
- Ручной экспорт JSON — в CRM: Настройки → Экспорт JSON.

## Локальная разработка

```bash
# терминал 1: API (dev-режим, cookie без Secure)
JWT_SECRET=dev-secret-dev-secret NODE_ENV=development DB_FILE=./data/dev.sqlite node server/index.js
# терминал 2: сайт (vite proxy /api → :3001 уже настроен)
npm run dev
```
