#!/bin/sh
set -eu
psql --username "$POSTGRES_USER" --dbname postgres --set ON_ERROR_STOP=1 <<'SQL'
\getenv db_password JML_DB_PASSWORD
CREATE ROLE jgw_mail LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 30;
SELECT format('ALTER ROLE jgw_mail PASSWORD %L', :'db_password') \gexec
ALTER ROLE jgw_mail SET statement_timeout = '5s';
ALTER ROLE jgw_mail SET timezone = 'UTC';
CREATE DATABASE jgw_mail OWNER jgw_mail;
CREATE ROLE jgw_other LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
SELECT format('ALTER ROLE jgw_other PASSWORD %L', :'db_password') \gexec
CREATE DATABASE jgw_other OWNER jgw_other;
REVOKE CONNECT, TEMPORARY ON DATABASE postgres, template1, jgw_mail, jgw_other FROM PUBLIC;
GRANT CONNECT ON DATABASE jgw_mail TO jgw_mail;
GRANT CONNECT ON DATABASE jgw_other TO jgw_other;
SQL
