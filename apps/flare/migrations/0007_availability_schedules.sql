DROP TRIGGER booking_admit;

CREATE TABLE availability_schedule (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  json TEXT NOT NULL CHECK (json_valid(json) AND json_type(json) = 'object'),
  version INTEGER NOT NULL CHECK (version > 0)
);

INSERT INTO availability_schedule(id,name,json,version)
VALUES ('legacy','Working hours',
  (SELECT json -> '$.schedule' FROM organizer_settings WHERE id='owner'),
  (SELECT version FROM organizer_settings WHERE id='owner'));

CREATE TABLE organizer_preferences (
  id TEXT NOT NULL PRIMARY KEY CHECK (id = 'owner'),
  json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  default_schedule_id TEXT NOT NULL REFERENCES availability_schedule(id)
);
INSERT INTO organizer_preferences(rowid,id,json,version,default_schedule_id)
SELECT rowid,id,json_remove(json,'$.schedule'),version,'legacy' FROM organizer_settings;
DROP TABLE organizer_settings;
ALTER TABLE organizer_preferences RENAME TO organizer_settings;

ALTER TABLE event_type ADD COLUMN schedule_id TEXT REFERENCES availability_schedule(id);

CREATE TRIGGER availability_schedule_delete BEFORE DELETE ON availability_schedule
BEGIN
  SELECT CASE WHEN (SELECT count(*) FROM availability_schedule)=1
    THEN RAISE(ABORT,'final_schedule') END;
  UPDATE event_type SET schedule_id=NULL WHERE schedule_id=OLD.id;
  UPDATE organizer_settings SET default_schedule_id=(
    SELECT id FROM availability_schedule WHERE id<>OLD.id ORDER BY rowid LIMIT 1)
    WHERE default_schedule_id=OLD.id;
END;

CREATE TRIGGER availability_schedule_identity BEFORE UPDATE OF id ON availability_schedule
WHEN NEW.id IS NOT OLD.id
BEGIN SELECT RAISE(ABORT,'immutable_schedule'); END;

ALTER TABLE booking_command ADD COLUMN event_schedule_id TEXT;
ALTER TABLE booking_command ADD COLUMN resolved_schedule_id TEXT;

DROP TRIGGER booking_command_identity;
CREATE TRIGGER booking_command_identity BEFORE UPDATE ON booking_command
WHEN NEW.id IS NOT OLD.id OR NEW.request_key IS NOT OLD.request_key
  OR NEW.booking_id IS NOT OLD.booking_id OR NEW.event_id IS NOT OLD.event_id OR NEW.action IS NOT OLD.action
  OR NEW.event_schedule_id IS NOT OLD.event_schedule_id OR NEW.resolved_schedule_id IS NOT OLD.resolved_schedule_id
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
  SELECT CASE WHEN NEW.action <> 'create' AND EXISTS(
    SELECT 1 FROM booking WHERE id=NEW.booking_id AND event_id <> NEW.event_id)
    THEN RAISE(ABORT,'event_mismatch') END;
  UPDATE booking_command SET outcome = CASE
    WHEN NEW.action <> 'create' AND EXISTS(SELECT 1 FROM booking WHERE id=NEW.booking_id AND pending_id IS NOT NULL) THEN 'busy'
    WHEN NEW.action <> 'create' AND NOT EXISTS(SELECT 1 FROM booking WHERE id=NEW.booking_id AND version=NEW.expected_version) THEN 'stale'
    WHEN NEW.action <> 'create' AND NOT EXISTS(SELECT 1 FROM booking WHERE id=NEW.booking_id AND state='active') THEN 'invalid_state'
    WHEN NOT EXISTS(SELECT 1 FROM event_type e JOIN organizer_settings o ON o.id='owner'
      JOIN availability_schedule s ON s.id=COALESCE(e.schedule_id,o.default_schedule_id)
      WHERE e.id=NEW.event_id AND e.schedule_id IS NEW.event_schedule_id AND s.id=NEW.resolved_schedule_id
      AND e.json = (NEW.settings_json -> '$.event') AND s.json = (NEW.settings_json -> '$.schedule')
      AND o.json = json_remove(NEW.settings_json,'$.event','$.schedule')) THEN 'settings_changed'
    WHEN NEW.action <> 'cancel' AND EXISTS(SELECT 1 FROM event_type WHERE id=NEW.event_id AND lifecycle='removed') THEN 'invalid_slot'
    WHEN NEW.precondition <> 'accepted' THEN NEW.precondition
    WHEN NEW.action <> 'cancel' AND EXISTS(SELECT 1 FROM booking_reservation r
      WHERE r.booking_id <> NEW.booking_id AND r.start < NEW.occupied_end AND NEW.occupied_start < r.end) THEN 'conflict'
    ELSE 'accepted' END WHERE id=NEW.id;

  INSERT INTO booking(id,version,state,token_hash,pending_id,initial_json,event_id)
  SELECT NEW.booking_id,1,'unconfirmed',NEW.token_hash,NEW.id,NEW.desired_json,NEW.event_id
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
