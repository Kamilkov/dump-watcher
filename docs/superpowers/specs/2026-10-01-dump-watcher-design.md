# Dump Watcher — Design

Date: 2026-10-01 · Status: revised after review (8 findings), awaiting re-review

## 1. Purpose

A live demo of an AI agent that repairs ABAP code after a short dump, without anyone at the keyboard:

1. The presenter clicks a button in a Fiori app and the app crashes with a short dump.
2. Within a few minutes the presenter's iPhone shows a notification with the root cause and a proposed fix.
3. The presenter approves on the phone, the fix is applied, and the same click works.

Audience: customers, colleagues and LinkedIn. This is a demo, not a product. It runs only against the A4H trial system, and it writes only to one sandbox package.

## 2. Decisions

| Topic | Decision | Reason |
|---|---|---|
| Purpose | Demo for others | User choice |
| Demo format | Hands-off watcher with approval on the phone | User choice |
| Trigger on stage | A click in a Fiori app | User choice; clearest story for audiences who don't know ABAP |
| Host | Mac only; nothing is deployed to the VPS | User choice; no server changes |
| Dump detection | Kernel trace stream, plus a `ListDumps` check every 5 minutes as a safety net | Detection in seconds with no load on SAP; least resource use of all options |
| Agent runtime | `claude -p`, isolated (section 7), with the playbook `agent/dump-repair.md` added to its system prompt | No agent code to write; one code path for both rehearsal and demo |
| Approval channel | ntfy notification; tapping it opens a proposal page on the Mac through Tailscale | ntfy's iOS app has no action buttons (the docs list them for Android and web only) |
| Who writes the fix | The watcher writes it after approval, never the agent | The approved code is exactly the code that gets applied |
| Concurrency | One open proposal at a time; every SAP write goes through one queue | Proposals can't overwrite each other's tests |

Rejected:
- **Service on the VPS, or an n8n workflow:** the user chose the Mac.
- **ABAP background job polling `SNAP`:** at most one run per minute, writes job logs on every run, and needs SM59 and SSL setup. It belongs to the separate `sap-dump-watcher` product.
- **bgRFC as the trigger:** no code runs at dump time, and a dump rolls back the session's work, so any registered unit disappears.
- **HANA trigger on `SNAP`:** it can't call anything outside the database, it's an unsupported change to an SAP table, and a failing trigger would lose the dump itself.
- **ADT polling only:** more load on SAP than the trace stream, and slower.
- **Running the playbook as an interactive skill:** the interactive session also has your unrestricted global `vsp`. Rehearsals use `node watcher.mjs analyze <dump-id>` instead, which runs with the same isolation as the demo.

## 3. Verified facts (2026-10-01, A4H)

All of these were checked live during the design session, through vsp calls and over SSH.

- **System:** ABAP Platform 2025 (release 816), container `a4h25` on a VPS (SSH alias `vps`), client 001.
- **vsp connection:** runs on the VPS as `ssh vps 'cd /root && vsp'`. `/root/.env` currently allows writes to `Z*,$TMP,$*`, with transports and transportable edits enabled.
- **vsp tools:** it has every tool this design needs:
  - `ListDumps` (can filter by user) and `GetDump`
  - `GetSource` (with `include_hash`), `GetClassInclude`, `GetRevisions`
  - `SyntaxCheck`, which checks source text without saving it
  - `UpdateSource` (writes without activating), and `WriteSource`, which takes `expected_source_hash` and activates
  - `Activate`, `RunUnitTests`, `CreateTestInclude`
  - `UpdateClassInclude` writes a class include such as the test classes. `UpdateSource` cannot: it appends `/source/main` to the URL, which returns 404 for includes.
- **What `GetDump` returns:** the exception class, the include, line and procedure where the dump stopped, the call stack, the system fields, a source extract, and the variables at each level. It has three quirks:
  - the source extract leaves out exactly the line where the dump stopped;
  - the extract is built from the *current* source, so after an edit it no longer matches the dump;
  - dumps inside SAP's RAP framework are about 226 KB (673 variables), too large for one tool result.
