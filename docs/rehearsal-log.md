# Rehearsal log

Pass criteria: spec section 9. Times come from `state/watcher.log`; "detected" is measured from the dump's own timestamp.

| Date | Run | Case | Verdict | Detected after (s) | Notification after detection (s) | Approve → result (s) | Result | Notes |
|---|---|---|---|---|---|---|---|---|
| 2026-10-01 | A | 2 | code_fix (DDLS) | 22 | 46 | – | ✅ confirmed by re-click | Exploratory, before the polling fix. Case 2 fired when the app opened, ahead of case 1 |
| 2026-10-01 | A | 1 | code_fix (CLAS) | 69 (queued behind case 2) | 58 | < 20 | ✅ Fixed, Recalculate works | Exploratory |
| 2026-10-02 | 1 | 2 | code_fix (DDLS) | 331 | 38 | 16 | ❌ not counted (timing) | Flow passed (Applied → value help opens → Works ✅), but the watcher had died with my previous session at 00:20 and picked the dump up only when restarted |
| 2026-10-02 | 1 | 1 | code_fix (CLAS) | 19 | 54 | 6 | ✅ Fixed, tests pass, Recalculate works | Trace line 3 s after the dump |
| 2026-10-02 | 1 | 3 | data_fix | 15 | 20 | – | ✅ names ZDL_CONFIG and XYZ, no Approve button | No SAP write: the class's last revisions (09:27:25 tests, 09:28:57 main) predate the dump at 09:38:32; the agent can't write DDLS |
| 2026-10-02 | 2 | 2 | code_fix (DDLS) | 10 | 41 | 6 | ✅ confirmed by re-click | |
| 2026-10-02 | 2 | 1 | code_fix (CLAS) | 8 | 48 | 2 | ✅ Fixed, tests pass, Recalculate works | Approve arrived twice (double tap); the second got "no longer open" and wrote nothing |
| 2026-10-02 | 2 | 3 | data_fix | 7 | 18 | – | ✅ names ZDL_CONFIG and XYZ, no Approve button | No SAP write: last revisions 13:07:46 (tests) and 13:13:40 (main) predate the dump at 13:14:36 |
| 2026-10-02 | 3 | 2 | code_fix (DDLS) | 9 | 38 | 3 | ✅ confirmed by re-click | |
| 2026-10-02 | 3 | 1 | code_fix (CLAS) | 8 | 45 | 2 | ✅ Fixed, tests pass, Recalculate works | |
| 2026-10-02 | 3 | 3 | data_fix | 7 | 19 | – | ✅ names ZDL_CONFIG and XYZ, no Approve button | No SAP write: last revisions 13:21:27 (tests) and 13:22:57 (main) predate the dump at 13:23:24 |
| 2026-10-02 | 4 | 2 | – | – | – | – | ⚠️ void | STZAC had set the system time zone to CET while the server clock runs UTC. SNAP saved the dump, but SAP's ADT dump index (SNAP_ADT) skipped it, so the feed (and Eclipse) never listed it, and older dumps showed 2 h early. Once STZAC was back on UTC, the dump appeared at 14:00:27Z; it was marked handled before the rerun |
| 2026-10-02 | 4 (retry) | 2 | code_fix (DDLS) | 7 | 34 | 5 | ✅ confirmed by re-click | ntfy accepted the push at 14:18:00, but the phone's ntfy app showed it only after a restart (stale app connection). Added a preflight to the runbook: quit and reopen ntfy, then send a test notification |

**Result:** every case passed 3 runs in a row: cases 1 and 3 in runs 1–3, and case 2 in runs 2, 3 and 4 (retry). Ruling: the void attempt of run 4 doesn't break case 2's streak, because an STZAC change outside the system caused it.

## v2: LangGraph engine

Model: `claude-opus-5-5`. Same pass criteria and timing targets as above (v1 spec section 9). "Model calls · tokens · cost" comes from the run's LangSmith trace; "Test attempts" from the `graph: draftTest` lines in the watcher log.

