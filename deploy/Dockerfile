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
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/package.json ./
EXPOSE 3001
CMD ["node", "server/index.js"]
