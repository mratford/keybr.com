# Detailed local recording

Set `DETAILED_RECORDING=true` in `.env`, then restart the server and reload the
practice page. The default is `false`. The server binds to `127.0.0.1` in
recording mode. Use `http://localhost:3000/` locally; no login is required.
This is a personal local mode. Keep it on loopback when configuring a proxy.
`APPLICATION_REVISION` optionally labels the application revision (default `local`).

The practice page shows availability, queued records, recovery notices and
incomplete/interrupted Attempt counts. Keyboard board/keymap snapshots are
explicitly labelled fixtures until keyboard import/selection is implemented.
Resolved application keyboard and lesson settings still accompany each Attempt.

Records live in `DATA_DIR/recordings.sqlite`, separately from the account database
and binary result history. Schema initialization is transactional and explicit;
unsupported or unversioned existing schemas fail rather than being migrated or
interpreted. Server records and immutable snapshots have no automatic expiry.
`GET /_/recording/config` reports availability. `POST /_/recording/batches` accepts
schema version 1 JSON with `snapshots`, `records` and `recovery` arrays. Limits are
256 KiB, 128 records, 128 recovery notices and 16 snapshots per request. Invalid
bodies/versions return 400, conflicts return 409 and oversized bodies return 413.
Disabled batch routes return 404 and never open the recording database.

## Delivery and recovery

A dedicated IndexedDB database, `keybr-detailed-recording` (version 1), stores
records before transmission. Keep using the same browser profile and origin to
recover its pending data. IndexedDB and Web Locks are required. Each tab has
independent Attempt UUIDs; transactions share the queue safely between tabs.
A Web Lock identifies a live tab. On a later visit, Attempts belonging to a dead
tab without an end record are marked interrupted in recovery metadata. No end
record or missing key release is synthesized.

The last enabled server configuration is cached in localStorage so recording can resume
after an offline reload. A successful disabled configuration clears that cache.
The queue retries on startup, reconnection and every two seconds. Each batch
commits atomically on the server before its exact record identities are
acknowledged. Lost acknowledgements are safe to resend, including overlapping
or reordered batches. Acknowledgements remove only those immutable identities,
never records added while the request was in flight. Page exit tries a request
under 48 KB; persisted data remains recoverable when that request fails.
Typing never waits for the network.

Browser storage failures are visible and mark the affected Attempt incomplete.
The incomplete marker is retried if storage initially refuses it. Previously
queued records are preserved. If storage refuses _all_ writes, the failure marker
itself cannot become durable until storage recovers. Events whose browser
transaction has not committed can be lost on shutdown; the queue cannot recover
those events. Browser data clearing or eviction also removes local pending data.

Server validation/conflict errors leave the batch queued and stop automatic
transmission for that page session. Inspect the reported HTTP status and repair
the cause, then reload to retry. Do not clear IndexedDB to fix a delivery error.
Network and server outages leave typing available and records queued. Restoring
the server and visiting practice again resumes delivery. A previous storage
failure remains visible for the current session even after delivery recovers.

## Export for Python

Run the bundled CLI (after building), or the source equivalent from the repo root:

```sh
node root/keybr.js recording export /tmp/recordings-export.sqlite
# Source equivalent:
npx tsnode packages/server-cli/lib/main.ts recording export /tmp/recordings-export.sqlite
```

The command implements `keybr recording export <file>`. Use a new output filename.
The export includes `PRAGMA user_version`, `metadata`, `snapshots`, `attempts` and
`records`. `attempts.context` and `records.json` retain the versioned contract;
`incomplete` and `interrupted` are recovery flags, separate from lifecycle records.
Order records by `(attempt_id, sequence)`; `observed_at` is the contract's monotonic
observation time, while original event JSON includes browser `timeOrigin`.
Delivery can be reordered, so check sequence continuity and the presence of start
and end records before treating an Attempt as complete.

Export uses SQLite's [transactionally consistent VACUUM INTO](https://www.sqlite.org/lang_vacuum.html#vacuuminto),
including committed WAL data, while the server can continue running. Do not copy
the live main database file by itself. Only use an export after the command has
completed successfully; an interrupted export may be partial.

```python
import json
import sqlite3

with sqlite3.connect('/tmp/recordings-export.sqlite') as db:
    assert db.execute('PRAGMA user_version').fetchone()[0] == 1
    for attempt_id, sequence, payload in db.execute(
        'SELECT attempt_id, sequence, json FROM records ORDER BY attempt_id, sequence'
    ):
        record = json.loads(payload)
```

Tests use temporary SQLite databases and isolated IndexedDB factories, including
Python readback with a live source connection, overlapping delivery, lost
acknowledgements, browser transaction aborts and concurrent queue connections.

With recording enabled, `npm run start-docker` listens only on the container loopback address and cannot be reached from the host.