- **Dump tables:** the kernel writes each dump to `SNAP` (100–234 rows per dump). `SNAP_ADT` (one row per dump) is filled later by ABAP (`CL_RABAX_ADT_SNAP_ADT`), only when the feed is read. No ABAP code runs at dump time.
- **Trace line:** each dump writes `** RABAX: level LEV_RX_ERROR_SAVE completed.` to `/usr/sap/A4H/D00/work/dev_w*`.
- **Feed lag:** SAP lists a new dump in the ADT feed about 25–35 seconds after it happens; the trace line arrives within 2–3 seconds. `GetDump` resolves IDs through the same feed. A narrow `since` timestamp makes `ListDumps` take about 0.3 s instead of 4.3 s for a whole day.
- **Case 2 fires on load:** with the bad value help armed, Fiori Elements requests the value-help metadata as soon as the app opens, so case 2 dumps before any click.
- **Eclipse:** polls `/sap/bc/adt/runtime/dumps` every 5 minutes (`<feed:interval value="5" unit="minutes"/>`).
- **ABAP Unit:** test runs write short dumps too, with main program `RS_AUNIT_SBOX_CLASS_TEST_INT`.
- **Claude Code 2.1.285:**
  - `-p --output-format stream-json` requires `--verbose`;
  - these flags exist: `--restricted`, `--tools`, `--settings`, `--permission-mode dontAsk`, `--strict-mcp-config` and `--append-system-prompt-file`.
- **Real dumps on A4H:** 14 of the 15 latest stopped in SAP code. One example is `CX_SADL_GW_V4_MODEL_EXCEPTION` / `VH_VIEW_SAME_AS_SOURCE_VIEW`: 52 levels in the call stack, none of them Z code, and the cause is a value help that points at its own view.

## 4. Architecture

```
A4H on VPS                      Mac (the one you present from)                   iPhone
──────────                      ──────────────────────────────                   ──────
Fiori click by DEMO → dump
dev_w* trace ──ssh tail -F────▶ watcher.mjs   (one process, one queue for all SAP writes)
                                ├ trace line → ListDumps(user=DEMO)   (and every 5 min)
                                ├ new dump → dump summary → claude -p (isolated)
                                │    reads current source (+ hash), revisions
                                │    writes failing test (test include only)
                                │    returns JSON verdict + fixed source
                                ├ validates; re-runs tests per contract; binds hashes
                                ├ ntfy push: title + one-line cause ─────────────▶ 🔔
                                └ proposal page on Tailscale IP :8790 ◀── tap ─── Safari
                                     Approve → apply → verify → "Fixed ✅" / "Reverted ❌" /
                                               "Recovery required"
```

### Components

| Path | Role |
|---|---|
| `watcher.mjs` | One Node process (Node ≥ 22); this file holds the CLI and all I/O: the trace stream, starting the agent, ntfy, the proposal page and the diff. Commands: `start` (default), `analyze <dump-id>` (rehearsal: no notification, no proposal), `reset`. `analyze` and `reset` refuse to run while the watcher is running (`watcher.pid`). Only dependency: `@modelcontextprotocol/sdk`. |
| `core.mjs` | All decisions, kept testable: dump filtering and summary, agent-result validation, hash binding, the test contract, the state machine and its file store. SAP, the agent and ntfy are passed in, so tests use fakes. |
| `vsp.mjs` | The only connection to SAP: an MCP client for `vsp-lab`. |
| `agent/dump-repair.md` | The agent playbook (section 6), passed with `--append-system-prompt-file`. |
| `agent/settings.json` | The agent's only settings, passed with `--settings`: the qualified allow list and the PreToolUse hook. |
| `agent/lab-guard.mjs` | The hook: the agent may write only test includes. |
| `.mcp.json` | `vsp-lab` (section 7), used by both the agent and the watcher. |
| `lab/` | The broken sources and the baseline test include, used by `reset`. |
| `state/` (gitignored) | `status.json` (state machine), `seen.json` (dumps already handled, last dump time), `proposals/<id>.json`, `watcher.pid`. |
| `.env` (gitignored) | `NTFY_TOPIC`, `DEMO_USER=DEMO`, `PORT=8790`. SAP credentials never reach the Mac; vsp runs on the VPS. |

### State machine

