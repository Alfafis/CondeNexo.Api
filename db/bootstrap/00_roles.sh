#!/bin/sh
# Bootstrap do cluster (roda UMA vez, como superusuário, ANTES das migrações).
# No Docker, este arquivo fica em /docker-entrypoint-initdb.d e roda na primeira subida do volume.
# Fora do Docker: POSTGRES_USER=postgres APP_MIGRATOR_PASSWORD=... APP_RW_PASSWORD=... sh db/bootstrap/00_roles.sh
#
# - app_migrator: dono do banco e do schema; só ele roda migrações (drizzle-kit migrate).
# - app_rw: role da API. Sem DELETE, sem UPDATE nas trilhas, sem CREATE (GRANTs na migração 0001).
# Senhas vêm do ambiente: nunca ficam em migração nem no repositório.
set -eu
: "${APP_MIGRATOR_PASSWORD:?defina APP_MIGRATOR_PASSWORD}"
: "${APP_RW_PASSWORD:?defina APP_RW_PASSWORD}"
DB="${PORTARIA_DB:-portaria}"

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname postgres \
  -v migrator_pw="$APP_MIGRATOR_PASSWORD" -v rw_pw="$APP_RW_PASSWORD" -v db="$DB" <<'SQL'
SELECT 'CREATE ROLE app_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrator') \gexec
SELECT 'CREATE ROLE app_rw LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') \gexec
ALTER ROLE app_migrator PASSWORD :'migrator_pw';
ALTER ROLE app_rw PASSWORD :'rw_pw';
SELECT format('CREATE DATABASE %I OWNER app_migrator', :'db')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO app_migrator, app_rw;
SQL
