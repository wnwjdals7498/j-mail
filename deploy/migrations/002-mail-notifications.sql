CREATE TABLE smtp_envelope_captures (
  capture_id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  usernames jsonb NOT NULL CHECK (jsonb_typeof(usernames)='array' AND jsonb_array_length(usernames) BETWEEN 1 AND 100),
  message_id text UNIQUE CHECK (message_id IS NULL OR message_id ~ '^[A-Za-z0-9]{22}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  linked_at timestamptz,
  UNIQUE (tenant_id,capture_id)
);
CREATE TABLE notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  mailpit_message_id text NOT NULL CHECK (mailpit_message_id ~ '^[A-Za-z0-9]{22}$'),
  capture_id uuid NOT NULL,
  usernames jsonb NOT NULL CHECK (jsonb_typeof(usernames)='array' AND jsonb_array_length(usernames) BETWEEN 1 AND 100),
  event_type text NOT NULL CHECK (event_type='mail.new'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  locked_until timestamptz,
  lease_token uuid,
  delivered_at timestamptz,
  last_error text CHECK (last_error IS NULL OR last_error='delivery_failed'),
  UNIQUE (tenant_id,mailpit_message_id),
  FOREIGN KEY (tenant_id,capture_id) REFERENCES smtp_envelope_captures(tenant_id,capture_id),
  CHECK ((locked_until IS NULL)=(lease_token IS NULL))
);
CREATE INDEX mail_notification_pending ON notification_outbox(tenant_id,available_at,created_at,id) WHERE delivered_at IS NULL;
REVOKE ALL ON smtp_envelope_captures,notification_outbox FROM PUBLIC;
