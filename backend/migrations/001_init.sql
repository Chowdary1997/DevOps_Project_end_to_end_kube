-- 001: core schema. Forward-only: never edit an applied migration; add 002_*.sql instead.

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO settings (key, value) VALUES ('launched', 'false') ON CONFLICT (key) DO NOTHING;

CREATE TABLE subscribers (
  id                 BIGSERIAL PRIMARY KEY,
  email              TEXT NOT NULL UNIQUE
                     CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'active', 'unsubscribed', 'bounced')),
  notify_launch      BOOLEAN NOT NULL DEFAULT TRUE,
  notify_updates     BOOLEAN NOT NULL DEFAULT TRUE,
  confirm_token_hash TEXT UNIQUE CHECK (confirm_token_hash ~ '^[a-f0-9]{64}$'),
  confirm_expires_at TIMESTAMPTZ,
  unsubscribe_token  TEXT NOT NULL UNIQUE CHECK (unsubscribe_token ~ '^[a-f0-9]{64}$'),
  source             TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at       TIMESTAMPTZ,
  unsubscribed_at    TIMESTAMPTZ
);
CREATE INDEX subscribers_status_idx ON subscribers (status);
CREATE INDEX subscribers_launch_eligible_idx ON subscribers (id) WHERE status = 'active' AND notify_launch;
CREATE INDEX subscribers_update_eligible_idx ON subscribers (id) WHERE status = 'active' AND notify_updates;

CREATE TABLE consent_records (
  id             BIGSERIAL PRIMARY KEY,
  subscriber_id  BIGINT NOT NULL REFERENCES subscribers (id) ON DELETE CASCADE,
  action         TEXT NOT NULL CHECK (action IN ('subscribe', 'confirm', 'preferences_update', 'unsubscribe')),
  policy_version TEXT NOT NULL,
  ip_hash        TEXT,
  user_agent     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX consent_records_subscriber_idx ON consent_records (subscriber_id);

CREATE TABLE deliveries (
  id            BIGSERIAL PRIMARY KEY,
  subscriber_id BIGINT NOT NULL REFERENCES subscribers (id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('confirmation', 'launch', 'date_update')),
  campaign_key  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'failed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  provider_id   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at       TIMESTAMPTZ,
  UNIQUE (subscriber_id, kind, campaign_key)
);
CREATE INDEX deliveries_failed_idx ON deliveries (id) WHERE status = 'failed';
