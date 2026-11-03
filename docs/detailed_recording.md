# Detailed local recording

Set `DETAILED_RECORDING=true` in `.env`, then restart the server and reload the
practice page. The default is `false`. The server binds to `127.0.0.1` in
recording mode. Use `http://localhost:3000/` locally; no login is required.
This is a personal local mode. Keep it on loopback when configuring a proxy.
The proxy must forward `Host: localhost:<port>` or `Host: 127.0.0.1:<port>`,
using the backend listening port (omit the port for port 80). Other Host values
receive an empty 403 response in recording mode.
`APPLICATION_REVISION` optionally labels the application revision (default `local`).

The practice page shows whether recording is active, the selected keyboard and
layout, queued records, recovery notices and incomplete/interrupted Attempt
counts. Recording is active only with a valid keyboard and layout selected (see
[Keyboards](#keyboards)). Resolved application keyboard and lesson settings still
accompany each Attempt.

Records live in `DATA_DIR/recordings.sqlite`, separately from the account database
and binary result history. Database initialization and upgrades are transactional
and explicit: database version 1 is migrated to version 2 when it is opened, and
newer or unversioned databases fail rather than being interpreted. Server
records and immutable snapshots have no automatic expiry.
`GET /_/recording/config` reports availability and the imported keyboards. `POST /_/recording/batches` accepts
schema version 1 JSON with `snapshots`, `records` and `recovery` arrays. Limits are
256 KiB, 128 records, 128 recovery notices and 16 snapshots per request. Invalid
bodies/versions return 400, conflicts return 409 and oversized bodies return 413.
Disabled batch routes return 404 and never open the recording database.

## Keyboards

Every recorded Attempt names its physical keyboard (a typokiller Board) and the
exact saved layout (a Keymap version). Import them from typokiller's keyboard
export, then choose them on the practice page.

```sh
node root/keybr.js recording import-keyboards keyboards.json
# Source equivalent:
npx tsnode packages/server-cli/lib/main.ts recording import-keyboards keyboards.json
```

The import validates the whole file first and then writes it in one transaction,
so an invalid or failed import changes nothing. It prints how many snapshots were
new and how many were already present. Importing the same content again adds
nothing. After typokiller saves a new .vil, changes a Board's vial.json or edits
layer names, export and import again: the changed content becomes new snapshots,
and earlier snapshots, and the Attempts that refer to them, never change. Reload
the practice page to see newly imported keyboards.

### Choosing a keyboard and layout

With recording enabled, the practice page has **Keyboard** and **Layout**
choices below the lesson. They are the physical keyboard you type on and its
saved configuration, separate from keybr's own keyboard layout setting, which
still controls lessons and groups native training progress. Each layout is
labelled with its Letter layout and the first 8 characters of its saved .vil's
sha256 (typokiller's version hash). If a keyboard has several definitions
(vial.json versions), each label also names its definition.

The choice is remembered in this browser's localStorage. Without a valid choice,
practice works as usual and the status says recording is inactive. If the
remembered layout is no longer offered, the status says so and recording stays
inactive until you choose again; another layout is never chosen for you.
Changing the keyboard or layout during practice ends the current Attempt with
the `keyboard-change` reason and resets the lesson. The new choice applies only
to the practice that follows. Each Attempt's start record freezes the board and
keymap snapshot references in its context.

### Export format

`packages/keybr-recording/lib/keyboards.ts` defines the format (`keyboardExportSchema`),
and `packages/keybr-recording/fixtures/keyboards/` holds a representative pair of
exports: `initial.json`, and `updated.json` from the same database after the
Sweep vial.json, a free-range .vil and the Sweep QWERTY layer names changed. They
use typokiller's Sweep, Sofle and Q4 test fixtures, with Letter layouts computed
by typokiller's `keymap.py`.

```json
{
  "format": "keybr-keyboard-export",
  "formatVersion": 1,
  "exportedAt": "2026-11-01T09:00:00Z",
  "source": { "application": "typokiller" },
  "boards": [
    {
      "sourceId": 1,
      "name": "Sweep",
      "vial": "<the Board's vial.json text>",
      "keymaps": [
        {
          "sourceHash": "<sha256 of the .vil text>",
          "vil": "<the saved .vil text>",
          "letterLayout": "QWERTY",
          "layers": ["Base", "Sym", "Nav", "Stack", "Num"]
        }
      ]
    }
  ]
}
```

- `sourceId` is the Board's id in the source database; `name` is its unique name.
- `vial` and `vil` are the exact saved texts, as strings. Do not parse and
  re-serialize them: a .vil `uid` can exceed JavaScript's safe integer range, and
  hashes are taken over the UTF-8 text.
- `keymaps` lists every saved .vil of the Board, oldest first. `sourceHash` must be
  the sha256 of `vil`, as typokiller stores it; the import rejects a mismatch.
- `letterLayout` is the computed Letter layout name (or its 30 letters if unnamed).
- `layers` are display names from typokiller's `[keymaps.<Board>.<Letter layout>]`
  settings, base layer first, or `[]` when there are none.
- Unknown fields are rejected, so typing history, secrets or environment settings
  cannot be included by mistake. Board names and `sourceId`s must be unique, and
  a Board cannot list the same `sourceHash` twice.

### Snapshot identity

| Snapshot | `id`                           | `version`                                       | `configuration`                                                       |
| -------- | ------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------- |
| `board`  | Board name                     | sha256 of the vial.json text                    | `name`, `vial`, `vialHash`                                            |
| `keymap` | `<Board name>/<Letter layout>` | sha256 of the canonical JSON of `configuration` | `board` (`id`, `version`), `letterLayout`, `layers`, `vil`, `vilHash` |

A keymap snapshot therefore freezes its .vil, its Board definition and its layer
names together: the same .vil under a changed vial.json is a separate snapshot.
Source identifiers (`application`, `sourceId`/`boardId`, `name`, `sourceHash`) are
kept apart from content, in `keyboard_sources`, with the time each was first imported.

## Free-range layout

keybr has a **Free-range** layout (id `en-free-range`, binary id `0xfe`, family
`free-range`) for a keyboard that types free-range from its own firmware, such as
typokiller's Sweep. Choose it in keybr's own settings: language English, layout
Free-range. Lessons, training progression and results then work as for any other
layout. Free-range results are a separate layout family, so they never mix with
QWERTY progress. The physical keyboard and layout choice for recording stays
separate, as described in [Choosing a keyboard and layout](#choosing-a-keyboard-and-layout).

### Hardware-remapped input

The firmware already sends the free-range characters to the OS. Keep the OS input
source on QWERTY (US or Australian). The browser then reports, for example,
`code: "KeyX"` and `key: "x"` for the top-left key. keybr does not emulate this
layout: both emulation options in the keyboard settings are greyed out, whatever
their saved value. Typed characters are therefore never remapped a second time.
Home-row mods, Shift and Caps Word work as in the firmware, because keybr only
sees the modifier and character events that the firmware sends.

### Generation

The source is `packages/keybr-generators/layouts/en_free_range.json`. It maps the
30 main keys of keybr's matrix geometry, row by row, to the base layer of
typokiller's Sweep free-range `.vil`, with the Shift characters, and puts the
space on the inner right thumb key. The `_` key types `-` with Shift, through the
key override in the `.vil`. Regenerate
`packages/keybr-keyboard/lib/layout/en_free_range.ts` from the source with:

```sh
cd packages/keybr-generators
npm run generate-layouts
```

Do not edit the generated file. `packages/keybr-keyboard/lib/free-range.test.ts`
checks the registered characters against the Sweep `.vil` and `vial.json` in
`packages/keybr-recording/fixtures/keyboards/initial.json`, which are typokiller's
own test fixtures.

### Limitations

- The keyboard picture is keybr's standard matrix, not the Sweep. It shows only the
  base layer of the 30 main keys and the space. Keys on other layers (digits and
  symbols) are not drawn, but typing them still works.
- The highlight of a pressed key follows the browser's `code`, which is the QWERTY
  position of the character. For example, the top-left key highlights the key
  that shows `w`. The pointer to the next key to type is correct.

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
never records added while the request was in flight. When the page is hidden,
a request under 48 KB is attempted with keepalive. On close or reload, that
request may not run; queued records are delivered on the next visit.
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
The export includes `PRAGMA user_version` (the database version, 2), `metadata`,
`snapshots`, `keyboard_sources`, `attempts` and `records`. Each record also has
its own contract `schemaVersion` (1). An Attempt's `context` names its `board` and
`keymap` snapshots by `id` and `version`; read their `configuration` from
`snapshots`, and `json.loads` the `vil`/`vial` texts. `attempts.context` and `records.json` retain the versioned contract;
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
    assert db.execute('PRAGMA user_version').fetchone()[0] == 2
    for attempt_id, sequence, payload in db.execute(
        'SELECT attempt_id, sequence, json FROM records ORDER BY attempt_id, sequence'
    ):
        record = json.loads(payload)
```

Tests use temporary SQLite databases and isolated IndexedDB factories, including
Python readback with a live source connection, overlapping delivery, lost
acknowledgements, browser transaction aborts and concurrent queue connections.

With recording enabled, `npm run start-docker` listens only on the container loopback address and cannot be reached from the host.
