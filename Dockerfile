# Сборка сайта + сервер CRM в одном образе.
# При проблемах с Docker Hub из РФ раскомментируйте зеркало:
# FROM mirror.gcr.io/library/node:22-alpine AS build
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
# better-sqlite3 убран (перевод на Postgres, план в nevarium-lab#3) — npm rebuild
# для него больше не нужен: `pg` чистый JS, нативных биндингов под платформу нет.
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# curl нужен не приложению, а платформе: Timeweb App Platform проверяет healthcheck,
# выполняя `curl` ВНУТРИ контейнера (не HTTP-запросом снаружи) — в node:*-alpine его
# нет по умолчанию, без него любой деплой уходит в "unhealthy" независимо от того,
# отвечает сервер или нет (подтверждено поддержкой Timeweb, тикет 12613721).
RUN apk add --no-cache curl
# MAX (platform-api2.max.ru) подписан Национальным удостоверяющим центром Минцифры —
# этого корня нет в обычном наборе доверенных CA у Node, без него sendMax() будет
# падать с "unable to get local issuer certificate". Файл сертификата — server/certs/,
# добавляется, а не заменяет системные CA (NODE_EXTRA_CA_CERTS дополняет список).
ENV NODE_EXTRA_CA_CERTS=/app/server/certs/russian-trusted-root-ca.pem
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
# src/shared — единственное, что сервер импортирует за пределами своей папки:
# `server/db.js` реэкспортирует оттуда список стадий сделки, общий с фронтом
# (см. CLAUDE.md). Без этой строки образ СОБИРАЕТСЯ УСПЕШНО и падает только при
# старте — `ERR_MODULE_NOT_FOUND: /app/src/shared/stages.js`, то есть неудачным
# оказался бы уже сам деплой. Поймано пробной сборкой образа перед выкаткой.
# Копируем только shared, не весь src: исходники фронта в рантайме не нужны,
# в образ уезжает уже собранный dist.
COPY --from=build /app/src/shared ./src/shared
COPY --from=build /app/package.json ./
# Собранный фронт — раньше собирался и терялся: сервер сам отдаёт его
# (server/index.js → staticDir), лишний контейнер с Caddy для App Platform не нужен.
COPY --from=build /app/dist ./dist
EXPOSE 3001
CMD ["node", "server/index.js"]
