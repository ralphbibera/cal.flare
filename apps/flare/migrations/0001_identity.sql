CREATE TABLE owner (
  id TEXT PRIMARY KEY NOT NULL CHECK (id = 'owner'),
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT NOT NULL
);
CREATE TABLE google_connection (
  owner_id TEXT PRIMARY KEY NOT NULL REFERENCES owner(id),
  ciphertext TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE owner_session (
  token_hash TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES owner(id),
  expires_at INTEGER NOT NULL
);
CREATE INDEX owner_session_expiry ON owner_session(expires_at);
CREATE TABLE oauth_attempt (
  state_hash TEXT PRIMARY KEY NOT NULL,
  binding_hash TEXT NOT NULL,
  verifier_ciphertext TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_attempt_expiry ON oauth_attempt(expires_at);
