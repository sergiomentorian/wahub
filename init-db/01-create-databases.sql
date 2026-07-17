-- init-db/01-create-databases.sql
-- Cria os DBs do hub de forma IDEMPOTENTE.
--
-- [AUDIT] docker-entrypoint-initdb.d só roda no PRIMEIRO boot (volume pg_data vazio).
-- Em re-deploy com volume existente estes comandos NÃO rodam de novo — se precisar criar
-- os DBs num Postgres já inicializado, rode este arquivo manualmente:
--   docker compose exec -T postgres psql -U postgres -f - < init-db/01-create-databases.sql
--
-- Cada API cria suas próprias tabelas no boot (Evolution = migrations Prisma; whatsmeow =
-- sqlstore). Aqui só garantimos que os BANCOS existam.

SELECT 'CREATE DATABASE evolution_db' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'evolution_db')\gexec
SELECT 'CREATE DATABASE evogo_auth'   WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'evogo_auth')\gexec
SELECT 'CREATE DATABASE evogo_users'  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'evogo_users')\gexec
SELECT 'CREATE DATABASE wuzapi'       WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'wuzapi')\gexec
SELECT 'CREATE DATABASE waha'         WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'waha')\gexec
