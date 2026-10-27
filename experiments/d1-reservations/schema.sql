CREATE TABLE booking_command (
  organizer_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  booking_id TEXT NOT NULL,
  event_type_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL CHECK (typeof(start_ms) = 'integer'),
  end_ms INTEGER NOT NULL CHECK (typeof(end_ms) = 'integer' AND start_ms < end_ms),
  request_payload TEXT NOT NULL,
  google_event_id TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'accepted', 'conflict')),
  PRIMARY KEY (organizer_id, request_key),
  UNIQUE (organizer_id, booking_id),
  UNIQUE (organizer_id, google_event_id)
);

CREATE TABLE reservation (
  organizer_id TEXT NOT NULL,
  booking_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('current', 'candidate')),
  start_ms INTEGER NOT NULL CHECK (typeof(start_ms) = 'integer'),
  end_ms INTEGER NOT NULL CHECK (typeof(end_ms) = 'integer' AND start_ms < end_ms),
  PRIMARY KEY (organizer_id, booking_id, role),
  FOREIGN KEY (organizer_id, booking_id) REFERENCES booking_command (organizer_id, booking_id)
);

CREATE INDEX reservation_overlap ON reservation (organizer_id, start_ms, end_ms);

CREATE TABLE calendar_operation (
  organizer_id TEXT NOT NULL,
  booking_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action = 'create'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state = 'pending'),
  PRIMARY KEY (organizer_id, booking_id),
  FOREIGN KEY (organizer_id, booking_id) REFERENCES booking_command (organizer_id, booking_id)
);

CREATE TRIGGER command_identity_immutable
BEFORE UPDATE ON booking_command
WHEN NEW.organizer_id IS NOT OLD.organizer_id OR NEW.request_key IS NOT OLD.request_key
  OR NEW.booking_id IS NOT OLD.booking_id OR NEW.event_type_id IS NOT OLD.event_type_id
  OR NEW.start_ms IS NOT OLD.start_ms OR NEW.end_ms IS NOT OLD.end_ms
  OR NEW.request_payload IS NOT OLD.request_payload OR NEW.google_event_id IS NOT OLD.google_event_id
BEGIN
  SELECT RAISE(ABORT, 'idempotency_mismatch');
END;

CREATE TRIGGER reservation_no_overlap
BEFORE INSERT ON reservation
WHEN EXISTS (
  SELECT 1 FROM reservation
  WHERE organizer_id = NEW.organizer_id AND booking_id <> NEW.booking_id
    AND start_ms < NEW.end_ms AND NEW.start_ms < end_ms
)
BEGIN
  SELECT RAISE(ABORT, 'reservation_overlap');
END;

CREATE TRIGGER reservation_immutable BEFORE UPDATE ON reservation
BEGIN
  SELECT RAISE(ABORT, 'replace_reservation_atomically');
END;

CREATE TRIGGER reserve_and_record_intent AFTER INSERT ON booking_command
BEGIN
  INSERT INTO reservation (organizer_id, booking_id, role, start_ms, end_ms)
  SELECT NEW.organizer_id, NEW.booking_id, 'current', NEW.start_ms, NEW.end_ms
  WHERE NOT EXISTS (
    SELECT 1 FROM reservation
    WHERE organizer_id = NEW.organizer_id AND booking_id <> NEW.booking_id
      AND start_ms < NEW.end_ms AND NEW.start_ms < end_ms
  );

  UPDATE booking_command SET outcome = CASE WHEN EXISTS (
    SELECT 1 FROM reservation WHERE organizer_id = NEW.organizer_id AND booking_id = NEW.booking_id
  ) THEN 'accepted' ELSE 'conflict' END
  WHERE organizer_id = NEW.organizer_id AND request_key = NEW.request_key;

  INSERT INTO calendar_operation (organizer_id, booking_id, action)
  SELECT NEW.organizer_id, NEW.booking_id, 'create'
  WHERE EXISTS (
    SELECT 1 FROM booking_command
    WHERE organizer_id = NEW.organizer_id AND request_key = NEW.request_key AND outcome = 'accepted'
  );
END;
