INSERT INTO booking_command (
  organizer_id, request_key, booking_id, event_type_id, start_ms, end_ms, request_payload, google_event_id, seat_capacity
) SELECT
  :organizer_id, :request_key, :booking_id, :event_type_id, :start_ms, :end_ms, :request_payload, :google_event_id, :seat_capacity
WHERE :seat_attendee_id IS NULL
ON CONFLICT (organizer_id, request_key) DO UPDATE SET
  booking_id = excluded.booking_id,
  event_type_id = excluded.event_type_id,
  start_ms = excluded.start_ms,
  end_ms = excluded.end_ms,
  request_payload = excluded.request_payload,
  google_event_id = excluded.google_event_id,
  seat_capacity = excluded.seat_capacity;

INSERT INTO seat_request (organizer_id, request_key, booking_id, attendee_id, request_payload)
SELECT :organizer_id, :request_key, :booking_id, :seat_attendee_id, :request_payload
WHERE :seat_attendee_id IS NOT NULL
ON CONFLICT (organizer_id, request_key) DO UPDATE SET
  booking_id = excluded.booking_id,
  attendee_id = excluded.attendee_id,
  request_payload = excluded.request_payload;

SELECT outcome, booking_id, google_event_id FROM booking_command
WHERE organizer_id = :organizer_id AND request_key = :request_key AND :seat_attendee_id IS NULL
UNION ALL
SELECT s.outcome, s.booking_id, b.google_event_id FROM seat_request s JOIN booking_command b
ON s.organizer_id = b.organizer_id AND s.booking_id = b.booking_id
WHERE s.organizer_id = :organizer_id AND s.request_key = :request_key AND :seat_attendee_id IS NOT NULL;
