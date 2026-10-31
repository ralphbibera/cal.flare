"""Run the booking-specific SQL witness, source drift gate, and pinned TLC."""
import hashlib
import re
import sqlite3
import subprocess
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
MIGRATIONS = ROOT / "apps/flare/migrations"
SERVER = ROOT / "apps/flare/src/server"
JAR_SHA = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
COVERED = [
    "apps/flare/migrations",
    "apps/flare/src/server/bookings.ts",
    "apps/flare/src/server/booking-delivery.ts",
    "apps/flare/src/server/booking-availability.ts",
    "apps/flare/src/server/booking-model.ts",
    "apps/flare/src/server/settings.ts",
    "apps/flare/src/domain/settings.ts",
    "apps/flare/src/domain/scheduling.ts",
]


def sql_from(file, prefix):
    source = (SERVER / file).read_text()
    statements = re.findall(r"\.prepare\(`([^`]+)`\)", source)
    return next(sql for sql in statements if sql.startswith(prefix))


def sql_witness():
    # Same migrations and neutral settings as scripts/booking-storage.test.ts.
    admit = sql_from("bookings.ts", "INSERT INTO booking_command")
    finish = sql_from("booking-delivery.ts", "UPDATE booking_command SET terminal=1")
    with tempfile.TemporaryDirectory(prefix="flare-formal-sql-") as directory:
        path = Path(directory) / "booking.sqlite"
        db = sqlite3.connect(path)
        for name in ("0002_settings.sql", "0003_bookings.sql", "0005_events.sql",
                     "0006_event_lifecycle.sql", "0007_availability_schedules.sql"):
            db.executescript((MIGRATIONS / name).read_text())
        for table in ("organizer_settings", "event_type", "availability_schedule"):
            db.execute(f"UPDATE {table} SET json='{{}}'")
        db.execute("INSERT INTO event_type(id,json,version) VALUES('second','{}',1)")
        db.commit()

        def submit(key, booking, start, end, action="create", version=0, event="default"):
            with db:
                db.execute(admit, (key, key, booking, action, key, version, "{}",
                                   '{"event":{},"schedule":{}}', "hash", start, end,
                                   "accepted", 0, event, None, "legacy"))
            return db.execute("SELECT outcome FROM booking_command WHERE id=?", (key,)).fetchone()[0]

        def safe():
            overlaps = db.execute("""SELECT a.booking_id,a.role,b.booking_id,b.role
                FROM booking_reservation a JOIN booking_reservation b
                ON a.booking_id < b.booking_id
                WHERE a.start < b.end AND b.start < a.end""").fetchall()
            assert not overlaps, f"NoOverlap violated in real SQL: {overlaps}"

        def complete(key):
            with db:
                db.execute("UPDATE booking_command SET nonce='worker',execution='sent' WHERE id=?", (key,))
                db.execute(finish, ('"etag"', key, "worker"))
            safe()

        assert submit("create", "first", 0, 10) == "accepted"
        safe()
        # Run the property assertion before outcome checks: mutants expose actual overlap.
        submit("blocked", "second", 5, 15, event="second")
        safe()
        assert db.execute("SELECT outcome FROM booking_command WHERE id='blocked'").fetchone()[0] == "conflict"
        complete("create")
        assert submit("move", "first", 10, 20, "reschedule", 1) == "accepted"
        for execution in ("queued", "sent"):
            with db:
                db.execute("UPDATE booking_command SET execution=? WHERE id='move'", (execution,))
            db.close()
            db = sqlite3.connect(path)  # crash/reopen retains both holds
            for start, end in ((0, 10), (5, 15), (10, 20)):
                key = f"{execution}-{start}"
                submit(key, "second", start, end, event="second")
                safe()
                assert db.execute("SELECT outcome FROM booking_command WHERE id=?", (key,)).fetchone()[0] == "conflict"
        complete("move")
        assert submit("adjacent", "second", 0, 10, event="second") == "accepted"
        safe()
        assert submit("cancel", "first", 10, 20, "cancel", 2) == "accepted"
        assert db.execute("SELECT count(*) FROM booking_reservation WHERE booking_id='first'").fetchone()[0] == 1
        complete("cancel")
        assert db.execute("SELECT count(*) FROM booking_reservation WHERE booking_id='first'").fetchone()[0] == 0
        assert submit("adjacent", "second", 0, 10, event="second") == "accepted"
        safe()
        db.close()
    print(f"SQLite {sqlite3.sqlite_version}: real admission/finalization SQL witness passed", flush=True)


def drift_gate():
    skill = (HERE.parent / "SKILL.md").read_text()
    sync = re.search(r"Sync commit: `([0-9a-f]{40})`", skill).group(1)
    diff = subprocess.run(["git", "diff", sync, "--", *COVERED], cwd=ROOT,
                          check=True, capture_output=True, text=True).stdout
    untracked = subprocess.run(["git", "ls-files", "--others", "--exclude-standard", "--", *COVERED],
                               cwd=ROOT, check=True, capture_output=True, text=True).stdout
    if diff or untracked:
        raise SystemExit("SOURCE DRIFT: read covered diffs and resync the model per SKILL.md before trusting TLC.")


def tlc():
    cache = ROOT / ".verification/formal"
    cache.mkdir(parents=True, exist_ok=True)
    jar = cache / "tla2tools.jar"
    if not jar.exists():
        subprocess.run(["gh", "release", "download", "v1.7.4", "--repo", "tlaplus/tlaplus",
                        "--pattern", "tla2tools.jar", "--dir", str(cache)], check=True)
    if hashlib.sha256(jar.read_bytes()).hexdigest() != JAR_SHA:
        raise SystemExit("TLC jar SHA256 mismatch; inspect the pinned release, do not bypass.")
    with tempfile.TemporaryDirectory(prefix="flare-formal-tlc-") as directory:
        result = subprocess.run(["java", "-XX:+UseParallelGC", "-jar", str(jar), "-workers", "1",
                                 "-metadir", directory, "-config", str(HERE / "Reservations.cfg"),
                                 str(HERE / "Reservations.tla")], cwd=directory)
    raise SystemExit(result.returncode)


if __name__ == "__main__":
    sql_witness()
    drift_gate()
    tlc()