`status.json` is written to disk before every state change, so the watcher always restarts from a known state.

| State | Meaning | Next state |
|---|---|---|
| `idle` | Nothing in progress | `analyzing` when a dump is waiting in the queue |
| `analyzing` | The agent is running | `awaiting_decision` (a proposal was published) or `idle` (informational result, or the agent failed) |
| `awaiting_decision` | One proposal is open | `applying` (Approve); `idle` (Reject, expiry after 1 h, or `reset`) |
| `applying` | The watcher is writing to SAP | `idle` (verified fix, or verified restore); `awaiting_reclick` (CDS fix); `recovery_required` |
| `awaiting_reclick` | A CDS fix was applied but isn't confirmed yet | `idle` ("Works ✅", a verified restore after "Still broken", or expiry after 1 h, reported as "applied, unconfirmed"); `recovery_required` |
| `recovery_required` | The lab is in an unknown state | Only `reset` leaves this state; every SAP write is blocked until then |

On startup, a saved state of `applying` or `analyzing` means the process was interrupted mid-step:
- `applying` becomes `recovery_required`, and a "Recovery required: run reset" notification is sent;
- `analyzing` becomes `idle`, and the dump is analyzed again.

### Flow

1. **Trigger:** `ssh vps "docker exec a4h25 sh -c 'tail -F -n0 /usr/sap/A4H/D00/work/dev_w*'"`. The `sh -c` makes the glob expand inside the container, not on the host.
   - Each dump writes exactly one `LEV_RX_ERROR_SAVE completed` line, which triggers `ListDumps(user=DEMO)` immediately. If the dump isn't visible yet, the call is retried after 1 s, at most 3 times.
   - The same check also runs every 5 minutes, and once at startup to catch up from `seen.json`.
2. **Filter and queue:**
   - Ignore dumps already in `seen.json`.
   - Each dump gets a key made of the runtime error, program, include and line. If the open proposal has the same key, only its counter goes up.
   - Any other dump waits in the queue until the state is `idle`.
3. **Dump summary:** the watcher calls `GetDump` and builds a compact summary of a few KB:
   - the header and exception;
   - where the dump stopped;
   - the call stack;
   - the source extract, with a warning about its quirks;
   - only the variables whose name or value contains a Z object name or a `CX_` class, each value cut to 200 characters.
4. **Agent:** this command runs, with a 5-minute timeout:

   ```
   claude -p "<task + dump summary>" \
     --append-system-prompt-file agent/dump-repair.md \
     --restricted --tools "" \
     --mcp-config .mcp.json --strict-mcp-config \
     --settings agent/settings.json --permission-mode dontAsk \
     --output-format stream-json --verbose
   ```

   The terminal prints each tool call. The agent's last message ends with a fenced JSON block (schema below), and the watcher parses the last such block.
5. **Validation (by the watcher).** If any check fails, the verdict becomes `unsure`, with the reason shown.
   - The JSON matches the schema.
   - For `code_fix`: the object is in `$ZDUMP_LAB`, the forbidden-pattern scan passes, and `SyntaxCheck` passes on the fixed source.
   - **Hash binding:** the original source and its hash are taken from the agent's own `GetSource(include_hash=true)` result for the target object, as recorded in the stream, not from the agent's text. If no such result exists, the verdict becomes `unsure`. The watcher then reads the source again and publishes only if the hash still matches.
   - **Test contract (class fixes):** `RunUnitTests` must show all of the following:
     - the named test ran and failed with the dump's runtime error (for case 1, `GETWA_NOT_ASSIGNED`);
     - the baseline test ran and passed;
     - at least 2 tests ran.

     An empty result, a missing test, or a failure for any other reason doesn't qualify.
   - The watcher records the hash of the test include once it's confirmed.
