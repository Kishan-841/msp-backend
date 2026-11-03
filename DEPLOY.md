# Deploying the MSP CRM backend (VM + Docker)

`docker-compose.yml` runs:

| Service | What | Exposed |
|---|---|---|
| `db` | PostgreSQL 16, data in the `pgdata` volume | no (private network only) |
| `api` | this Express API; on every start runs `prisma db push`, then `node dist/index.js` | `127.0.0.1:${API_PORT}` (default 5007) — localhost only |
| `caddy` | *optional* (`--profile caddy`) HTTPS proxy, only for a VM with nothing on 80/443 | 80 + 443 |

HTTPS is done by the VM's existing nginx (like the other projects on it). The frontend is on Vercel.

## 1. Prepare (once)

- DNS: an **A record** for the API hostname (e.g. `msp-api.yourcompany.com`) → the VM's public IP.
- Pick a free local port for `API_PORT` — check with `sudo ss -ltnp | grep 127.0.0.1:5007` (no output = free).

## 2. First deploy

```bash
git clone https://github.com/Kishan-841/msp-backend.git && cd msp-backend
cp .env.example .env
nano .env          # fill in everything — see below
docker compose up -d --build
docker compose logs -f api     # watch: schema push → "Server running" → "Created the first Admin"
curl http://127.0.0.1:5007/api/v1/health
```

Then nginx + HTTPS — `docker/nginx.conf` has the site config and the 4 commands (link, test, reload, certbot).

`.env` essentials:

- `API_DOMAIN`, `API_PORT`.
- `POSTGRES_PASSWORD`, `JWT_SECRET`, `JWT_REFRESH_SECRET` — long random values (`openssl rand -base64 48`), all different.
- `CORS_ORIGIN` — the exact frontend URL, e.g. `https://msp-crm.vercel.app` (no trailing slash; comma-separate several).
- `COOKIE_SAMESITE=none` — needed because Vercel and the VM are different sites (requires HTTPS).
- `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` (≥ 12 chars) — creates the first Admin on an empty database.
  **Delete both lines after you log in**, then `docker compose up -d`.

Check: `curl https://<API_DOMAIN>/api/v1/health` → `{"success":true,...}`.

## 3. Frontend (Vercel)

In the Vercel project → Settings → Environment Variables:

```
NEXT_PUBLIC_API_URL=https://api.yourcompany.com/api/v1
```

Redeploy after changing it (it is baked in at build time). Then put that Vercel URL in the backend's `CORS_ORIGIN`.

## 4. Updating

```bash
git pull
docker compose up -d --build api
```

The container applies schema changes with `prisma db push` before starting. If a change would **lose data**
(dropping a column/table that has values), the push stops and the API does not start — the logs say why.
Back up first, then, only if the loss is intended:

```bash
docker compose run --rm api npx prisma db push --accept-data-loss
docker compose up -d api
```

## 5. Backups

```bash
# backup
docker compose exec -T db pg_dump -U msp -d msp_crm -Fc > backup-$(date +%F).dump
# restore into an empty database
docker compose exec -T db pg_restore -U msp -d msp_crm --clean --if-exists < backup-YYYY-MM-DD.dump
```

Run the backup from cron daily and copy it off the VM. Uploaded files live in the `uploads` volume —
back that up too (`docker run --rm -v msp-backend_uploads:/u -v $PWD:/b alpine tar czf /b/uploads.tgz -C /u .`).
Backups contain customer data and password hashes: keep them private.

## Moving existing data from the dev machine

```bash
pg_dump -Fc "$OLD_DATABASE_URL" > crm.dump                       # on the old machine
docker compose exec -T db pg_restore -U msp -d msp_crm --clean --if-exists < crm.dump   # on the VM
```

Do **not** run `prisma/seed.ts` against a real database — it creates demo users with known passwords.

## Useful

- Logs: `docker compose logs -f api` · Restart: `docker compose restart api`
- psql: `docker compose exec db psql -U msp -d msp_crm`
- Integration API for the other software: see `docs/INTEGRATION_API.md` (base URL = `https://<API_DOMAIN>/api/v1`).
