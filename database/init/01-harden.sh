#!/bin/sh
# Runs once, on first container start with an empty data volume.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<EOSQL
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER DATABASE "$POSTGRES_DB" SET timezone TO 'UTC';
ALTER DATABASE "$POSTGRES_DB" SET statement_timeout TO '15s';
EOSQL
