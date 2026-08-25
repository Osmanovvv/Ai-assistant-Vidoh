# Боевой образ бота (задача 1.23).
#
# Сборка многоступенчатая: инструменты сборки и devDependencies в итоговый
# образ не попадают. Разница не косметическая — это и размер, и площадь
# для атаки на машине, где лежат расшифровки чужих голосовых.

# ─── Ступень 1: сборка ────────────────────────────────────────────────────────
FROM node:24-alpine AS build

WORKDIR /app

# Манифесты отдельным слоем: пока зависимости не менялись, слой с их
# установкой берётся из кэша, и пересборка занимает секунды.
COPY package.json package-lock.json ./
COPY apps/bot/package.json ./apps/bot/package.json
RUN npm ci

COPY tsconfig.base.json ./
COPY apps/bot ./apps/bot

RUN npm run build --workspace @vydoh/bot

# ─── Ступень 2: зависимости для боя ───────────────────────────────────────────
FROM node:24-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/bot/package.json ./apps/bot/package.json
RUN npm ci --omit=dev
# Папка рабочего пространства может не появиться, если всё поднялось в
# корень. COPY на отсутствующий путь — ошибка сборки, поэтому создаём.
RUN mkdir -p apps/bot/node_modules

# ─── Ступень 3: то, что поедет на сервер ──────────────────────────────────────
FROM node:24-alpine

# ffmpeg нужен модулю speech: нарезка по паузам и приведение к моно 16 кГц.
# tini разбирает сигналы и хоронит осиротевшие процессы ffmpeg — без него
# PID 1 не пересылает SIGTERM, и штатная остановка превращается в убийство.
RUN apk add --no-cache ffmpeg tini

WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/bot/node_modules ./apps/bot/node_modules
COPY --from=build /app/apps/bot/dist ./apps/bot/dist
# Миграции лежат рядом с кодом: контейнер должен уметь накатить схему сам,
# без доступа к репозиторию.
COPY --from=build /app/apps/bot/drizzle ./apps/bot/drizzle
COPY package.json ./
COPY apps/bot/package.json ./apps/bot/package.json

# Пользователь node есть в образе изначально. Работать под root на машине,
# где лежат чужие расшифровки, незачем.
USER node

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/bot/dist/index.js"]
