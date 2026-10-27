CREATE TABLE http_attempt (
  bucket INTEGER NOT NULL,
  identity TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  PRIMARY KEY (bucket, identity)
);
CREATE INDEX http_attempt_ip ON http_attempt(bucket, ip_hash);

CREATE TABLE http_rate (
  bucket INTEGER NOT NULL,
  key TEXT NOT NULL,
  n INTEGER NOT NULL CHECK (n > 0),
  PRIMARY KEY (bucket, key)
);
