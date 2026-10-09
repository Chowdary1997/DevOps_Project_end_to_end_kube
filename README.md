# Coming Soon: PostgreSQL edition

```
backend/    Node.js 20 + Express API, Dockerfile, migrations/
frontend/   static landing page served by nginx (unprivileged), Dockerfile
database/   PostgreSQL 16 image with hardened config and init script, Dockerfile
docker-compose.yml
```

## Run
```
cp .env.example .env        # set real values and secrets
docker compose up --build -d
docker compose logs -f backend
```
Open http://localhost:8080. The backend applies migrations on startup. Migrations are guarded by an advisory lock, so multiple backend replicas are safe.

Use `docker compose exec db psql -U $POSTGRES_USER -d $POSTGRES_DB` for a SQL shell. The database is on an internal network with no published port.

## Launch workflow
```
curl -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"launchAt":"2026-12-01T09:00:00Z"}' http://localhost:8080/api/admin/launch-date
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:8080/api/admin/launch
```

## Operations
- Backups: `docker compose exec db pg_dump -U $POSTGRES_USER -Fc $POSTGRES_DB > backup.dump`. Schedule it and test restores. For point-in-time recovery, use WAL archiving or a managed Postgres.
- Production: terminate TLS in front of the frontend, set `DATABASE_SSL=1` with a managed database, and move secrets to a secrets manager instead of `.env`.
- Email: configure SPF, DKIM and DMARC for the sending domain. Bounce and complaint events go to `POST /api/webhooks/email-events` with the `x-webhook-secret` header.

## Known gaps
- Failed deliveries are recorded in `deliveries` but there is no re-queue job yet.
- Tests, CI/CD and infrastructure-as-code are not included.