6. **Proposal:** the watcher saves the agent's JSON, the original source and its hash, the test-include hash, the fixed source and a `diff -u`. The page is at `http://<tailscale-ip>:8790/p/<id>?t=<token>`.
7. **Notification:** `POST https://ntfy.sh/<topic>` with the headers `Title: <runtime error> in <object>`, `Click: <page URL>` and `Priority: high` (for `code_fix`), and the one-line cause as the body. A `data_fix`, `already_changed` or `unsure` verdict sends an informational notification and a page without Approve, and the state goes back to `idle`.
8. **Approve** (an HTML form on the page sends the token; the token works only once):
   1. Check that the test include still has its recorded hash. If it doesn't, refuse with "stale proposal".
   2. Save the state as `applying`.
   3. Write the fix with `WriteSource(fixed source, expected_source_hash)`. A hash mismatch means the proposal is refused as stale, nothing is written, and the state goes back to `idle`.
   4. **Class fixes:** run `RunUnitTests`. The named test and the baseline test must both run and pass, with zero failures. If they do, send "Fixed ✅". If they don't, restore the original (step 6).
   5. **CDS fixes:** after activation, the state becomes `awaiting_reclick`, the page shows "Applied, awaiting re-click", and the notification says "Applied: open the value help to confirm". The page then offers two buttons:
      - "Works ✅" marks the fix as confirmed;
      - "Still broken" restores the original (step 6).
   6. **Restore:** write the original source back and activate it, then read it back. Only if the read-back hash equals the original hash does the watcher send "Reverted ❌". Otherwise the state becomes `recovery_required` and it sends "Recovery required: run reset".
9. **Reject:** the proposal is marked rejected and nothing is written. The agent's test stays in the test include until the next `reset`.
10. **Reset** (`node watcher.mjs reset`):
    - It refuses to run while the watcher is running (`watcher.pid`), so it never races with analysis or application.
    - It writes back the broken sources and the baseline test include from `lab/`, activates them, and checks their hashes.
    - It then cancels every open proposal and sets the state to `idle`. This is the only way out of `recovery_required`.

### Agent result schema

```json
{
  "verdict": "code_fix | data_fix | already_changed | unsure",
  "cause": "one line for the phone, max 120 chars",
  "explanation": "markdown for the page: what happened, why, why this fix",
  "object": { "type": "CLAS | DDLS", "name": "ZCL_DL_PRICING" },
  "fixed_source": "complete new source: class main include or DDL source (code_fix only)",
  "test": { "class": "LTC_DUMP_REPRO", "method": "small_order_has_no_discount" },
  "verification": "unit_test | manual_reclick",
  "data_action": "what to maintain (data_fix only)",
  "confidence": "high | medium | low"
}
```

## 5. The lab

**Package:** `$ZDUMP_LAB` (local, no transports). It holds one small "Orders" RAP app: managed, without draft, opened through the service binding's Fiori Elements preview. Names follow the `rap-conventions` skill.

| Object | Purpose |
|---|---|
| `ZDL_ORDER` | Orders: id, customer, product, quantity, currency, discount |
| `ZDL_CONFIG` | Configuration per currency (maintained for EUR and USD only) |
| `ZI_DL_ORDER`, `ZC_DL_ORDER` | Root and projection views |
| `ZC_DL_CUSTOMERVH` | Customer value help (`SELECT DISTINCT customer FROM zdl_order`) |
| Behavior definition + `ZBP_DL_ORDER` | Action `recalculate`, which calls the pricing class |
| `ZCL_DL_PRICING` + test include | Discount tiers and the configuration lookup. The baseline has one passing test (20 units) |
| `ZCX_DL_CONFIG_MISSING` | Exception used for the deliberate short dump |
| `ZSD_DL_ORDER` / `ZSB_DL_ORDER_O4` | Service definition and OData V4 UI binding (the Fiori Elements preview) |

**Seed data** (`ZDL_SEED`): three orders, loaded once during the build: 5 units in EUR, 20 units in EUR (control), and 20 units in XYZ. There is no amount field: no case uses it, and an integer money field would break the rule that amounts carry 2 decimals. The XYZ order has 20 units so that case 1's bug can't fire on it; `recalculate` also looks up the configuration before the discount. No case changes data, so the data never needs resetting.

