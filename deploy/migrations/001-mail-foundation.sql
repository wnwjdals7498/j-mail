-- Foundation only. E8 notification_outbox is deliberately not defined yet.
-- Original messages belong to the Mailpit volume, never to this database.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM PUBLIC;
