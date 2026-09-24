# Phase 5b-2 — Alert rules in the browser: design

Status: approved in brainstorming on 2026-09-24; this document is for review before the implementation plan.

Second of the three 5b pieces (see `docs/superpowers/specs/2026-09-23-settings-auth-design.md`): 5b-1 added sign-in, the `settings` table and the retention editor; this one makes alert rules editable, adds acknowledging and fixes `swap_heavy`; 5b-3 adds notifications.

## Goal

The signed-in operator can add, edit, disable and revert alert rules from the Alerts page, and acknowledge open alerts, without touching the rules file or restarting:

- A saved rule change is in force within one check (≤ 15 s), and immediately after a save.
- Browser changes sit above `PIPULSE_ALERTS_FILE`, which sits above the built-ins.
- Nothing saved from the browser can stop PiPulse from starting.
- `swap_heavy` measures swapping (pages moving to and from swap), not how full swap is, so it no longer stays open on the Pi 2's small, 81 %-full swap file.

**Success:** see [Exit criterion](#exit-criterion).

## Scope

In scope: a saved rules layer in the `settings` table; a rules source read on every check; the engine following rule changes live; rule and acknowledge endpoints; migration 6 (`acknowledged_at`, `rule_hash`); a `swap_io` plugin and a rate-based `swap_heavy`; the rules editor and acknowledge buttons on the Alerts page; live `rules` and `acknowledged` WebSocket messages.

Out of scope:

- Notifications and silencing for a duration (5b-3; silencing only matters once something repeats).
- Editing the rules file through the API. It stays operator-owned and read-only to PiPulse.
- Changing the file-rule validation policy: an invalid `PIPULSE_ALERTS_FILE` still stops startup.

## Rule layers

Three layers merged by `id`, later wins: **built-in → file → saved**.

The saved layer is one settings key, `alerts.rules`: an array of entries in the rules-file format (the same fields, durations as written, e.g. `"10min"`), validated by the same `parseEntry` in `packages/alerts/src/rules.ts`. Entries:

| Saved entry                                      | Effect                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| A full rule whose `id` exists below              | Replaces that rule (kind `edited`).                                            |
| A full rule with a new `id`                      | Adds a rule (kind `added`).                                                    |
| `{ "id": …, "disabled": true }`                  | Disables the built-in or file rule with that id.                               |
| A full rule with a new `id` and `disabled: true` | An added rule, switched off but kept, so Enable restores it with its settings. |

Removing a saved entry reverts to whatever is below: an edited or disabled rule gets its file or built-in version back; an added rule is deleted. A full rule with `disabled: true` is accepted only in the saved layer; the file's behaviour is unchanged.

**Kinds** shown in the editor: `built-in`, `file`, `edited` (with the version it overrides, for Revert), `added`.

**Invalid saved entries are skipped, never fatal.** An entry that was valid when saved can become invalid later: the file drops a rule a saved entry disables, a future version drops a metric, or `PIPULSE_RETENTION_RAW` in the environment is shortened below a saved rule's `for`. Such an entry is left out of the rules in force, logged once per distinct problem, and shown in the editor as "Not in force: <reason>" with Delete available. Startup never fails because of browser data. File errors still stop startup, as in 5a.

## Rules source

`rulesSource(db, { cores, metrics, file, rawRetention })` in `packages/alerts` returns a function that, on every call, reads `alerts.rules` from settings, merges the three layers and returns:

- `rules`: the rules in force (disabled and invalid ones left out) — what the engine checks and `/api/config` serves;
- `entries`: every rule for the editor, with `kind`, `disabled`, `overrides` and `problem`.

The file is read and validated once at startup (a bad file stops startup); the saved layer is re-read on every call, like `retentionSource()`. `rawRetention` is a function, so the check against raw retention always uses the value in force.

## Engine

`startAlerts` takes `rules: () => Rule[]` instead of a fixed array. Each check:

1. Reads the rules. If that throws, the error goes to `onError` and this check is skipped; the next one runs.
2. Closes open alerts whose rule and metric are no longer watched: `cleared_by = 'rule_removed'` (deleted or disabled rule). This used to happen only at startup.
3. Closes open alerts whose rule changed since they were raised: `cleared_by = 'rule_changed'`. Each alert stores a fingerprint of the rule that raised it (`rule_hash`: a hash of the rule's resolved fields — metric, condition, durations, severity, message). Alerts raised before migration 6 have no fingerprint and are left alone.
4. Evaluates as in 5a. Because windows are read from stored readings, an edited rule that still holds re-raises on this same check with its new severity and message.

It returns `{ check, stop }` as before. The server passes `check` to the API as `recheck`, which runs after every rule write so the result shows without waiting up to 15 s.

## Acknowledging

Acknowledging marks one open alert as seen. It stays open and on the Alerts page, tagged "Acknowledged 10:42", but no longer counts in the nav badge, and the tile alert line is muted ("Alert since 10:42 · acknowledged"). The acknowledgement belongs to that alert row: once it clears, the next raise is a new row and is loud again. It does not change raising or clearing.

## Storage

Migration 6:

```sql
ALTER TABLE alerts ADD COLUMN acknowledged_at INTEGER; -- NULL until acknowledged
ALTER TABLE alerts ADD COLUMN rule_hash TEXT;          -- fingerprint of the raising rule
```

`cleared_by` gains the value `'rule_changed'`. The saved rules need no migration (the `settings` table is key/value).

Store functions: `acknowledgeAlert(db, id, at)` (idempotent on an open alert, refuses a cleared one), `raiseAlert` writing `rule_hash`, and `Alert` gaining `acknowledgedAt`.

## `swap_io` and `swap_heavy`

- **Plugin `swap_io`** (collector): reads `pswpin` and `pswpout` from `/proc/vmstat` every 10 s and reports their combined rate in pages/s. It returns `null` on the first poll and after a counter goes backwards, the same as the network rate plugins. Where `/proc/vmstat` is missing it is unavailable, like the other Linux-only plugins. It runs through the plugin contract suite.
- **Dashboard:** `swap_io` is in `historyOnly` (no Now tile) and drawn on History beneath swap use.
- **Built-in `swap_heavy`** becomes `swap_io ≥ 250` pages/s (about 1 MB/s with 4 KiB pages) for `10min`, message "Swapping heavily". **`swap_full`** stays `swap_used ≥ 95 %` for `10min`.

## API

Every write goes through the one auth hook in `packages/api/src/auth-routes.ts` (session and same-host `Origin`; `403` everywhere when no password hash file is configured). No route checks auth itself.

- `GET /api/alerts/rules` — the editor view: every entry, including disabled and not-in-force ones, each with `id`, the rule fields as written and in ms, `kind`, `disabled`, `overrides` (the lower-layer rule, for Revert) and `problem`.
- `PUT /api/alerts/rules/:id` — body in the rules-file format, at most 4 KB. A full rule saves or replaces the entry (an unknown `id` adds a rule); `{ "disabled": true }` disables a built-in or file rule; an added rule is disabled or enabled by saving it with or without `"disabled": true`. Answers `200` with the editor entry, or `400 { errors: { field: message } }`. An enabled rule whose `for` or `clearAfter` is longer than the raw retention in force is a `400` on that field: "longer than raw retention (2d); raise it on the Settings page first". A full rule saved with `"disabled": true` is only parsed (no metric or retention check): it never runs, so it needn't fit, and editing a disabled rule keeps it disabled. The saved layer is capped at 200 entries. The route `id` must match the body's `id` when the body has one.
- `DELETE /api/alerts/rules/:id` — removes the saved entry (Revert of an edited rule, Enable of a disabled built-in or file rule, or Delete of an added one). `404` when nothing is saved for that id. When removing it would put a file or built-in rule back in force whose `for` or `clearAfter` is longer than the raw retention in force, it is refused with the same `400 { errors: { for | clearAfter: "longer than raw retention (1h); raise it on the Settings page first" } }` and nothing changes.
- `POST /api/alerts/:id/acknowledge` — `200` with the alert; `404` for an unknown id; `409` if it has cleared. Acknowledging twice keeps the first time.
- After each rule write: `recheck()` runs, then the WebSocket sends `{ type: 'rules', rules }` (the rules in force) so every open dashboard recolours its tiles. Raises and clears caused by the recheck arrive as usual `alert` messages. An acknowledgement sends `{ type: 'alert', event: 'acknowledged', alert }`.
- `GET /api/config`'s `rules` keeps its meaning: the rules in force, now read from the source on every request. Alerts gain `acknowledgedAt`.
- **One retention rule: only rules in force must fit raw retention**, and it is checked whenever something puts a rule into force — saving an enabled rule, Enable, Revert, and startup. A disabled rule never runs, so it is never checked against retention. `PUT /api/settings` (retention) checks raw retention against the longest look-back of the rules in force now, not a startup snapshot, so it can't be shortened below a rule added in the browser, but can be below a rule disabled there. At startup only the file and built-in rules in force are checked (a raw retention shorter than one of them stops startup); a file or built-in rule disabled or replaced from the browser is not, and saved rules are checked per entry and skipped when they don't fit (see [Rule layers](#rule-layers)).

## Dashboard

On the Alerts page (`#/alerts`):

- **Rules section.** One row per rule: message, metric, the condition in words ("≥ 80 °C for 2 min", "no reading for 5 min"), severity, a kind badge (Built-in, File, Edited, Added, Disabled) and, when present, "Not in force: …". Signed in: **Edit**, **Disable** / **Enable**, **Revert** (edited) or **Delete** (added), and an **Add rule** button. Signed out or read-only: the rows only, with "Sign in to edit rules" (as on the Settings page).
- **Rule form** (inline, for Add and Edit): id (Add only), metric (a list from `/api/config`'s plugins, plus "Every metric" when the condition is "no reading for"), condition (at least / at most / bits set / no reading for), value (bits accept `0x…`), `for`, `clear after` (hidden for "no reading for"), severity, message. Server errors appear under their fields, and focus moves to the first one.
- **Open alerts** gain an **Acknowledge** button (signed in) and the "Acknowledged …" tag.
- **Nav badge** counts unacknowledged open alerts only; with only acknowledged ones open it shows plain "Alerts".
- A `rules` WebSocket message replaces the rules in the store, so tile colours follow edits without a reload.

Colour is never the only signal, as before.

## Security

- Rules remain data: saved entries go through the same field allow-list and validation as the file (an unknown field is a `400`); nothing is evaluated as code. Messages are rendered as text.
- Rule writes and acknowledging need a session, like every write.
- Body size (4 KB) and saved-layer size (200 entries) are capped so the settings row stays small.
- The rules file stays out of reach of the API.

## Testing

Vitest, in CI like every phase:

- **Alerts core:** merging the saved layer (edit, add, disable a built-in, an added rule kept disabled, revert by removing the entry); invalid saved entries skipped with a `problem` and not fatal; file errors still fatal; `kind` and `overrides` in the editor entries.
- **Engine:** a source that changes between checks closes alerts as `rule_removed` and `rule_changed` and re-raises from stored readings with the new severity; alerts without `rule_hash` untouched; a throwing source reported and the next check still runs.
- **Storage:** migration 6; acknowledging is idempotent and refused on a cleared alert.
- **`swap_io`:** rate from two `/proc/vmstat` reads, `null` on the first poll and after a counter reset; the plugin contract suite.
- **API:** rules `GET`/`PUT`/`DELETE` shapes and per-field `400`s; the raw-retention refusal; `401` without a session and `403` without a password; the `rules` and `acknowledged` WebSocket messages; `/api/config` reflecting a saved change; retention `PUT` refusing to go below a browser-added rule's look-back.
- **Web (happy-dom):** rule rows and badges; the form adding, editing and showing field errors with focus; Disable, Enable, Revert and Delete; the read-only view; the Acknowledge button and tag; the badge ignoring acknowledged alerts; tiles recolouring on a `rules` message.

## Exit criterion

On the Pi 2 (port 8889), signed in, with no rules file:

1. Add `test_busy` in the browser (`cpu_load` at least 50 % for `1min`, clear after `1min`, warning). Load the CPU (`yes > /dev/null` four times): it opens within about 75 s, without a restart.
2. Edit it to critical while open: the warning alert closes as `rule_changed` and a critical one opens straight away.
3. Acknowledge it: the badge count drops live in a second browser tab.
4. Disable the built-in `cpu_busy`, reload: still disabled. Revert brings it back. After a server restart every saved rule is still in force.
5. `swap_heavy` is not open on the Pi 2 (swap flat at about 81 %, `swap_io` near zero).

Plus `npm test`, lint and format green in CI.
