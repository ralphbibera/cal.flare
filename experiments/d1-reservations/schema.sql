CREATE TABLE booking_command (
  organizer_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  booking_id TEXT NOT NULL,
  event_type_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL CHECK (typeof(start_ms) = 'integer'),
  end_ms INTEGER NOT NULL CHECK (typeof(end_ms) = 'integer' AND start_ms < end_ms),
  request_payload TEXT NOT NULL,
  google_event_id TEXT NOT NULL,
  seat_capacity INTEGER CHECK (seat_capacity IS NULL OR (typeof(seat_capacity) = 'integer' AND seat_capacity > 0)),
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
  OR NEW.seat_capacity IS NOT OLD.seat_capacity
BEGIN
  SELECT RAISE(ABORT, 'idempotency_mismatch');
END;

CREATE TABLE seat_request (
  organizer_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  booking_id TEXT NOT NULL,
  attendee_id TEXT NOT NULL,
  request_payload TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'accepted', 'conflict')),
  PRIMARY KEY (organizer_id, request_key),
  UNIQUE (organizer_id, request_key, booking_id, attendee_id),
  FOREIGN KEY (organizer_id, booking_id) REFERENCES booking_command (organizer_id, booking_id)
);

CREATE TABLE seat_claim (
  organizer_id TEXT NOT NULL,
  booking_id TEXT NOT NULL,
  attendee_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  PRIMARY KEY (organizer_id, booking_id, attendee_id),
  FOREIGN KEY (organizer_id, request_key, booking_id, attendee_id)
    REFERENCES seat_request (organizer_id, request_key, booking_id, attendee_id)
);

CREATE TRIGGER create_key_namespace BEFORE INSERT ON booking_command
WHEN EXISTS (SELECT 1 FROM seat_request WHERE organizer_id = NEW.organizer_id AND request_key = NEW.request_key)
BEGIN
  SELECT RAISE(ABORT, 'idempotency_mismatch');
END;

CREATE TRIGGER seat_key_namespace BEFORE INSERT ON seat_request
WHEN EXISTS (SELECT 1 FROM booking_command WHERE organizer_id = NEW.organizer_id AND request_key = NEW.request_key)
BEGIN
  SELECT RAISE(ABORT, 'idempotency_mismatch');
END;

CREATE TRIGGER seat_identity_immutable BEFORE UPDATE ON seat_request
WHEN NEW.organizer_id IS NOT OLD.organizer_id OR NEW.request_key IS NOT OLD.request_key
  OR NEW.booking_id IS NOT OLD.booking_id OR NEW.attendee_id IS NOT OLD.attendee_id
  OR NEW.request_payload IS NOT OLD.request_payload
BEGIN
  SELECT RAISE(ABORT, 'idempotency_mismatch');
END;

CREATE TRIGGER seat_capacity_guard BEFORE INSERT ON seat_claim
WHEN NOT EXISTS (
  SELECT 1 FROM booking_command b JOIN reservation r
    ON r.organizer_id = b.organizer_id AND r.booking_id = b.booking_id AND r.role = 'current'
  WHERE b.organizer_id = NEW.organizer_id AND b.booking_id = NEW.booking_id AND b.outcome = 'accepted'
    AND (SELECT count(*) FROM seat_claim s WHERE s.organizer_id = b.organizer_id
         AND s.booking_id = b.booking_id) < b.seat_capacity
)
BEGIN
  SELECT RAISE(ABORT, 'seat_capacity');
END;

CREATE TRIGGER seat_claim_immutable BEFORE UPDATE ON seat_claim
BEGIN
  SELECT RAISE(ABORT, 'replace_seat_atomically');
END;

CREATE TRIGGER admit_seat AFTER INSERT ON seat_request
BEGIN
  INSERT INTO seat_claim (organizer_id, booking_id, attendee_id, request_key)
  SELECT NEW.organizer_id, NEW.booking_id, NEW.attendee_id, NEW.request_key
  FROM booking_command b JOIN reservation r
    ON r.organizer_id = b.organizer_id AND r.booking_id = b.booking_id AND r.role = 'current'
  WHERE b.organizer_id = NEW.organizer_id AND b.booking_id = NEW.booking_id AND b.outcome = 'accepted'
    AND (SELECT count(*) FROM seat_claim s WHERE s.organizer_id = b.organizer_id
         AND s.booking_id = b.booking_id) < b.seat_capacity
    AND NOT EXISTS (SELECT 1 FROM seat_claim s WHERE s.organizer_id = NEW.organizer_id
      AND s.booking_id = NEW.booking_id AND s.attendee_id = NEW.attendee_id);

  UPDATE seat_request SET outcome = CASE WHEN EXISTS (
    SELECT 1 FROM seat_claim WHERE organizer_id = NEW.organizer_id AND request_key = NEW.request_key
  ) THEN 'accepted' ELSE 'conflict' END
  WHERE organizer_id = NEW.organizer_id AND request_key = NEW.request_key;
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
