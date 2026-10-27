CREATE TABLE booking (
  id TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  state TEXT NOT NULL CHECK (state IN ('unconfirmed','active','cancelled')),
  token_hash TEXT NOT NULL,
  confirmed_json TEXT,
  etag TEXT,
  pending_id TEXT,
  initial_json TEXT NOT NULL
);

CREATE TABLE booking_command (
  id TEXT PRIMARY KEY NOT NULL,
  request_key TEXT NOT NULL UNIQUE,
  booking_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create','reschedule','cancel')),
  payload TEXT NOT NULL,
  expected_version INTEGER NOT NULL,
  accepted_version INTEGER,
  desired_json TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  occupied_start INTEGER NOT NULL,
  occupied_end INTEGER NOT NULL CHECK (occupied_start < occupied_end),
  precondition TEXT NOT NULL CHECK (precondition IN ('accepted','conflict','invalid_slot')),
  outcome TEXT NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending','accepted','conflict','stale','busy','invalid_state','settings_changed','invalid_slot')),
  execution TEXT NOT NULL DEFAULT 'queued' CHECK (execution IN ('queued','sent','done')),
  base_etag TEXT,
  nonce TEXT,
  dispatch_nonce TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  due INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  result_etag TEXT,
  terminal INTEGER NOT NULL DEFAULT 0 CHECK (terminal IN (0,1))
);
CREATE INDEX booking_command_due ON booking_command(outcome,execution,due);
CREATE UNIQUE INDEX booking_one_pending ON booking_command(booking_id)
  WHERE outcome = 'accepted' AND terminal = 0;

CREATE TABLE booking_reservation (
  booking_id TEXT NOT NULL REFERENCES booking(id),
  role TEXT NOT NULL CHECK (role IN ('current','candidate')),
  start INTEGER NOT NULL CHECK (typeof(start) = 'integer'),
  end INTEGER NOT NULL CHECK (typeof(end) = 'integer' AND start < end),
  PRIMARY KEY (booking_id,role)
);
CREATE INDEX booking_reservation_overlap ON booking_reservation(start,end);

CREATE TRIGGER booking_reservation_no_overlap BEFORE INSERT ON booking_reservation
WHEN EXISTS (SELECT 1 FROM booking_reservation r WHERE r.booking_id <> NEW.booking_id
  AND r.start < NEW.end AND NEW.start < r.end)
BEGIN SELECT RAISE(ABORT,'reservation_overlap'); END;
CREATE TRIGGER booking_reservation_immutable BEFORE UPDATE ON booking_reservation
BEGIN SELECT RAISE(ABORT,'replace_reservation_atomically'); END;

CREATE TRIGGER booking_command_identity BEFORE UPDATE ON booking_command
WHEN NEW.id IS NOT OLD.id OR NEW.request_key IS NOT OLD.request_key
  OR NEW.booking_id IS NOT OLD.booking_id OR NEW.action IS NOT OLD.action
  OR NEW.payload IS NOT OLD.payload OR NEW.expected_version IS NOT OLD.expected_version
  OR NEW.desired_json IS NOT OLD.desired_json OR NEW.settings_json IS NOT OLD.settings_json
  OR NEW.token_hash IS NOT OLD.token_hash OR NEW.occupied_start IS NOT OLD.occupied_start
  OR NEW.occupied_end IS NOT OLD.occupied_end OR NEW.precondition IS NOT OLD.precondition
  OR (OLD.base_etag IS NOT NULL AND NEW.base_etag IS NOT OLD.base_etag)
  OR (OLD.outcome <> 'pending' AND NEW.outcome IS NOT OLD.outcome)
  OR (OLD.terminal = 1 AND (NEW.terminal <> 1 OR NEW.result_etag IS NOT OLD.result_etag))
BEGIN SELECT RAISE(ABORT,'idempotency_mismatch'); END;

CREATE TRIGGER booking_admit AFTER INSERT ON booking_command
BEGIN
  UPDATE booking_command SET outcome = CASE
    WHEN NEW.action <> 'create' AND EXISTS(SELECT 1 FROM booking WHERE id=NEW.booking_id AND pending_id IS NOT NULL) THEN 'busy'
    WHEN NEW.action <> 'create' AND NOT EXISTS(SELECT 1 FROM booking WHERE id=NEW.booking_id AND version=NEW.expected_version) THEN 'stale'
    WHEN NEW.action <> 'create' AND NOT EXISTS(SELECT 1 FROM booking WHERE id=NEW.booking_id AND state='active') THEN 'invalid_state'
    WHEN EXISTS(SELECT 1 FROM organizer_settings WHERE id='owner' AND json <> NEW.settings_json) THEN 'settings_changed'
    WHEN NEW.precondition <> 'accepted' THEN NEW.precondition
    WHEN NEW.action <> 'cancel' AND EXISTS(SELECT 1 FROM booking_reservation r
      WHERE r.booking_id <> NEW.booking_id AND r.start < NEW.occupied_end AND NEW.occupied_start < r.end) THEN 'conflict'
    ELSE 'accepted' END WHERE id=NEW.id;

  INSERT INTO booking(id,version,state,token_hash,pending_id,initial_json)
  SELECT NEW.booking_id,1,'unconfirmed',NEW.token_hash,NEW.id,NEW.desired_json
  WHERE NEW.action='create' AND (SELECT outcome FROM booking_command WHERE id=NEW.id)='accepted';

  UPDATE booking SET version=version+1,pending_id=NEW.id
  WHERE id=NEW.booking_id AND NEW.action <> 'create'
    AND (SELECT outcome FROM booking_command WHERE id=NEW.id)='accepted'
    AND version=NEW.expected_version AND pending_id IS NULL;

  UPDATE booking_command SET accepted_version=(SELECT version FROM booking WHERE id=NEW.booking_id)
  WHERE id=NEW.id AND outcome='accepted';

  INSERT INTO booking_reservation(booking_id,role,start,end)
  SELECT NEW.booking_id,'candidate',NEW.occupied_start,NEW.occupied_end
  WHERE NEW.action <> 'cancel' AND (SELECT outcome FROM booking_command WHERE id=NEW.id)='accepted';
END;

CREATE TRIGGER booking_finish BEFORE UPDATE OF terminal ON booking_command
WHEN NEW.terminal=1 AND OLD.terminal=0
BEGIN
  SELECT CASE WHEN NEW.outcome <> 'accepted' OR NEW.execution <> 'done'
    OR (NEW.action <> 'cancel' AND NEW.result_etag IS NULL)
    OR NOT EXISTS(SELECT 1 FROM booking WHERE id=NEW.booking_id
      AND pending_id=NEW.id AND version=NEW.accepted_version)
    THEN RAISE(ABORT,'invalid_finalization') END;

  DELETE FROM booking_reservation WHERE booking_id=NEW.booking_id AND role='current';
  INSERT INTO booking_reservation(booking_id,role,start,end)
  SELECT booking_id,'current',start,end FROM booking_reservation
    WHERE booking_id=NEW.booking_id AND role='candidate' AND NEW.action <> 'cancel';
  DELETE FROM booking_reservation WHERE booking_id=NEW.booking_id AND role='candidate';
  UPDATE booking SET state=CASE WHEN NEW.action='cancel' THEN 'cancelled' ELSE 'active' END,
    confirmed_json=CASE WHEN NEW.action='cancel' THEN confirmed_json ELSE NEW.desired_json END,
    etag=NEW.result_etag,pending_id=NULL WHERE id=NEW.booking_id;
END;
