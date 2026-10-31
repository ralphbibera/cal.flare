ALTER TABLE organizer_settings ADD COLUMN destination_calendar_id TEXT NOT NULL DEFAULT 'primary'
  CHECK(length(destination_calendar_id) BETWEEN 1 AND 1024);
ALTER TABLE event_type ADD COLUMN destination_calendar_id TEXT
  CHECK(destination_calendar_id IS NULL OR length(destination_calendar_id) BETWEEN 1 AND 1024);
ALTER TABLE booking ADD COLUMN calendar_id TEXT NOT NULL DEFAULT 'primary'
  CHECK(length(calendar_id) BETWEEN 1 AND 1024);
ALTER TABLE booking_command ADD COLUMN calendar_id TEXT NOT NULL DEFAULT 'primary'
  CHECK(length(calendar_id) BETWEEN 1 AND 1024);
ALTER TABLE booking_command ADD COLUMN owner_calendar_id TEXT NOT NULL DEFAULT 'primary';
ALTER TABLE booking_command ADD COLUMN event_calendar_id TEXT;

CREATE TRIGGER booking_calendar_identity BEFORE UPDATE OF calendar_id ON booking
WHEN NEW.calendar_id IS NOT OLD.calendar_id
BEGIN SELECT RAISE(ABORT,'immutable_calendar'); END;

CREATE TRIGGER booking_command_calendar_identity BEFORE UPDATE ON booking_command
WHEN NEW.calendar_id IS NOT OLD.calendar_id OR NEW.owner_calendar_id IS NOT OLD.owner_calendar_id
  OR NEW.event_calendar_id IS NOT OLD.event_calendar_id
BEGIN SELECT RAISE(ABORT,'idempotency_mismatch'); END;

DROP TRIGGER booking_admit;
CREATE TRIGGER booking_admit AFTER INSERT ON booking_command
BEGIN
  SELECT CASE WHEN NEW.action <> 'create' AND EXISTS(
    SELECT 1 FROM booking WHERE id=NEW.booking_id AND event_id <> NEW.event_id)
    THEN RAISE(ABORT,'event_mismatch') END;
  SELECT CASE WHEN NEW.action <> 'create' AND EXISTS(
    SELECT 1 FROM booking WHERE id=NEW.booking_id AND calendar_id <> NEW.calendar_id)
    THEN RAISE(ABORT,'calendar_mismatch') END;
  UPDATE booking_command SET outcome = CASE
    WHEN NEW.action <> 'create' AND EXISTS(SELECT 1 FROM booking WHERE id=NEW.booking_id AND pending_id IS NOT NULL) THEN 'busy'
    WHEN NEW.action <> 'create' AND NOT EXISTS(SELECT 1 FROM booking WHERE id=NEW.booking_id AND version=NEW.expected_version) THEN 'stale'
    WHEN NEW.action <> 'create' AND NOT EXISTS(SELECT 1 FROM booking WHERE id=NEW.booking_id AND state='active') THEN 'invalid_state'
    WHEN NOT EXISTS(SELECT 1 FROM event_type e JOIN organizer_settings o ON o.id='owner'
      JOIN availability_schedule s ON s.id=COALESCE(e.schedule_id,o.default_schedule_id)
      WHERE e.id=NEW.event_id AND e.schedule_id IS NEW.event_schedule_id AND s.id=NEW.resolved_schedule_id
      AND e.json = (NEW.settings_json -> '$.event') AND s.json = (NEW.settings_json -> '$.schedule')
      AND o.json = json_remove(NEW.settings_json,'$.event','$.schedule')) THEN 'settings_changed'
    WHEN NEW.action='create' AND NOT EXISTS(SELECT 1 FROM event_type e JOIN organizer_settings o ON o.id='owner'
      WHERE e.id=NEW.event_id AND o.destination_calendar_id IS NEW.owner_calendar_id
      AND e.destination_calendar_id IS NEW.event_calendar_id
      AND COALESCE(e.destination_calendar_id,o.destination_calendar_id)=NEW.calendar_id) THEN 'settings_changed'
    WHEN NEW.action <> 'cancel' AND EXISTS(SELECT 1 FROM event_type WHERE id=NEW.event_id AND lifecycle='removed') THEN 'invalid_slot'
    WHEN NEW.precondition <> 'accepted' THEN NEW.precondition
    WHEN NEW.action <> 'cancel' AND EXISTS(SELECT 1 FROM booking_reservation r
      WHERE r.booking_id <> NEW.booking_id AND r.start < NEW.occupied_end AND NEW.occupied_start < r.end) THEN 'conflict'
    ELSE 'accepted' END WHERE id=NEW.id;

  INSERT INTO booking(id,version,state,token_hash,pending_id,initial_json,event_id,calendar_id)
  SELECT NEW.booking_id,1,'unconfirmed',NEW.token_hash,NEW.id,NEW.desired_json,NEW.event_id,NEW.calendar_id
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
