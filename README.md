# MSP CRM — API

Express + TypeScript + Prisma (PostgreSQL) + Socket.io. Frontend: [msp-frontend](https://github.com/Kishan-841/msp-frontend).

## Local development

```bash
npm install
cp .env.example .env      # set DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET; COOKIE_SAMESITE=lax; CORS_ORIGIN=http://localhost:3000
npx prisma db push        # create/update tables
npx prisma generate
npm run dev               # http://localhost:5001/api/v1/health
```

## Production

Docker (Postgres + API + Caddy HTTPS) — see **[DEPLOY.md](DEPLOY.md)**.
`npm run build && npm start` also works on a plain Node 22 host.

Integration API for other software: [docs/INTEGRATION_API.md](docs/INTEGRATION_API.md).
