# ── MSP CRM API ───────────────────────────────────────────────────────────────
# Build:  docker compose build      Run: docker compose up -d   (see DEPLOY.md)

FROM node:22-slim AS build
WORKDIR /app
# openssl: Prisma's schema engine needs it
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
# prisma generate reads the config, which needs a DATABASE_URL to exist (not to connect)
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" npx prisma generate
COPY src ./src
# compiles src → dist and copies the generated Prisma client (plain .js, which tsc skips)
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
# the Prisma CLI (a dev dependency) stays in the image: the container runs `prisma db push` on start
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
  && mkdir -p /app/uploads && chown -R node:node /app/uploads
USER node
EXPOSE 5001
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||5001)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["entrypoint.sh"]
CMD ["node", "dist/index.js"]
