FROM node:22-alpine AS base
FROM base AS builder
WORKDIR /app

RUN npm install -g pnpm@10
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages packages
COPY apps/api apps/api

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @curriculum/api build

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 api

COPY --from=builder /app/apps/api/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages

USER api
EXPOSE 4000

ENV PORT=4000
ENV HOST=0.0.0.0

CMD ["node", "dist/index.js"]
