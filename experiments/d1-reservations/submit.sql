INSERT INTO booking_command (
  organizer_id, request_key, booking_id, event_type_id, start_ms, end_ms, request_payload, google_event_id
) VALUES (
  :organizer_id, :request_key, :booking_id, :event_type_id, :start_ms, :end_ms, :request_payload, :google_event_id
)
ON CONFLICT (organizer_id, request_key) DO UPDATE SET
  booking_id = excluded.booking_id,
  event_type_id = excluded.event_type_id,
  start_ms = excluded.start_ms,
  end_ms = excluded.end_ms,
  request_payload = excluded.request_payload,
  google_event_id = excluded.google_event_id;

SELECT outcome, booking_id, google_event_id FROM booking_command
WHERE organizer_id = :organizer_id AND request_key = :request_key;
