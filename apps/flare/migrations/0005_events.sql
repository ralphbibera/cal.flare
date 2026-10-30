CREATE TABLE event_type (
  id TEXT NOT NULL PRIMARY KEY,
  json TEXT NOT NULL CHECK (json_valid(json) AND json_type(json) = 'object'),
  version INTEGER NOT NULL CHECK (version > 0)
);
CREATE UNIQUE INDEX event_type_slug ON event_type(json_extract(json, '$.slug'));

INSERT INTO organizer_settings(id,json,version)
SELECT 'owner','{"event":{"slug":"intro","title":"Intro call","description":"","durationMinutes":30,"intervalMinutes":30,"beforeMinutes":0,"afterMinutes":0,"noticeMinutes":120},"schedule":{"timeZone":"UTC","rules":[{"weekday":1,"startMinute":540,"endMinute":1020},{"weekday":2,"startMinute":540,"endMinute":1020},{"weekday":3,"startMinute":540,"endMinute":1020},{"weekday":4,"startMinute":540,"endMinute":1020},{"weekday":5,"startMinute":540,"endMinute":1020}]} }',1
WHERE NOT EXISTS(SELECT 1 FROM organizer_settings WHERE id='owner');
INSERT INTO event_type(id,json,version)
SELECT 'default',json -> '$.event',version FROM organizer_settings WHERE id='owner';
UPDATE organizer_settings SET json=json_remove(json,'$.event') WHERE id='owner';

ALTER TABLE booking ADD COLUMN event_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE booking_command ADD COLUMN event_id TEXT NOT NULL DEFAULT 'default';

CREATE TRIGGER booking_event_identity BEFORE UPDATE OF event_id ON booking
WHEN NEW.event_id IS NOT OLD.event_id
BEGIN SELECT RAISE(ABORT,'immutable_event'); END;

DROP TRIGGER booking_command_identity;
CREATE TRIGGER booking_command_identity BEFORE UPDATE ON booking_command
WHEN NEW.id IS NOT OLD.id OR NEW.request_key IS NOT OLD.request_key
  OR NEW.booking_id IS NOT OLD.booking_id OR NEW.event_id IS NOT OLD.event_id OR NEW.action IS NOT OLD.action
  OR NEW.payload IS NOT OLD.payload OR NEW.expected_version IS NOT OLD.expected_version
  OR NEW.desired_json IS NOT OLD.desired_json OR NEW.settings_json IS NOT OLD.settings_json
  OR NEW.token_hash IS NOT OLD.token_hash OR NEW.occupied_start IS NOT OLD.occupied_start
  OR NEW.occupied_end IS NOT OLD.occupied_end OR NEW.precondition IS NOT OLD.precondition
  OR (OLD.base_etag IS NOT NULL AND NEW.base_etag IS NOT OLD.base_etag)
  OR (OLD.outcome <> 'pending' AND NEW.outcome IS NOT OLD.outcome)
  OR (OLD.terminal = 1 AND (NEW.terminal <> 1 OR NEW.result_etag IS NOT OLD.result_etag))
BEGIN SELECT RAISE(ABORT,'idempotency_mismatch'); END;

DROP TRIGGER booking_admit;
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
      WHERE e.id=NEW.event_id AND e.json = (NEW.settings_json -> '$.event')
      AND o.json = json_remove(NEW.settings_json,'$.event')) THEN 'settings_changed'
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