| Date | Run | Case | Verdict | Detected after (s) | Notification after detection (s) | Approve → result (s) | Model calls · tokens · cost | Test attempts | Result | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-10-09 | 1 | 2 | code_fix (DDLS) | 12 | 19 | 6 | 4 · 79,664 · $0.34 | – | ✅ confirmed by re-click | Value help repointed to ZC_DL_CustomerVH. GetRevisions answers 404 for DDLS, so the revision check was skipped |
| 2026-10-09 | 1 | 1 | code_fix (CLAS) | 14 | 29 | 4 | 4 · 48,191 · $0.22 | 1 | ✅ Fixed, tests pass, Recalculate works | |
| 2026-10-09 | 1 | 3 | data_fix | 12 | 10 | – | 2 · 26,917 · $0.12 | – | ✅ names ZDL_CONFIG and XYZ, no Approve button | No SAP write: investigate → report |
| 2026-10-09 | 2 | 2 | code_fix (DDLS) | 14 | 21 | 11 | 4 · 71,884 · $0.31 | – | ✅ confirmed by re-click | |
| 2026-10-09 | 2 | 1 | code_fix (CLAS) | 16 | 24 | 3 | 4 · 48,291 · $0.23 | 1 | ✅ Fixed, tests pass, Recalculate works | |
| 2026-10-09 | 2 | 3 | data_fix | 13 | 8 | – | 2 · 27,103 · $0.12 | – | ✅ names ZDL_CONFIG and XYZ, no Approve button | No SAP write: investigate → report |
| 2026-10-09 | 3 | 2 | code_fix (DDLS) | 18 | 29 | 8 | 4 · 71,815 · $0.31 | – | ✅ confirmed by re-click | |
| 2026-10-09 | 3 | 1 | code_fix (CLAS) | 13 | 25 | 2 | 4 · 47,870 · $0.22 | 1 | ✅ Fixed, tests pass, Recalculate works | |
| 2026-10-09 | 3 | 3 | data_fix | 12 | 7 | – | 2 · 27,070 · $0.12 | – | ✅ names ZDL_CONFIG and XYZ, no Approve button | No SAP write: investigate → report |
| 2026-10-09 | crash-1 | 2 | code_fix (DDLS) | 16 | 41 | 6 | 3 · 54,067 · $0.24 | – | ✅ confirmed by re-click | `kill -9` at the first `agent →` line (16:38:19). After the restart: `recover: continuing at investigate`, same proposal id. The notification time includes the kill and the restart; the killed call's tokens are not in the trace |
| 2026-10-09 | crash-2 | 1 | code_fix (CLAS) | 10 | 31 | 15 | 4 · 48,280 · $0.23 | 1 | ✅ Fixed, tests pass | `CRASH_AFTER=writeFix` killed the watcher 1 s after Approve, with the status `applying`. After the restart: `recover: continuing at write`, then "Fixed ✅ Tests pass" 2 s later. Approve → result includes the kill and the restart |
| 2026-10-09 | crash-3 | 2 | code_fix (DDLS) | 14 | 18 | 7 | 4 · 71,856 · $0.31 | – | ✅ Reverted ❌ still broken after re-click | After "Applied", restarted with `CRASH_AFTER=decision`. "Still broken" was saved with the used token (`pending: broken`), then the watcher died. After the restart: `recover: delivering the saved decision "broken"`, restore, "Reverted ❌" 8 s later, no second tap |
| 2026-10-09 | crash-4 | 2 | code_fix (DDLS) | 13 | 19 | 8 | 4 · 71,881 · $0.31 | – | ✅ Reverted ❌ still broken after re-click | `CRASH_AFTER=restoreOriginal` killed the watcher right after the original was written back, with the status `applying`. After the restart: `recover: continuing at restore`, then "Reverted ❌" 7 s later. That the replay wrote nothing is not observable live, because A4H keeps no revision history for DDL sources; the offline tests cover it |

**Result:** every case passed 3 runs in a row (runs 1–3), and all four crash rehearsals recovered without a second tap. A run of all three cases costs about $0.65 in model calls (LangSmith).

## v1 with the pinned model

Model: `claude-opus-5-5`, passed as `--model`. Tokens and cost come from the `agent result:` log line. v1's runs from 2026-10-01 and 2026-10-02 above used Claude Code's default model and stay as history.

| Date | Run | Case | Verdict | Detected after (s) | Notification after detection (s) | Approve → result (s) | Agent turns · tokens · cost | Test runs by the agent | Result | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-10-09 | 1 | 2 | code_fix (DDLS) | 12 | 44 | 10 | 7 · 304,988 · $0.61 | – | ✅ confirmed by re-click | |
| 2026-10-09 | 1 | 1 | code_fix (CLAS) | 21 | 66 | 6 | 8 · 346,021 · $0.28 | 1 | ✅ Fixed, tests pass, Recalculate works | |
| 2026-10-09 | 1 | 3 | data_fix | 17 | 32 | – | 5 · 167,936 · $0.17 | – | ✅ names ZDL_CONFIG and XYZ, no Approve button | No SAP write: read tools only (GetSource, GetRevisions, GetTableContents) |
| 2026-10-09 | 2 | 2 | code_fix (DDLS) | 16 | 44 | 13 | 8 · 306,606 · $0.27 | – | ✅ confirmed by re-click | |
| 2026-10-09 | 2 | 1 | code_fix (CLAS) | 12 | 56 | 2 | 8 · 345,998 · $0.28 | 1 | ✅ Fixed, tests pass, Recalculate works | |
| 2026-10-09 | 2 | 3 | data_fix | 12 | 32 | – | 5 · 168,298 · $0.17 | – | ✅ names ZDL_CONFIG and XYZ, no Approve button | No SAP write: read tools only |
| 2026-10-09 | 3 | 2 | code_fix (DDLS) | 12 | 49 | 7 | 8 · 366,343 · $0.28 | – | ✅ confirmed by re-click | |
| 2026-10-09 | 3 | 1 | code_fix (CLAS) | 14 | 58 | 4 | 8 · 346,052 · $0.29 | 1 | ✅ Fixed, tests pass, Recalculate works | |
| 2026-10-09 | 3 | 3 | data_fix | 24 | 32 | – | 5 · 168,187 · $0.17 | – | ✅ names ZDL_CONFIG and XYZ, no Approve button | No SAP write: read tools only |
| 2026-10-09 | crash-2 | 1 | code_fix (CLAS) | 14 | 75 | – | 8 · 345,985 · $0.28 | 1 | ✅ recovery_required, as v1's spec says | `CRASH_AFTER=writeFix` killed the watcher 3 s after Approve, with the status `applying`. After the restart: "Recovery required: The watcher stopped while applying a fix. Run: node watcher.mjs reset". The fix stayed written; `reset` restored the baseline |

**Result:** every case passed 3 runs in a row (runs 1–3) with the pinned model.
