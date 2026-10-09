# Dump Watcher — LangGraph engine (v2) — Design

Date: 2026-10-09 · Status: approved (section by section in conversation, then the written spec after three rounds of external review, 2026-10-09)

## 1. Purpose

A second engine for the dump-watcher demo, built with LangGraph and LangChain, as a portfolio piece for both.

The demo stays the same: a click in a Fiori app ends in a short dump, the phone shows the cause, a test that reproduces it and a fix, and the fix is applied only after the Approve tap. (Before the tap, the target class's test include already holds the reproducing test, in both engines.) `node watcher.mjs --engine langgraph` runs the new engine. Without the flag, the watcher runs v1, the Claude Code engine, exactly as today.

What v2 shows that v1 doesn't:

1. **Rules move from the prompt into the graph.** v1's playbook asks for up to 3 test attempts; if the agent's final answer still breaks the test contract, the watcher can only mark it `unsure`. v2 checks the contract in code and sends the failure back to the model. v1's playbook also asks the agent to leave the existing tests unchanged; v2's code appends the model's test class to the original include, so they can't change.
2. **The model has no write tools.** v1's agent writes the test include itself, fenced by an allow list, `--permission-mode dontAsk` and a PreToolUse hook. In v2 the model only drafts text, and code does every write.
3. **Durable pauses and crash recovery.** Approval is a LangGraph `interrupt()` stored by a checkpointer, and a restarted watcher continues where it stopped.
4. **A measured comparison of two implementations.** Both engines run the same lab, the same cases, the same model and the same rehearsal rules, and the README publishes only what was measured. Prompts, tools and the agent loop still differ, so the numbers compare these two implementations, not LangGraph against Claude Code.

Audience: customers, colleagues and LinkedIn, as for v1. Lab and trial systems only.

## 2. Decisions

| Topic | Decision | Reason |
|---|---|---|
| What to build | A LangGraph engine for dump-watcher, not a new "Dump Doctor" | User choice; v1 already repairs dumps and passed 3 rehearsals per case |
| Layout | Both engines in one repo: `--engine claude\|langgraph`, default `claude` | User choice; readers can compare the engines on identical inputs and outputs |
| Approach | Explicit pipeline: the model in 3 steps; code for every SAP write, every check and both retry limits | User choice |
| Observability | LangSmith tracing; `langgraph.json` to open the graph in Studio for screenshots | User choice |
| Language | Plain JS (`.mjs`) | The existing project is JS (user rule) |
| Tools for the model | 7 read-only vsp tools, wrapped as LangChain `tool()`s over `vsp.mjs` | Exact schemas, and one SAP connection shared with the code steps. `@langchain/mcp-adapters` 2.0 has a new API and was 3 days old |
| Model | One pinned model for both engines (`AGENT_MODEL`) | Takes the model out of the comparison; prompts, tools and the agent loop still differ |
| Checkpointer | `SqliteSaver` in `state/graph.sqlite`, `durability: "sync"` | Steps write to SAP, so each step is saved before the next one starts |
| SAP writes | One rule for all three writes (section 6): skip if SAP already holds what the step would write; write only over the hash the step expects to replace, which vsp checks again under the lock; stop on anything else | Shows durable execution, and neither a rerun nor a retry overwrites a change that isn't ours |
| Versions | As in Flight Rescue: `@langchain/langgraph` 1.4.18, `langchain` 1.5.14, `@langchain/core` 1.2.13, `@langchain/anthropic` 1.5.11; plus `@langchain/langgraph-checkpoint-sqlite` 1.0.4 and `zod` 4 | Already running on this Mac; `interrupt(…, { responseSchema })` needs ≥ 1.4.16 |
| Branch | `feat/langgraph-engine`, from `feat/dump-watcher`; publishing to `public` is a separate step | User choice |

Rejected:

- **A new "Dump Doctor" from scratch:** it would rebuild v1 with less, diagnosis without the repair.
- **v2 replacing v1, or a new repo:** the user chose both engines in one repo.
- **"Agent in a box"** (one `createAgent` step with v1's playbook and 12 tools): the retry loop would stay a request in the prompt, so there would be little new to show.
- **Scripted evidence without an agent:** case 2 stops deep in SAP code, and v1's agent found the Z annotation by reading SAP source as it went.
- **`@langchain/mcp-adapters`:** see Tools above.
- **Studio live on stage:** the graph would run on the LangGraph dev server, a second process with more moving parts.

## 3. Verified facts (2026-10-08 and 2026-10-09)

- **v1 baseline** (`feat/dump-watcher`, `3c3a758`): `npm test` passes 56 tests. `createWatcher` (`core.mjs`, lines 251–499) holds the queue, the `status.json` state machine, tokens, expiry and startup recovery. `AGENT_MODEL` was never set, so v1's rehearsals used Claude Code's default model, which the log doesn't record.
- **Source hashes:** `sourceHash` (`core.mjs`) uses vsp's canonical form (CRLF → LF, trailing newlines dropped), and `resetLab` already compares SAP's hash after each write with it, so the fix's hash recognizes our fix in SAP. `WriteSource` takes `expected_source_hash` and fails with `SOURCE_DRIFT`; v1's `apply` passes it, v1's `restore` doesn't (`core.mjs`, lines 436 and 458).
- **vsp writes** (vibing-steampunk source at `a2ddb8a`, 2026-10-03, and the deployed tools' own descriptions): the `UpdateClassInclude` tool takes no hash. `WriteSource` with `include: "testclasses"` locks the class, checks `expected_source_hash` against the include while it holds the lock, writes, unlocks and activates the class (`pkg/adt/class_include_write.go`, `pkg/adt/source_hash.go`). `WriteSource` and `Activate` fail closed: an activation that doesn't succeed comes back as a tool error, which `vsp.mjs` throws (`internal/mcp/handlers_source.go`, `handlers_devtools.go`). Source reads, including vsp's own check after a write, are plain GETs without a version, so a matching hash shows the saved text, not necessarily the active code. None of this is tried live yet; the first probe (section 9) does that.
- **This Mac:** Node 26.8.2, npm 11.19.1, Claude Code 2.1.295 (v1's spec was checked with 2.1.285).
- **npm, 2026-10-09:** latest `@langchain/langgraph` 1.4.21, `langchain` 1.5.16, `@langchain/core` 1.2.17, `@langchain/anthropic` 1.5.12, `@langchain/mcp-adapters` 2.0.1 (released 2026-10-06), `@langchain/langgraph-checkpoint-sqlite` 1.0.4 (2026-08-19; depends on `better-sqlite3` ^12.10.0), `@langchain/langgraph-cli` 1.5.2, `langsmith` 0.10.8.
- **Flight Rescue** runs `@langchain/langgraph` 1.4.18, `langchain` 1.5.14, `@langchain/core` 1.2.13 and `@langchain/anthropic` 1.5.11, through `@cap-js/agents` 0.9.7.
- **Probe on this Mac** (scratchpad, Node 26.8.2):
  - `better-sqlite3` 12.11.1 installed from a prebuilt binary. npm 11.19 warns that its install script isn't covered by `allowScripts` yet.
  - `SqliteSaver.fromConnString` worked. A graph paused at `interrupt()`; `getState` showed `next: ['ask']` with one interrupt.
  - A new graph instance with a new saver on the same file resumed it with `new Command({ resume })`: a simulated restart.
- **LangGraph.js docs** (docs.langchain.com, read 2026-10-08):
  - `interrupt(value)` pauses the graph; `graph.invoke(new Command({ resume }), { configurable: { thread_id } })` resumes it. A checkpointer and the same `thread_id` are required.
  - On resume, the paused node runs again from its start, so side effects before `interrupt()` must be idempotent or live in another node.
  - `interrupt(value, { responseSchema })` validates the resume value with zod. It is present in 1.4.18 (`dist/interrupt.d.ts`).
  - Durability modes are `"exit"`, `"async"` and `"sync"`; `"sync"` saves before the next step starts.
  - A failed node runs again on resume; nodes that finished in the same step don't.
  - `graph.getState(config)` returns `values`, `next` and `tasks[].interrupts`.
- **LangChain, checked in the installed packages (2026-10-09):** `createAgent` uses native structured output only when the model's profile says so. `@langchain/anthropic` 1.5.11 has no profile for `claude-opus-5-5` or `claude-sonnet-5-5`, so it falls back to a tool strategy with `tool_choice: "any"`. `withStructuredOutput` defaults to a forced tool call. Current Claude models reject forced tool calls. v2 therefore passes `providerStrategy(...)` explicitly and calls `withStructuredOutput(…, { method: 'jsonSchema' })`; both send `output_config.format`. The result arrives as `structuredResponse`.
- **Model (2026-10-09):** Claude Code 2.1.295 uses `claude-opus-5-5` by default (its `init` event). `AGENT_MODEL=claude-opus-5-5` pins it for both engines.
- **First probe (2026-10-09):** on the test include of `ZCL_DL_PRICING`, with a harmless `ltc_probe` class appended by `UpdateClassInclude` (saved, not activated): (1) a plain `GetSource` shows the SAVED text; (2) `GetInactiveObjects` lists the class; (3) `RunUnitTests` while the include is only saved: `ltc_probe` did not run, so test runs use the active code; (4) after `Activate` the class is no longer listed; (4b) `RunUnitTests` then runs `ltc_probe`; (5) `Activate` on an active object succeeds with the message "Nothing to activate: the object has no inactive version"; (6) `WriteSource` with a stale `expected_source_hash` is refused with `SOURCE_DRIFT`; (6b) the include is unchanged after that refusal; (7) `WriteSource` with the current hash writes the baseline back; (8) after that `WriteSource` the class is not listed as inactive, because vsp activates; (9) `GetRevisions` dates are ISO 8601 UTC with a `Z` (`2026-10-03T10:05:39Z`). The probe ended with `reset`: "lab reset to its broken baseline; open proposals cancelled", every read-back matched.
- **No revision history for CDS views (2026-10-09):** on A4H, vsp's `GetRevisions` for `DDLS ZC_DL_ORDER` answers 404 "No suitable resource found" at `/sap/bc/adt/ddic/ddl/sources/ZC_DL_ORDER/source/main/versions`. `readTarget` treats a 404 as "no history", logs it and skips the after-the-dump check. Any other error still ends the analysis with "Couldn't analyze". The write rule still binds the fix to the version read.

## 4. Architecture

```
watcher.mjs     trace stream · ntfy · page server · timers · CLI --engine       shared
core.mjs        createWatcher: intake, dedupe, queue, polling, tokens, expiry   shared
                checks: summarizeDump, forbiddenReason, checkTestContract,     shared
                  sourceHash, renderPage, store, resetLab
                SAP steps: writeFix, runContract, restoreOriginal              shared, moved out of apply/restore
                claudeEngine: claude -p, buildProposal, apply → verify →        v1, moved, same behavior
                  restore
graph.mjs       langgraphEngine: the graph and the 7 read tools                 v2, new
prompts/        investigate.md · draft-test.md · draft-fix.md                   v2, split from agent/dump-repair.md
langgraph.json  points Studio at the graph                                      v2, new
```

### Engine interface

The engines differ only behind three calls:

| Call | When | v1 | v2 |
|---|---|---|---|
| `analyze(item)` | A dump leaves the queue while the watcher is idle | `claude -p`, then `buildProposal` | Starts a thread and runs it until a pause or the end |
| `decide(action, proposal)` | After the shared code has used the token and recorded the decision (section 6): `approve`, `reject`, `works`, `broken`, `expire` | Today's `decide` without the token check, then `apply` or `restore` | Resumes the thread with `new Command({ resume: action })` |
| `recover()` | Startup | Today's `recoverOnStartup` | Section 6 |

Everything else is shared: finding dumps, the queue and its duplicate counters, the one-open-proposal rule, the page, the single-use tokens and the expiry timer. `analyze <dump-id>` calls the engine in rehearsal mode, with no notification and no proposal page, as in v1; v2 stops before `propose`.

### SAP steps

Both engines call the same three functions, taken out of today's `apply` and `restore`:

- `writeFix`: `WriteSource` with `expected_source_hash`, unchanged;
- `runContract`: `RunUnitTests` followed by `checkTestContract`, unchanged;
- `restoreOriginal`: now follows the write rule of section 6, replacing only the fix's hash, then reads back and compares as today. Today's restore writes without a precondition, so an edit made during the hour-long re-click wait, or by another watcher, would be overwritten. The check changes v1 only in that case.

The engines therefore differ in how the steps are wired together, not in how they touch SAP. v1's 56 tests guard the move.

### State

`status.json` and `proposals/` stay the shared lock and the page's data for both engines. v2 adds `state/graph.sqlite`, which is gitignored with the rest of `state/`. Each proposal has one thread: the thread id is the proposal id, created when the dump leaves the queue and stored in `status.json` from the `analyzing` state on.

## 5. The graph

```
analyze() → investigate
              ├─ data_fix / unsure ──────────────────────────────→ report → END
              └─ code_fix → readTarget ─ outside lab / changed ───→ report
                              ├─ CLAS → draftTest ⇄ runTests   (≤ 3, failure fed back)
                              │            └─ contract holds ─┐
                              └─ DDLS ────────────────────────┤
                                       draftFix ⇄ checkFix   (≤ 2, problem fed back)
                                          └─ ok → propose → ⏸ approve ─ reject / expire → close
                                                               └─ approve → checkStale ─ stale → close
                                                                              └─ write
                                                                                   ├─ CLAS → verify ─ pass → close
                                                                                   │           └─ fail → restore → close
                                                                                   └─ DDLS → announceApplied → ⏸ reclick
                                                                                               ├─ works / expire → close
                                                                                               └─ broken → restore → close
```

After the last allowed attempt, both loops go to `report` with the verdict `unsure` and the reason.

### Steps

| Step | Kind | What it does | Next |
|---|---|---|---|
| `investigate` | model, agent | `createAgent` with the 7 read tools; returns an `Investigation` | `code_fix` → `readTarget`; otherwise `report` |
| `readTarget` | code | `SearchObject`: the object is in `$ZDUMP_LAB`. `GetSource` with `include_hash`: the version the proposal is bound to. `GetRevisions`: a change after `dumpAt` means `already_changed`. For a class, also the test include and its hash; an include that already holds `ltc_dump_repro` (left by an earlier analysis, a rejection or a rehearsal) means "reset required" | Class → `draftTest`; CDS view → `draftFix`; any problem → `report` |
| `draftTest` | model, one call | Only the class `ltc_dump_repro` (definition and implementation) with one test method. Sees the previous attempt's contract failure | `runTests` |
| `runTests` | code | Builds the test include: the original include from `readTarget`, byte for byte, followed by the draft. Writes it by the write rule (section 6) with `WriteSource` and `include: "testclasses"`, which also activates the class; then `runContract('before')`. Records the written include's hash as `testWritten`, and on success also as `testHash` | Pass → `draftFix`; fail on attempt 1 or 2 → `draftTest`; fail on attempt 3, or a test include changed by somebody else → `report` |
| `draftFix` | model, one call | The complete fixed source and why this fix. Sees the previous attempt's problem | `checkFix` |
| `checkFix` | code | `forbiddenReason`; `SyntaxCheck`; the source hash still equals the bound hash | Pass → `propose`; a changed hash → `report`; another failure on attempt 1 → `draftFix`; on attempt 2 → `report` |
| `propose` | code | `diff -u`, the proposal file (v1's shape), token, ntfy with priority high; status `awaiting_decision` | `approve` |
| `approve` | pause | Only `interrupt()`; the resume value is `approve`, `reject` or `expire` | `checkStale`, or `close` |
| `checkStale` | code | As v1: the test include and the source still have their recorded hashes; status `applying` | `write`, or `close` (stale, nothing written) |
| `write` | code | `writeFix` by the write rule (section 6) | Class → `verify`; CDS view → `announceApplied`; `SOURCE_DRIFT` → `close` (stale); another failed write → `restore`, as in v1 |
| `verify` | code | `runContract('after')` | Pass → `close` (fixed); fail → `restore` |
| `announceApplied` | code | New token; ntfy "Applied: open the value help to confirm"; status `awaiting_reclick` | `reclick` |
| `reclick` | pause | Only `interrupt()`; the resume value is `works`, `broken` or `expire` | `close`, or `restore` |
| `restore` | code | `restoreOriginal` | `close` (reverted, or `recovery_required`) |
| `report` | code | Informational proposal without an Approve button; ntfy | END |
| `close` | code | Final proposal status and message; ntfy | END |

`report` and `close` don't change `status.json`. Only after the thread's last checkpoint does the engine mark the dump seen and set `idle` (or `recovery_required`). Until then a restart finds an unfinished thread and finishes it, so the final notification can repeat once but is never lost, and the dump is never analyzed twice. When the status becomes `idle`, the shared code starts the next dump in the queue, as in v1.

### State

| Fields | Set by | Content |
|---|---|---|
| `id`, `dumpId`, `dumpAt`, `key`, `count`, `title`, `runtimeError`, `summary` | `analyze(item)`, as the thread's input | Proposal and thread id; the dump's id, time (for `readTarget`'s revision check) and key; the duplicate counter; the title and runtime error for the proposal; the `summarizeDump` text. The full dump detail stays out of the graph state, so it is neither checkpointed nor traced |
| `investigation` | `investigate` | The `Investigation` |
| `original`, `tests` | `readTarget` | `{ source, hash }` of the target object, and of its test include |
| `testDraft`, `testAttempts`, `testProblem`, `testWritten` | `draftTest`, `runTests` | The latest draft, the attempts so far, the last contract failure, the hash of the include this thread wrote last |
| `testHash` | `runTests` | The test include's hash after the contract held |
| `fix`, `fixAttempts`, `fixProblem` | `draftFix`, `checkFix` | `{ source, rationale }`, the attempts so far, the last problem |
| `decision` | `approve`, `reclick` | The resume value |
| `outcome` | `checkStale`, `write`, `verify`, `restore`, `close`, `report` | The final status and message |

### Model outputs (zod)

```
Investigation  { verdict: code_fix | data_fix | unsure, cause: string, max 120 characters,
                 explanation: string, object?: { type: CLAS | DDLS, name: string },
                 data_action?: string, confidence: high | medium | low }
TestDraft      { source: string (only the class ltc_dump_repro), method: string }
FixDraft       { source: string (the complete main source or DDL source), rationale: string }
```

`already_changed` is decided by `readTarget`, not by the model. The rules across fields (`object` for a `code_fix`, `data_action` for a `data_fix`) are checked in code and turn the result into `unsure`, as `validateResult` does in v1.

### Prompts

`agent/dump-repair.md` splits into three files:

- `prompts/investigate.md`: the warnings about the dump summary, finding the cause (including dumps that stop in SAP code), and classifying it;
- `prompts/draft-test.md`: the test rules (only the class `ltc_dump_repro`, which code appends to the existing include; `cl_osql_test_environment` for lab tables; the expected "runtime abortion" failure);
- `prompts/draft-fix.md`: the rules (the smallest fix, no catch-all handler, keep `RAISE SHORTDUMP` and `MESSAGE … TYPE 'X'`, no early return without a reason).

The playbook's step 3 (later changes) and the tool mechanics (writing and activating the test include, `RunUnitTests`, `SyntaxCheck`) move into code.

### Limits

- `investigate`: a recursion limit of 50 (about 25 tool calls; v1's agent needed about 10) and v1's 5-minute timeout. A timeout ends the thread with "Couldn't analyze", as in v1.
- `draftTest` and `runTests`: 3 attempts. `draftFix` and `checkFix`: 2 attempts.

The page doesn't change. The proposal file keeps v1's shape, and its `explanation` is the investigation's explanation followed by the fix's rationale.

## 6. Pauses, crashes and restarts

- **Checkpoints:** `SqliteSaver` in `state/graph.sqlite`; every run uses `durability: "sync"`.
- **Decisions are saved before they are delivered.** The shared code deletes the token and writes `pending: { action, pause }` to the proposal in the same save; `pause` is the status the decision answers (`awaiting_decision` or `awaiting_reclick`). Only then does it call `decide`. Otherwise a crash before the thread saves its resume would lose the decision: the token would be gone, and after "Still broken" the fix would stay in SAP.
- **Resume:** `decide` calls `graph.invoke(new Command({ resume: action }), { configurable: { thread_id: id } })`. `approve` calls `interrupt(…, { responseSchema: z.enum(['approve', 'reject', 'expire']) })`, and `reclick` the same with `works`, `broken` and `expire`. The resume value is the bare string that the enum checks. A double tap can't resume twice, because the shared token works only once.
- **Expiry:** after an hour, the shared timer deletes the token, records `pending` with `expire` in the same way and calls `decide('expire', proposal)`.

### One rule for every SAP write

Before each write, code reads the current hash:

| Write | Replaces only | Writes | Anything else |
|---|---|---|---|
| Test include (`runTests`) | The include `readTarget` read, or this thread's previous attempt (`testWritten`) | The original include followed by this draft | `report`, nothing written |
| Fix (`write`) | The original | The fix | `recovery_required` |
| Restore (`restore`) | The fix | The original | `recovery_required` |

If SAP already holds what the step would write, an earlier run wrote it, and the step skips the write. If SAP holds the hash in "Replaces only", the step writes with that hash as `expected_source_hash`. vsp checks it again while it holds the lock, so an edit that lands between the read and the write makes vsp refuse the write instead of overwriting the edit.

**Saved is not active.** vsp saves, unlocks and only then activates. A crash or a failed activation can therefore leave the target text saved but inactive, and a source read can't tell the two apart. A `WriteSource` that returned normally has done both. A step that skips its write calls `Activate` and reads the source again before it goes on. Both must succeed and the read must still match; otherwise the fix and the restore end in `recovery_required`, and the test include counts as a failed attempt. Until this holds, no step runs the tests or sends "Fixed", "Applied" or "Reverted".

**One activation covers the whole class.** Writing the test include activates the main source too, and the other way round. A saved, inactive edit by somebody else would therefore go live with our write. So:
- `readTarget` stops with `report` when `GetInactiveObjects` lists the object;
- before the test include is written, the main source must still hash to the original;
- before the fix is written, the test include must still hash to the approved one, or the thread ends in `recovery_required`;
- before the restore, the same holds for the test include, or the class is left alone with `recovery_required`.

Each check runs again when a step is replayed after a crash. The checks are a safety net, not support for concurrent editing. Their limits:
- `GetInactiveObjects` lists only the current SAP user's inactive objects, so another user's inactive edit goes unnoticed;
- the repeated checks cover the main source and the test include, but not a class's other includes (local definitions, implementations, macros);
- an edit saved between the inactive-object check and the source read becomes the analysis's baseline, and a later write activates it;
- each check and its write are two calls, and vsp offers no lock across them.

A run therefore needs exclusive access to its target objects (section 11). Concurrent editing is not supported.

v1 marks a dump seen before it saves and announces the proposal, as it always did. A crash can lose that announcement, but never analyzes the dump twice.

### Every step is safe to run twice

A crash makes the unfinished step run again from its start, and a pause step runs again when it resumes:

| Step | Why running it twice is safe |
|---|---|
| `approve`, `reclick` | They contain only `interrupt()` |
| `propose`, `announceApplied` | They reuse the proposal file and the token if they exist. A crash right after the push can repeat the push once |
| `runTests` | The write rule skips the write if this include is already in SAP, activates it, and the tests run again |
| `write`, `restore` | The write rule skips the write if the fix, or the original, is already in SAP, and activates it |
| `verify` | It reruns the tests |
| Model steps | They only read; a rerun asks the model again |
| `report`, `close` | They can repeat their push once |

`checkStale` runs as its own step before `write`, so a normal stale proposal is caught there and nothing is written. In `write`, a hash that is neither the original nor the fix can only come from an interrupted or failed write, or from an edit in the moment between the two steps; both end in `recovery_required`, which is conservative. In `restore`, such a hash means somebody else changed the object after our fix, for example during the re-click wait. Restoring would overwrite their change, so it ends in `recovery_required` too. For the test include, such a hash means somebody edited it after `readTarget` or between attempts; the thread stops with a report.

### Restart

An analysis that throws, in either engine, ends with "Couldn't analyze". The shared code first saves the status `failed` with the dump id and the message, then sends the message, marks the dump seen and sets `idle`. A restart that finds `failed` sends the message again and finishes the same way, so the message can repeat once but is never lost, and the dump is never analyzed again. A `recover()` that throws while the status is `analyzing` ends the same way, so a v2 step that throws again after a restart is reported like one that threw the first time.

`recover()` looks at the thread named in `status.json`:

- no checkpoint yet: nothing has happened, so the status becomes `idle` and the unseen dump is analyzed again;
- any checkpoint: the thread owns its dump, which is marked seen;
- ended, but not yet recorded: mark the dump seen and set the outcome's status;
- paused at `approve` or `reclick` with a `pending` decision for that pause: resume with it, as `decide` would have;
- paused with no `pending` decision for that pause: nothing to do; the page and the token still work;
- stopped in any other step: `graph.invoke(null, config)` continues from the last finished step, and model answers that were already saved aren't requested again.

Each pause happens at most once per thread, so a decision recorded for `approve` can never reach `reclick`. If the thread had already saved the resume, it is no longer paused there and the record is ignored.

For comparison, v1 turns `applying` into `recovery_required` and analyzes an `analyzing` dump again from the start. It reads `pending` only for "Still broken": if one is still unresolved at startup, it becomes `recovery_required`. Using the token and setting `applying` are two file writes, and a crash can fall between them. An Approve lost to a crash expires with nothing written.

- **`recovery_required`** blocks every SAP write until `reset`, as in v1.
- **`reset`** also deletes `state/graph.sqlite`. It still runs only while the watcher is stopped.

## 7. Model, keys and observability

- **Model:** `ChatAnthropic` with `AGENT_MODEL`; v1 gets the same value as `--model`. The first task finds which model Claude Code 2.1.295 uses by default (the `init` event of its stream names it) and pins that one.
- **Keys:** v2 takes `ANTHROPIC_API_KEY` and, optionally, `LANGSMITH_API_KEY` from its environment or the gitignored `.env`, and passes neither to v1's Claude Code. Every v2 run is billed to the API key, unlike v1, which runs on the Claude Code sign-in.
- **LangSmith:** `LANGSMITH_TRACING=true`, `LANGSMITH_PROJECT=dump-watcher` and `LANGSMITH_API_KEY`. The user creates the free account and the key. Without the key, tracing is off and v2 still works.
- **Terminal:** one line per finished step (`streamMode: "updates"`) and one line per tool call of the investigation, like v1's `agent → GetSource …` lines.
- **Studio:** `langgraph.json` points at the graph, so `npx @langchain/langgraph-cli dev` opens it for screenshots. Runs started there use the real lab.
- **Diagram:** a script writes `docs/graph.md` from the compiled graph (`getGraph().drawMermaid()`), so the diagram in the README can't drift from the code.

## 8. Guardrails (changes from v1)

- **The model has no write tools.** It gets exactly 7 read tools: `GetSource`, `GetClassInclude`, `GetRevisions`, `GetRevisionSource`, `GrepObject`, `SearchObject` and `GetCDSDependencies`. v2 doesn't use `agent/settings.json` or `agent/lab-guard.mjs`; v1 still does.
- **Code writes only three things,** each by the write rule of section 6: the test include of the target class (the original include plus `ltc_dump_repro`), after `readTarget` confirmed `$ZDUMP_LAB`; the approved fix; and the restored original.
- **The vsp sandbox doesn't change:** `vsp-lab` limits writes to `$ZDUMP_LAB` on the server and blocks free SQL, deletes and transports, for both engines.
- **Data sent outside:** as in v1 (ntfy sees the title and the cause; Anthropic sees the dump summary and every source the investigation reads, which for case 2 includes SAP standard code), plus LangSmith, which sees the same and every step's input and output. The LangSmith project stays private (section 10).
- **The approval page, its tokens and the Tailscale-only listener** don't change; they are shared.

## 9. Testing

### Offline

`npm test` (`node:test`, no key, no network):

- v1's 56 tests pass after the move into `claudeEngine`.
- The engine-independent scenarios of `flow.test.mjs` run against both engines, with the same `fakeSap` and, for v2, a scripted fake model: duplicates and the queue; approve applies exactly the reviewed fix; a double tap writes once; stale tests or source; a verified restore after failing tests; a failed or unverifiable restore → `recovery_required`; "Still broken" after somebody else edited the object → `recovery_required`, nothing written; a restore that finds the original already back writes nothing; the CDS re-click, both "Works" and "Still broken"; reject; reset.
- v1: an unresolved "Still broken" `pending` at startup → `recovery_required`.
- v2 only:
  - the test loop stops after 3 attempts and the fix loop after 2, and each retry sees the previous failure;
  - the model is given exactly the 7 read tools;
  - `write` writes for the original hash, skips for the fixed hash, and ends in `recovery_required` for any other;
  - an `Investigation` without `object` for a `code_fix`, or without `data_action` for a `data_fix`, becomes `unsure`;
  - the test include that `runTests` writes is the original include, byte for byte, followed by the draft. If somebody else changed the include, after `readTarget` or between attempts, the thread stops with a report and writes nothing;
  - an include that already holds `ltc_dump_repro` ends in a "reset required" report with nothing written, both after a repeated `analyze` and after Reject followed by a fresh dump;
  - the fake SAP keeps saved and active versions apart, and its test run reports `ltc_dump_repro` only while the active include holds it; the contract check fails while that test is missing or only saved. Its `WriteSource` can stop after saving and before activating (a promise that never settles, as when the watcher dies mid-call), or fail to activate. After a restart, no step runs the tests or sends "Fixed", "Applied" or "Reverted" until `Activate` succeeded and the read matched; a failed activation ends the fix and the restore in `recovery_required`;
  - **crash equivalence** (the GeoTrack lesson: N small runs through the persisted state must equal one run). A shared hook `await crash(point)` sits right after each effect that no checkpoint covers yet: `decision` (token used, `pending` saved), `testInclude`, `writeFix`, `restoreOriginal`, `beforePush` (local saves done, notification not sent), `push` and `threadEnd` (last checkpoint written, status not yet recorded). Live, `CRASH_AFTER=<point>` makes it SIGKILL the process. In tests it returns a promise that never settles, so the flow stops right there, as after SIGKILL: no catch block, cleanup or later step runs. A thrown error would not do, because application handlers catch it; v1's `apply` would restore the original. Each test checks that the fakes recorded nothing after the injection, then restarts: a new watcher and graph over the same state files and the same fake SAP, then `recover()`. Two sets of runs: one stopped after every step, one crashed at every hook point on every path that reaches it. The paths include one where `draftFix` throws after the test include was written. Every run must end with the same final status, set of proposals, seen dumps and SAP sources as an uninterrupted run, and must have sent every notification the uninterrupted run sent. Calls may repeat only where section 6 allows it (the tests rerun, one repeated push), and no write may land on a source whose hash isn't the expected one. Identical call sequences are not required, since they would fail those allowed repeats.

### Live

On A4H, in the same lab:

- `node watcher.mjs --engine langgraph analyze <dump-id>` on each case until the results are stable.
- **Rehearsals:** v1's definition of done (section 9 of the v1 spec), unchanged: every case passes 3 rehearsals in a row with `--engine langgraph`, each starting with `reset` and a fresh watcher, with the same timing targets. They are logged in `docs/rehearsal-log.md` under a v2 heading.
- **First probe,** before any v2 code writes to SAP, on the lab's test include, followed by `reset`: save a change with `UpdateClassInclude`, which doesn't activate, and check what `GetSource`, `GetInactiveObjects` and `RunUnitTests` see; `Activate` on an object that is already active; `WriteSource` with `include: "testclasses"` and a wrong, then the right `expected_source_hash`. The results go into section 3. The probe and a `reset` whose read-back passes come before any other live v2 work.
- **Crash rehearsals,** once each:
  1. `kill -9` the watcher while the investigation runs, then restart it: the analysis completes and the proposal arrives.
  2. Start with `CRASH_AFTER=writeFix`: the process kills itself with SIGKILL right after the fix is written, before the graph saves the step. After a restart, `write` finds the fixed hash, skips the write, `verify` runs and the phone shows "Fixed ✅". The same switch on v1 ends in `recovery_required`, as v1's spec says.
  3. Case 2 with `CRASH_AFTER=decision`, tapping "Still broken": after a restart, the thread resumes with `broken` and the original is restored.
  4. Case 2 with `CRASH_AFTER=restoreOriginal`, tapping "Still broken": after a restart, `restore` finds the original, writes nothing, and the phone shows "Reverted".

`crash(point)` lives in the shared code, so the switch works for both engines.

## 10. Comparison and write-up

Both engines rehearse again with the pinned model, 3 runs per case each. The model is then the same, but prompts, tools and the agent loop are not, so the README presents the table as a comparison of these two implementations, not of LangGraph against Claude Code. v1's rows from 2026-10-01 and 2026-10-02 stay in the log as history.

| Column | Source |
|---|---|
| Detected after (s) | Watcher log; shared code, so expected to be equal |
| Notification after detection (s) | Watcher log |
| Approve → result (s) | Watcher log |
| Model calls, tokens and cost per case | v2: LangSmith. v1: the `result` event of Claude Code's stream, which v1 starts logging |
| Attempts until the test reproduced the dump | v2: `testAttempts`. v1: the `RunUnitTests` calls in the agent's stream |
| Kill right after the write | Crash rehearsal 2, on both engines |
| Orchestration size (lines) | `claudeEngine` plus the playbook, against `graph.mjs` plus the prompts |

The README gets a "Two engines" section: how to run each engine, the generated diagram, what moved from the prompt into code, the table and trace screenshots. Nothing goes into the table unless it was measured. The README's opening claim "Nothing changes in SAP without that tap" becomes "The fix is applied only after that tap", because both engines write the test include before it.

**Traces stay private.** A trace holds every source the investigation read, which is SAP standard code for case 2, and the dump summary, which holds the user, times and variable values. No run gets a public link. The README shows screenshots instead, each checked before it is published. A screenshot may show the graph, step names, timings, token counts and lab code. It may not show SAP standard source, the dump summary or hostnames.

## 11. Runbook additions

- **One-time:** `npm install`; create the LangSmith account and put `LANGSMITH_API_KEY` in the environment or in `.env`; set `AGENT_MODEL` in `.env`.
- **Start v2:** `node watcher.mjs --engine langgraph`, with the keys in the environment or in the gitignored `.env`. The rest of v1's runbook applies unchanged.
- **Exclusive access, for every run:** verify the reset (its read-back must match) and run exactly one watcher. From the trigger until the run has ended, no person or other process edits any part of the target objects. That includes the wait for a decision or a re-click, and crash recovery.
- **Between analyses of the same class:** `reset`, as every rehearsal already starts. v2 refuses to analyze while `ltc_dump_repro` is in the test include.

## 12. Out of scope

- Other model providers, including SAP AI Core through `@sap-ai-sdk/langchain`.
- `@langchain/mcp-adapters`.
- Studio on stage.
- The read-only "Dump Doctor" for dumps outside the lab.
- New dump cases, the BTP ABAP Cloud variant, and running on the VPS.
- Publishing to the `public` branch, and the LinkedIn post.
- Other v1 changes. v1 keeps its prompt rule for the existing tests, and the README says so. Its behavior changes in only two places: `restoreOriginal`'s ownership check, and an unresolved "Still broken" at startup becoming `recovery_required`.

## 13. Risks

- **Model results vary from run to run,** as in v1. Mitigation: retries that carry the exact failure, 3 clean rehearsals per case, and a recorded backup.
- **The investigation can't run tests.** v1's agent could read, test and read again; v2's investigation only reads. For a class, a wrong cause shows up as a contract that never holds, which `draftTest` retries; for a CDS view, only at the re-click. Mitigation: the case 2 rehearsals.
- **API cost:** every v2 run is billed, and the table reports it.
- **`better-sqlite3` is a native module.** It installed from a prebuilt binary on Node 26.8.2. A newer npm may need `npm install-scripts approve better-sqlite3` (npm 11.19 already warns).
- **Two checkouts, one lab.** When v1 and v2 run from two checkouts (for example a git worktree), each has its own `state/` and `watcher.pid`, so nothing stops both watchers from writing to the lab at the same time. Run one at a time.
- **Two stores** (`status.json` and the checkpoints) can disagree after a crash between their writes. `recover()` follows the checkpoint of the thread named in `status.json`. The status turns `idle` or `recovery_required` only after the thread has ended, so an unfinished thread is always found again (section 5). The crash-equivalence test covers every step boundary and every `crash` point.
- **Saved versus active is inferred from vsp's code,** not yet seen live. The first probe shows what a plain read returns while an inactive version exists; until then, the "saved is not active" rule assumes the worst case.
