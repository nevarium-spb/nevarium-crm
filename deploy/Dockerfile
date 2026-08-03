# Сборка сайта + сервер CRM в одном образе.
# При проблемах с Docker Hub из РФ раскомментируйте зеркало:
# FROM mirror.gcr.io/library/node:20-alpine AS build
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts && npm rebuild better-sqlite3
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# MAX (platform-api2.max.ru) подписан Национальным удостоверяющим центром Минцифры —
# этого корня нет в обычном наборе доверенных CA у Node, без него sendMax() будет
# падать с "unable to get local issuer certificate". Файл сертификата — server/certs/,
# добавляется, а не заменяет системные CA (NODE_EXTRA_CA_CERTS дополняет список).
ENV NODE_EXTRA_CA_CERTS=/app/server/certs/russian-trusted-root-ca.pem
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/package.json ./
# Собранный фронт — раньше собирался и терялся: сервер сам отдаёт его
# (server/index.js → staticDir), лишний контейнер с Caddy для App Platform не нужен.
COPY --from=build /app/dist ./dist
EXPOSE 3001
CMD ["node", "server/index.js"]
