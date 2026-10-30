ALTER TABLE event_type ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'listed'
  CHECK (lifecycle IN ('listed','hidden','removed'));

CREATE TRIGGER event_type_tombstone BEFORE UPDATE ON event_type
WHEN OLD.lifecycle='removed' AND (NEW.lifecycle <> 'removed' OR NEW.id IS NOT OLD.id
  OR NEW.json IS NOT OLD.json OR NEW.version IS NOT OLD.version)
BEGIN SELECT RAISE(ABORT,'event_removed'); END;

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
