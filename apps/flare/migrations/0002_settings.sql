CREATE TABLE organizer_settings (
  id TEXT NOT NULL PRIMARY KEY CHECK (id = 'owner'),
  json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0)
);