| # | Click | What goes wrong | Where the dump stops | Correct outcome |
|---|---|---|---|---|
| 1 Classic bug | Recalculate on the 5-unit order | The discount loop finds no tier below 10 units, so the field symbol is still unassigned when used: `GETWA_NOT_ASSIGNED` | `ZCL_DL_PRICING` | `code_fix`, verified by the test contract |
| 2 Framework dump | Open the Customer value help | The value help in `ZC_DL_ORDER` points at `ZC_DL_ORDER` itself: `VH_VIEW_SAME_AS_SOURCE_VIEW` | SAP code (SADL), no Z code in the call stack | `code_fix` (one annotation line); "Applied" until confirmed by clicking again |
| 3 Decoy | Recalculate on the XYZ order | Configuration is missing, so the code deliberately raises a short dump (`RAISE SHORTDUMP TYPE zcx_dl_config_missing`) | `ZCL_DL_PRICING`, on purpose | `data_fix`: maintain `ZDL_CONFIG` for XYZ. No Approve button, and nothing is written |

## 6. Agent playbook (`agent/dump-repair.md`)

1. **Start from the dump summary** in the prompt. Never trust its line number or source extract.
2. **Find the cause.** If the dump stopped in SAP code, look for the Z object behind it: Z levels in the call stack, Z names in the variables, and the SAP source around the stop point (read it), which shows the check that failed.
3. **Read the current source** of the object you will fix with `GetSource(include_hash=true)`; the watcher binds the proposal to that hash. If `GetRevisions` shows a change after the dump time, the verdict is `already_changed`.
4. **Classify** the dump as `code_fix`, `data_fix`, `already_changed` or `unsure`.
5. **`code_fix` in a class:**
   - write the failing test first, as a new local test class `LTC_DUMP_REPRO` in the test include, next to the existing classes (`UpdateClassInclude` with `include_type: testclasses`, `Activate`, `RunUnitTests`). A runtime error in a test stops only its own test class, so the baseline class still runs. Keep adjusting the test, up to 3 attempts, until it fails with the dump's runtime error while the baseline test still passes;
   - write the smallest fix in the method that dumps;
   - check it with `SyntaxCheck`, without writing it.
6. **`code_fix` in a CDS view:** write the fixed DDL source, check it with `SyntaxCheck`, and set `verification: manual_reclick`.
7. **Finish** with the JSON block.

Rules:
- Root cause in 1–2 sentences.
- No refactoring and no renames.
- Never `CATCH cx_root`, `cx_static_check`, `cx_dynamic_check` or `cx_no_check`.
- Never remove `RAISE SHORTDUMP` or `MESSAGE … TYPE 'X'`.
- Never return early without saying why in `explanation`.

## 7. Guardrails

- **Sandbox (server side):** the `vsp-lab` command is
  `ssh vps "cd /root && vsp --mode expert --allowed-packages '\$ZDUMP_LAB' --block-free-sql --disallowed-ops DX"`.
  - `D` blocks deletes and `X` blocks every transport tool.
  - vsp's source (commit `d5101da`, the build running on the VPS) gives flags priority over `SAP_*` settings in `/root/.env`, and applies the package limit to writes only. Section 8 confirms both live.
  - `$ZDUMP_LAB` must be quoted so the remote shell doesn't expand it.
- **Agent isolation:** every flag is spelled out in the command in section 4.
  - `--restricted` ignores user, project and local settings files, so nothing from your personal configuration applies.
  - `--tools ""` removes every built-in tool: no Bash, no file access, no web access.
  - `--strict-mcp-config` loads only `vsp-lab`, keeping your unrestricted global `vsp` out of reach.
  - `agent/settings.json` allows exactly these qualified tools:
    - read-only: `mcp__vsp-lab__GetSource`, `mcp__vsp-lab__GetClassInclude`, `mcp__vsp-lab__GetRevisions`, `mcp__vsp-lab__GetRevisionSource`, `mcp__vsp-lab__GrepObject`, `mcp__vsp-lab__SearchObject`, `mcp__vsp-lab__GetCDSDependencies`
    - checks and test writes: `mcp__vsp-lab__SyntaxCheck`, `mcp__vsp-lab__CreateTestInclude`, `mcp__vsp-lab__UpdateClassInclude`, `mcp__vsp-lab__Activate`, `mcp__vsp-lab__RunUnitTests`
  - `--permission-mode dontAsk` denies every tool that isn't on that list, including `WriteSource`, `EditSource`, `DeleteObject`, `RunQuery` and `ExecuteABAP`.
