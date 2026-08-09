# Crash recovery: what it promises, and how it broke

> **Status:** verified broken, fix planned, not yet implemented.
> **Written:** 9 August 2026 against `personal/ledger.js` at commit `260a0c7`.

## Context

`personal/PLAN.md` settles the memory model: **the exported file is the system of record, and the
browser is a calculator over it.** `localStorage` is demoted to crash-recovery autosave, labelled as
such in the UI and never authoritative.

That demotion is right, and it sets the bar this document is about. A safety net is allowed to be
absent — Safari private browsing and a restricted `file://` origin both refuse storage, and the
ledger says so rather than pretending. What a safety net is **not** allowed to do is fail closed:
take the page down, and take the unsaved draft with it.

That is what it currently does.

## What was verified

`ledger.js` was run in a Node VM against a DOM stub built from the real element IDs in
`ledger.html` — a working `getElementById`, memoised elements so rendered markup can be read back,
and a store that persists across boots to simulate a reload. This is stricter than the harness in
`ledger.test.js`, which has no `getElementById` at all.

| Path | Result |
| --- | --- |
| Save → reload, normal draft | Rows, `recoveredAt`, `dirty`, banner, restored tab, restored year and lock all return |
| Legacy schema 1, 3, 4 autosaves | Migrate cleanly |
| `personal/ledger.test.js` | 479 passed, 0 failed |
| `node personal/build-ledger.js --check` | in sync |
| **Malformed draft** | **Every reload throws. Blank page, no banner, no error, no way out.** |

So the ordinary resume path is sound. The failure path is not, and it fails permanently.

## The break

A draft that `render()` cannot survive — `assets: null`, `expenses: {}`, or a single `null` row
inside an otherwise good array — kills every subsequent load:

```
reload 1: boot threw = YES (Cannot read properties of null (reading 'date'))  banner=EMPTY
reload 2: boot threw = YES ...
reload 3: boot threw = YES ...

autosave key still in storage: true  -> the draft is unreachable from the UI
```

Three separate defects combine. None is sufficient alone; together they are terminal.

1. **`loadAuto()` trusts the stored shape; `loadFile()` does not.** `loadFile` normalises its
   collections — `["years","assets","expenses","income"].forEach(k => { if (!Array.isArray(M[k]))
   M[k] = []; })`. `loadAuto()` skips that step entirely, so anything malformed goes straight into
   `M`.

2. **`startLedgerApp()` is unguarded.** It runs `loadAuto(); render(); restoreUI(); render();`
   *after* `closeAcknowledgement()` has already hidden the gate. When `render()` throws, the
   exception escapes to top level and the user is left looking at the static HTML skeleton — the
   chrome is there, nothing is in it, and nothing says why.

3. **No escape hatch survives.** Both `discardRecovery()` and `resetAll()` are buttons emitted from
   inside JS template strings. Neither exists in the static markup. If `render()` never completes
   there is no button to click; only clearing site data in devtools recovers, and the unsaved draft
   goes with it.

## The page poisons itself

The reason a bad row ever reaches storage is the order inside `touch()`:

```js
function touch(){ dirty = true; saveAuto(); render(); }   // the bug
```

It persists **before** it renders. So a row that crashes a render function is written to
`localStorage` first and only then blows up the tab:

```
touch() threw during render: Cannot read properties of null (reading 'date')
but the poisoned model was ALREADY persisted: 2 rows, second is null
```

One bad row — realistically from an external converter, and `personal/gmail-to-ledger-sheet.gs` is
in active development — takes out the current session *and* every future one. Crash recovery
becomes the mechanism that makes the crash permanent.

## The fix

### 1. Render before persisting

```js
// Render first: a model that cannot be drawn must never reach storage. If render() throws,
// saveAuto() never runs and the last good blob survives for the next load to recover.
function touch(){ dirty = true; render(); saveAuto(); }
```

**Do not tidy this back.** Save-first reads as the natural order — persist the change, then show
it — and that is exactly the reasoning that produced the bug. The order is load-bearing.

### 2. One normalisation, shared

Factor the `Array.isArray` normalisation into `normaliseCollections(m)` next to `migrate()`, and
call it from **both** `loadAuto()` and `loadFile()`. External converter output and hand-edited JSON
both arrive malformed; there is no reason the file path should be defended and the autosave path
not.

### 3. Quarantine, never delete

`startLedgerApp()` snapshots the raw autosave text *before* parsing, then wraps the whole
load-and-render sequence. On a throw it resets to a clean session — the same field set `resetAll()`
clears — records `quarantinedDraft = { raw, at }`, and renders again so the banner reaches the page.

The autosave key is **not** removed. An unreadable draft is still the user's only copy of that work,
and the tool does not get to decide it was worthless. `initialiseAcknowledgement()` is wrapped for
the same reason: no throw may leave the gate closed over a dead page.

### 4. Tell the user, and give them the bytes

`renderRecovery()` gains a `quarantinedDraft` branch ahead of the `recoveredAt` branch:

> **Saved draft could not be opened** — A draft autosaved *2 hours ago* is in this browser but could
> not be read. The ledger below is empty; your draft has **not** been overwritten. Download it if
> you want a copy, then discard it.
> `[Download raw draft]` `[Discard draft]`

`downloadQuarantinedDraft()` reuses the existing `download(blob, name)` helper and writes the stored
text **unmodified** — no reserialising, no repair, no guessing. A human or a later tool can read it;
this one has already proved it cannot. `discardQuarantinedDraft()` confirms first, matching
`discardRecovery()`.

The Data tab's "Crash recovery" line reports the quarantined state too, so it is not only visible in
the banner.

## Tests

Added to the crash-recovery block of `personal/ledger.test.js`. One prerequisite: the `boot()` stub
needs `getElementById` on its `document`. Without it `showView()` throws inside `restoreUI()`'s
silent `catch`, which means view restore is currently swallowed rather than exercised — the existing
lock-survives-a-reload test passes only because the assignments happen before the throw.

- A malformed autosave (`assets: null`, `expenses: {}`, `expenses: [null]`) boots without throwing,
  leaves `M` empty, sets `quarantinedDraft`, and leaves the key in storage.
- The banner renders with both buttons.
- `discardQuarantinedDraft()` clears key and flag; the next boot starts clean.
- `downloadQuarantinedDraft()` emits the stored text byte-for-byte.
- **Save order:** a `touch()` whose `render()` throws leaves the *previous* good blob in storage, and
  the next boot recovers that earlier state rather than the poison.
- Regression: the happy path still restores rows, `recoveredAt`, `dirty`, tab and year/lock; legacy
  schemas still migrate.

```
node personal/ledger.test.js          # expect > 479 passed, 0 failed
node personal/build-ledger.js --check # expect "in sync"
```

Behaviour is edited in `personal/ledger.js` and inlined into `personal/ledger.html` by
`node personal/build-ledger.js`. Editing the source without rebuilding ships stale code to the
browser while the tests pass against fresh source.

By hand, in a browser on `personal/ledger.html`: acknowledge, add a row, reload, confirm the row and
the banner return. Then set `tax-ledger-autosave-v1` in devtools to
`{"model":{"schema":5,"years":[],"assets":null,"expenses":[],"income":[]},"at":1}` and reload —
expect a usable page, the quarantine banner, a working download and a working discard.
