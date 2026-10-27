import argparse
import hashlib
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SCHEMA = ROOT / "schema.sql"
STATEMENTS = [sql.strip() for sql in (ROOT / "submit.sql").read_text().split(";") if sql.strip()]


def command(organizer, key, start=100, end=200, event_type="intro"):
    identity = hashlib.sha256(json.dumps([organizer, key]).encode()).hexdigest()
    payload = {"kind": "create", "eventType": event_type, "start": start, "end": end}
    return {
        "organizer_id": organizer,
        "request_key": key,
        "booking_id": identity,
        "event_type_id": event_type,
        "start_ms": start,
        "end_ms": end,
        "request_payload": json.dumps(payload, sort_keys=True, separators=(",", ":")),
        "google_event_id": identity,
    }


def submit(db, parameters):
    db.execute("BEGIN")
    try:
        results = [db.execute(sql, parameters).fetchall() for sql in STATEMENTS]
        db.execute("COMMIT")
        return results[-1][0]
    except BaseException:
        db.execute("ROLLBACK")
        raise


class ReservationExperiment(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="calflare-reservations-")
        self.path = Path(self.directory.name) / "reservations.sqlite"
        self.db = self.open()
        self.db.executescript(SCHEMA.read_text())

    def tearDown(self):
        self.db.close()
        self.directory.cleanup()

    def open(self):
        db = sqlite3.connect(self.path, isolation_level=None, timeout=5)
        db.execute("PRAGMA foreign_keys = ON")
        return db

    def counts(self):
        return tuple(self.db.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
                     for table in ("booking_command", "reservation", "calendar_operation"))

    def assert_no_overlaps(self):
        overlaps = self.db.execute("""
            SELECT count(*) FROM reservation a JOIN reservation b
            ON a.organizer_id = b.organizer_id AND a.booking_id < b.booking_id
            WHERE a.start_ms < b.end_ms AND b.start_ms < a.end_ms
        """).fetchone()[0]
        self.assertEqual(overlaps, 0)

    def test_overlap_matrix_and_allowed_bookings(self):
        for index, (start, end) in enumerate(((100, 200), (50, 150), (150, 250), (120, 180), (50, 250))):
            organizer = f"matrix-{index}"
            self.assertEqual(submit(self.db, command(organizer, "first"))[0], "accepted")
            self.assertEqual(submit(self.db, command(organizer, "second", start, end, "different-type"))[0],
                             "conflict")
            self.assertEqual(submit(self.db, command(organizer, "before", 0, 100))[0], "accepted")
            self.assertEqual(submit(self.db, command(organizer, "after", 200, 300))[0], "accepted")
        self.assertEqual(submit(self.db, command("other-organizer", "first"))[0], "accepted")
        self.assertEqual(self.counts(), (21, 16, 16))
        self.assert_no_overlaps()

    def test_replay_changed_payload_and_persisted_conflict(self):
        original = command("owner", "request")
        accepted = submit(self.db, original)
        self.assertEqual(accepted[0], "accepted")
        blocked = command("owner", "blocked")
        rejected = submit(self.db, blocked)
        self.assertEqual(rejected[0], "conflict")
        snapshot = self.db.execute("SELECT * FROM booking_command ORDER BY request_key").fetchall()
        with closing(self.open()) as reopened:
            self.assertEqual(submit(reopened, original), accepted)
            self.assertEqual(submit(reopened, blocked), rejected)
            for field in ("booking_id", "event_type_id", "start_ms", "end_ms", "request_payload", "google_event_id"):
                changed = dict(original)
                value = changed[field]
                changed[field] = value + 1 if isinstance(value, int) else value + "changed"
                with self.subTest(field=field):
                    with self.assertRaisesRegex(sqlite3.IntegrityError, "idempotency_mismatch"):
                        submit(reopened, changed)
                    self.assertEqual(reopened.execute("SELECT * FROM booking_command ORDER BY request_key").fetchall(),
                                     snapshot)
        self.assertEqual(self.counts(), (2, 1, 1))
        self.db.execute("DELETE FROM reservation WHERE organizer_id = 'owner'")
        self.assertEqual(submit(self.db, blocked), rejected)
        self.assertEqual(self.counts(), (2, 0, 1))
        self.assertEqual(submit(self.db, command("another-owner", "request"))[0], "accepted")

    def test_invalid_interval_and_failure_after_reservation_leave_no_partial_intent(self):
        for start, end in ((100, 100), (200, 100), (100.5, 200)):
            with self.assertRaises(sqlite3.IntegrityError):
                submit(self.db, command("owner", "invalid", start, end))
            self.assertEqual(self.counts(), (0, 0, 0))
        self.db.executescript("""
            CREATE TRIGGER injected_failure BEFORE INSERT ON calendar_operation
            BEGIN SELECT RAISE(ABORT, 'injected_after_reservation'); END;
        """)
        with self.assertRaisesRegex(sqlite3.IntegrityError, "injected_after_reservation"):
            submit(self.db, command("owner", "failure"))
        self.assertEqual(self.counts(), (0, 0, 0))
        with closing(self.open()) as reopened:
            self.assertEqual(reopened.execute("SELECT count(*) FROM booking_command").fetchone()[0], 0)

    def test_direct_claim_writes_cannot_bypass_overlap_or_change_interval(self):
        first = command("owner", "first")
        second = command("owner", "second", 300, 400)
        submit(self.db, first)
        submit(self.db, second)
        with self.assertRaisesRegex(sqlite3.IntegrityError, "reservation_overlap"):
            self.db.execute("INSERT INTO reservation VALUES (?, ?, 'candidate', 150, 250)",
                            ("owner", second["booking_id"]))
        with self.assertRaisesRegex(sqlite3.IntegrityError, "replace_reservation_atomically"):
            self.db.execute("UPDATE reservation SET start_ms = 150 WHERE booking_id = ?",
                            (second["booking_id"],))
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("INSERT INTO reservation VALUES (?, ?, 'current', 500, 600)",
                            ("wrong-organizer", first["booking_id"]))
        self.assertEqual(self.counts(), (2, 2, 2))
        self.assert_no_overlaps()

    def test_current_and_candidate_hold_separate_ranges_after_reopen(self):
        first = command("owner", "first")
        submit(self.db, first)
        self.db.execute("INSERT INTO reservation VALUES (?, ?, 'candidate', 300, 400)",
                        ("owner", first["booking_id"]))
        with closing(self.open()) as reopened:
            self.assertEqual(submit(reopened, command("owner", "old", 120, 180))[0], "conflict")
            self.assertEqual(submit(reopened, command("owner", "new", 320, 380))[0], "conflict")
            self.assertEqual(submit(reopened, command("owner", "gap", 200, 300))[0], "accepted")
        self.assertEqual(self.counts(), (4, 3, 2))
        self.assert_no_overlaps()

    def test_independent_writers_persist_one_winner_and_one_conflict(self):
        for round_number in range(50):
            organizer = f"race-{round_number}"
            barrier = threading.Barrier(2, timeout=5)

            def contender(parameters):
                with closing(self.open()) as db:
                    barrier.wait()
                    return submit(db, parameters)

            inputs = [command(organizer, "left", 100, 200),
                      command(organizer, "right", 150, 250, "different-type")]
            if round_number % 2:
                inputs.reverse()
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(contender, parameters) for parameters in inputs]
                results = [future.result(timeout=10) for future in futures]
            self.assertEqual(sorted(result[0] for result in results), ["accepted", "conflict"])
            self.assertEqual(self.db.execute("SELECT count(*) FROM calendar_operation WHERE organizer_id = ?",
                                             (organizer,)).fetchone()[0], 1)
            self.assert_no_overlaps()
        self.assertEqual(self.counts(), (100, 50, 50))

    def test_simultaneous_replays_share_one_durable_intent(self):
        barrier = threading.Barrier(2, timeout=5)
        parameters = command("owner", "same-request")

        def contender():
            with closing(self.open()) as db:
                barrier.wait()
                return submit(db, parameters)

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(contender) for _ in range(2)]
            results = [future.result(timeout=10) for future in futures]
        self.assertEqual(results[0], results[1])
        self.assertEqual(results[0][0], "accepted")
        self.assertEqual(self.counts(), (1, 1, 1))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--schema", type=Path, default=SCHEMA)
    arguments, remaining = parser.parse_known_args()
    SCHEMA = arguments.schema
    print(f"Local SQLite {sqlite3.sqlite_version}; 50 independent-writer races; no D1 or Google calls", flush=True)
    unittest.main(argv=[sys.argv[0], *remaining], verbosity=2)
