# dump-watcher

An AI agent that repairs ABAP short dumps, with a human on the Approve button.

A click in a Fiori app ends in a short dump. Within about a minute, your phone shows the cause, a unit test that reproduces the dump, and a proposed fix. Tap Approve and the watcher writes the fix, activates it and reruns the tests. Nothing changes in SAP without that tap.

This is a proof of concept for **lab and trial systems only**. It writes ABAP code after approval. Never point it at a system you care about.

## How it works

1. **Noticing a dump without polling.** The watcher runs `tail -F` over SSH on the work process traces (`dev_w*`). When the kernel logs `RABAX: level LEV_RX_ERROR_SAVE completed`, the watcher reads SAP's ADT dump feed every 2 s for up to a minute. A check every 5 minutes and a 24-hour catch-up at startup are the safety net.
2. **The agent.** For each new dump of the demo user, the watcher starts Claude Code in headless mode, with [`agent/dump-repair.md`](agent/dump-repair.md) as its playbook. The agent reads the code and its history, writes a unit test that reproduces the dump, drafts a fix and syntax-checks it. It never writes the fix itself.
3. **The checks.** The watcher, not the agent, verifies the proposal: the object is in the lab package, the fix is bound to the SHA-256 hash of the source the agent read, there's no catch-all handler or removed `RAISE SHORTDUMP`, and the test contract holds (the new test fails with the same runtime error, existing tests pass).
4. **The phone.** The watcher pushes a summary to a private [ntfy](https://ntfy.sh) topic. The link opens a proposal page that listens only on the Mac's Tailscale address. Approve and Reject carry a one-time token that expires after an hour.
5. **Apply and verify.** After Approve, the watcher writes the fix, activates it and reruns the tests. If they fail, it restores the old source and verifies the restore. A CDS fix has no unit test, so it waits for a human re-click in the app instead.

When the cause is data rather than code, the agent says so, and the phone shows the missing entry with no Approve button.

## Guardrails

- **One door to SAP:** the agent reaches SAP only through [vsp](https://github.com/oisee/vibing-steampunk), started with writes limited to `$ZDUMP_LAB`, free SQL blocked, and deletes and transport changes disabled (`.mcp.json`).
- **A short allow-list:** 12 tools (`agent/settings.json`); every other tool is denied (`--permission-mode dontAsk`).
- **A guard on every write:** a PreToolUse hook (`agent/lab-guard.mjs`) lets the agent write only the test-class include of a lab class and activate lab classes.
- **Hash binding, test contract and verified restore:** in `core.mjs`, covered by `npm test`.

## Requirements

- SAP ABAP Cloud Developer Trial (A4H) in Docker. The container name `a4h25` and the trace path are set in `watcher.mjs` (`TRACE_ARGS`).
- [vsp](https://github.com/oisee/vibing-steampunk) on the Docker host, configured with your SAP connection in `/root/.env`.
- An SSH alias `vps` in `~/.ssh/config` for the Docker host, with key login and rights to run `docker exec` and `vsp`.
- Node.js 22 or later, and [Claude Code](https://claude.com/claude-code) signed in on the machine that runs the watcher.
- The ntfy app on your phone, and Tailscale on both the phone and the machine that runs the watcher. Developed on macOS.

## Setup

1. `npm install`
2. `cp .env.example .env`, then set `NTFY_TOPIC` to a random name (`echo "dump-watcher-$(openssl rand -hex 6)"`) and subscribe to it in the ntfy app. The topic name is the only secret.
3. In SAP, create the local package `$ZDUMP_LAB` with the objects in `lab/`: the tables from `lab/tables.json`, the CDS views, behavior definitions, classes and the service definition. Add an OData V4 UI service binding `ZSB_DL_ORDER_O4` and publish it. Run `ZDL_SEED` once.
4. Create a user `DEMO` in SU01 as a copy of `DEVELOPER`. The watcher ignores dumps of other users.
5. `node watcher.mjs reset` puts the lab back to its broken baseline.

## Run

```bash
node watcher.mjs
```

Then open the binding's Fiori Elements preview in a private window as `DEMO` (log off any other session first). Opening the app triggers the value-help case, Recalculate on order 1 the code bug, and Recalculate on order 3 the data case.

Other commands: `node watcher.mjs analyze <dump-id>` runs the agent on one dump without a notification; `node watcher.mjs reset` restores the lab; `npm test` runs the test suite.

More detail: the design spec in [`docs/superpowers/specs/`](docs/superpowers/specs/2026-10-01-dump-watcher-design.md) and the [rehearsal log](docs/rehearsal-log.md).

## Credits

[vibing-steampunk (vsp)](https://github.com/oisee/vibing-steampunk) by Alice Vinogradova provides the MCP server for ABAP Development Tools.

## License

[MIT](LICENSE)
