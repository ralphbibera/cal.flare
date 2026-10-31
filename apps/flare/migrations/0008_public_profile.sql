CREATE TABLE organizer_profile (
  owner_id TEXT PRIMARY KEY NOT NULL REFERENCES owner(id),
  display_name TEXT,
  bio TEXT NOT NULL
);