- **Hook (`agent/lab-guard.mjs`, PreToolUse):** `UpdateClassInclude` is allowed only with `include_type: testclasses` on a lab class (`ZCL_DL_*`), and `Activate` only for `/sap/bc/adt/oo/classes/zcl_dl_…`. Anything else is blocked.
- **Forbidden-pattern scan (watcher):** a `code_fix` whose `fixed_source` catches `cx_root`, `cx_static_check`, `cx_dynamic_check` or `cx_no_check`, or that has fewer `RAISE SHORTDUMP` / `TYPE 'X'` statements than the original, becomes `unsure`.
- **Scope:** only dumps from user `DEMO` are handled. That excludes your other work, and the agent's own test dumps, which run as VSP.
- **Writes are serialized:** one watcher process, one queue, and one open proposal at a time. `reset` runs only while the watcher is stopped.
- **Approval page:** listens only on the Mac's Tailscale IPv4 address (`tailscale ip -4`). Each proposal has a 128-bit random token that works once and expires after 1 hour.
- **Data sent outside:** ntfy.sh sees the title and the one-line cause. Claude sees the dump summary and the lab sources.

| Failure | Behavior |
|---|---|
| The ssh trace stream drops | Reconnect after 1, 2, 4… seconds, up to 60 s; the 5-minute check covers the gap |
| The agent fails or times out | Send "couldn't analyze <dump>"; no retry; state goes back to `idle` |
| The source changed before Approve (source or test-include hash) | Refuse, nothing is written, send "stale proposal" |
| Tests fail or activation fails after the fix is written | Restore; "Reverted ❌" only after a verified restore |
| The restore itself fails, or can't be verified | `recovery_required`: send "Recovery required: run reset", and block all writes |
| The watcher restarts during `applying` | `recovery_required` (see the state machine) |

## 8. Testing

**Assumption checks.** These are the first tasks, each with a fallback:

| Check | Fallback if it fails |
|---|---|
| The `vsp-lab` flags override `/root/.env`: a test write outside `$ZDUMP_LAB` is refused, and transport tools are unavailable | A separate directory on the VPS with its own restricted `.env` (chmod 600) |
| `vsp-lab` can still *read* SAP standard objects (for example `CL_SADL_GW_V4_MODEL_VH_PROP`), which case 2 needs | Give the agent a second read-only connection, `vsp-read` (`--read-only`, no package limit), allowing only read tools |
| **Negative check:** in the isolated agent, asking for `WriteSource` on a main include, `UpdateSource` on a non-test include, a write outside `$ZDUMP_LAB`, `RunQuery` and `Bash` is denied every time, and every source hash stays the same | None; this must pass |
| A Fiori click by DEMO writes the `LEV_RX_ERROR_SAVE` line | Use `ListDumps` every 15 s as the main trigger |
| How `RunUnitTests` reports a runtime error in a test (needed for the test contract) | Adjust how the contract reads the result; the contract itself stays the same |
| A runtime error in `LTC_DUMP_REPRO` leaves the baseline class `LTC_PRICING` running and passing | Before the fix, the contract no longer requires the baseline to have run; after the fix, both classes must still run and pass |
| Case 1's dump stops in `ZCL_DL_PRICING` | If SADL wraps it, keep the case and update its "where it stops" column |
| Case 2's bad value help breaks only the value help | Move case 2 to a second small service, so arming it can't break cases 1 and 3 |
| iPhone: the notification arrives and tapping it opens the page | Show the URL in the notification body; use iPhone Mirroring on the Mac |

**Watcher tests:** `core.test.mjs` and `flow.test.mjs` use `node:test` with a fake vsp client. They cover:
- the user filter, the duplicate key and the queue (a second dump waits while a proposal is open);
- the trace-line match, and the retry while the dump isn't visible yet;
- hash binding, which must use the agent's `GetSource` result from the stream;
- the test contract: unrelated failures, a missing test, an empty result, or a baseline that fails are all rejected;
- apply, then tests failing, then a verified restore;
- **a restore that fails** leads to `recovery_required`, and writes are blocked;
- **an interrupted apply** (restart while `applying`) leads to `recovery_required`;
- the stale source or test-include hash, the forbidden-pattern scan, and a token that works once and expires;
- the CDS path: `awaiting_reclick`, then "Works" or a restore.

