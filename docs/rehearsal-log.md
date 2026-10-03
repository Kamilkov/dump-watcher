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