**Agent quality:** run `node watcher.mjs analyze <dump-id>` on each case, which uses the same isolation as the demo. Each run is scored on:
- the correct verdict;
- whether the test contract holds (case 1);
- the smallest possible fix;
- a correct explanation.

Tune the playbook until the results are stable.

## 9. Definition of done

Every case must pass **3 rehearsals in a row**, each starting with `reset` and a fresh start of the watcher:

| Case | Passes when |
|---|---|
| 1 | Click, notification, the proposal meets the test contract, Approve, "Fixed ✅" (both tests pass), and Recalculate works |
| 2 | Click, notification, Approve, "Applied, awaiting re-click", the value help opens, "Works ✅" |
| 3 | Click, a `data_fix` notification naming `ZDL_CONFIG` and `XYZ`, no Approve button, and no SAP write by the watcher (source hashes unchanged) |

**Timing targets**, measured from the dump timestamp:

| Path | Target |
|---|---|
| Trace path: the watcher logs the new dump | ≤ SAP's feed lag + 2 s (measured feed lag 25–35 s; ≤ 3 s would need direct SQL on `SNAP`, which this design avoids) |
| Fallback path: detection | ≤ the polling interval + 3 s (5 min 3 s for the safety net; 18 s if 15-second polling becomes the main trigger) |
| Notification after detection | ≤ 3 min |
| Approve to "Fixed ✅" or "Applied" | ≤ 30 s |

A screen recording of a clean run exists as a backup.

## 10. Demo runbook

**Before:**
- Tailscale on, on both the Mac and the iPhone.
- Quit and reopen the ntfy app, then use *Send test notification* in the topic's menu and check that the alert arrives. In rehearsal 4, a stale ntfy app held back a push that ntfy had already accepted.
- `node watcher.mjs reset`, then `node watcher.mjs` in a terminal the audience can see.
- Fiori preview open in a private browser window, logged in as DEMO. First open `http://localhost:50000/sap/public/bc/icf/logoff` in that window, otherwise the browser reuses your DEVELOPER session and the watcher ignores the dumps.
- Optionally, iPhone Mirroring on the Mac.

The cases run in the order 2, 1, 3: the armed value help (case 2) dumps the moment the app opens, and the watcher keeps one proposal open at a time.

| Order | Case | Duration | What the audience sees |
|---|---|---|---|
| 1st | 2 | ~4 min | The app opens and has already crashed: "the dump is in SAP code, the cause is your annotation". Approve, the page shows "Applied, awaiting re-click"; reload, the value help opens, tap "Works ✅" |
| 2nd | 1 | ~4 min | Recalculate on the 5-unit order crashes, the agent's steps scroll by, the phone buzzes. The proposal shows the cause, the failing test and the diff. Approve shows "Fixed ✅", and Recalculate works |
| 3rd | 3 | ~2 min | Recalculate on the XYZ order crashes, then the notification "data fix: maintain ZDL_CONFIG for XYZ", with no Approve button |

**One-time setup:**
- create SAP user `DEMO` in SU01 as a copy of DEVELOPER;
- subscribe to the new ntfy topic on the iPhone;
- `npm install` in this repo.

## 11. Out of scope

- More classic cases: division by zero, conversion errors, and errors that SADL catches and re-raises.
- The BTP ABAP Cloud variant.
- Running on the VPS.
- Applying data fixes automatically.
- The SAP-native alert product. That's `~/Code/Working/sap-dump-watcher`, where an ABAP job plus bgRFC delivery fits.
- Upstream fixes to vsp: the missing stop line in the extract, and a summary mode for `GetDump`.

## 12. Risks

- The agent's results vary from run to run, which is risky on stage. Mitigation: 3 clean rehearsals per case and a recorded backup.
- An agent run may take longer than 3 minutes. Mitigation: measure, then choose `--model`.
- The trace format isn't documented, so a kernel update could change it. The 5-minute check catches dumps the trace misses.
