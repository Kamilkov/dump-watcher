#!/usr/bin/env node
// Dump watcher: kernel trace → agent → phone approval → apply.
// Usage: node watcher.mjs [start | analyze <dump-id> | reset]
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { agentArgs, createStore, createWatcher, isDumpSavedLine, parseAgentStream, renderPage, resetLab } from './core.mjs';
import { connectVsp } from './vsp.mjs';

if (existsSync('.env')) process.loadEnvFile('.env');
const { NTFY_TOPIC, DEMO_USER = 'DEMO', PORT = '8790', AGENT_MODEL } = process.env;
const PID_FILE = 'state/watcher.pid';
const TRACE_ARGS = ['-o', 'LogLevel=ERROR', '-o', 'BatchMode=yes', 'vps',
  "docker exec a4h25 sh -c 'tail -F -n0 /usr/sap/A4H/D00/work/dev_w*'"];
// Reset order: the tests first, so the class activates together with its baseline tests.
const LAB_FILES = [
  { type: 'CLAS', name: 'ZCL_DL_PRICING', include: 'testclasses', file: 'lab/zcl_dl_pricing.clas.testclasses.abap' },
  { type: 'CLAS', name: 'ZCL_DL_PRICING', file: 'lab/zcl_dl_pricing.clas.abap' },
  { type: 'DDLS', name: 'ZC_DL_ORDER', file: 'lab/zc_dl_order.ddls.asddls' },
];
const log = (message) => console.log(`${new Date().toISOString().slice(11, 19)} ${message}`);

function running() {
  if (!existsSync(PID_FILE)) return false;
  try { process.kill(Number(readFileSync(PID_FILE, 'utf8')), 0); return true; } catch { return false; }
}

function printStep(line) {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type !== 'assistant') return;
  for (const b of event.message?.content ?? []) {
    if (b.type === 'tool_use') log(`  agent → ${b.name.replace(/^mcp__vsp-lab__/, '')} ${b.input?.name ?? b.input?.object_url ?? ''}`);
    if (b.type === 'text' && b.text.trim()) log(`  agent: ${b.text.trim().split('\n')[0].slice(0, 120)}`);
  }
}

function runAgent(summary) {
  log('agent started');
  return new Promise((resolve, reject) => {
    const child = spawn('claude', agentArgs(AGENT_MODEL), { stdio: ['pipe', 'pipe', 'inherit'] });
    const lines = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error('the agent took longer than 5 minutes')); }, 5 * 60_000);
    createInterface({ input: child.stdout }).on('line', (line) => { lines.push(line); printStep(line); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      log(`agent finished (exit ${code})`);
      if (code === 0) resolve(parseAgentStream(lines)); else reject(new Error(`the agent exited with code ${code}`));
    });
    child.stdin.end(`Repair this ABAP short dump. Follow your playbook.\n\n${summary}\n`);
  });
}

async function notify({ title, body, click, priority = 'default' }) {
  log(`notify: ${title}: ${body}`);
  if (!NTFY_TOPIC) return;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch('https://ntfy.sh/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: NTFY_TOPIC, title, message: body, priority: priority === 'high' ? 4 : 3, ...(click ? { click } : {}) }),
      });
      if (res.ok) return;
      throw new Error(`ntfy answered ${res.status}`);
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
}

function diff(before, after) {
  const dir = mkdtempSync(join(tmpdir(), 'dump-watcher-'));
  const a = join(dir, 'before.abap');
  const b = join(dir, 'after.abap');
  writeFileSync(a, before.replace(/\r\n/g, '\n'));
  writeFileSync(b, after.replace(/\r\n/g, '\n'));
  try { return execFileSync('diff', ['-u', '-L', 'before', '-L', 'after', a, b], { encoding: 'utf8' }); }
  catch (err) { if (err.status === 1) return err.stdout; throw err; }
}

const readBody = (req) => new Promise((resolve) => { let s = ''; req.on('data', (c) => { s += c; }).on('end', () => resolve(s)); });

function serve(watcher, store, host) {
  createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const [, kind, id, action] = url.pathname.split('/');
    const p = kind === 'p' ? store.proposal(id) : null;
    if (!p) return res.writeHead(404).end('Not found');
    if (req.method === 'GET' && !action) {
      if (url.searchParams.get('v') !== p.view) return res.writeHead(403).end('Forbidden');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(renderPage(p));
    }
    if (req.method === 'POST' && action) {
      const token = new URLSearchParams(await readBody(req)).get('t') ?? '';
      log(`${action} ${id}: received`);
      log(`${action} ${id}: ${await watcher.act(action, id, token)}`);
      return res.writeHead(303, { Location: `/p/${id}?v=${p.view}` }).end();
    }
    return res.writeHead(405).end();
  }).listen(Number(PORT), host);
}

function followTrace(onDump) {
  let delay = 1000;
  let child;
  const connect = () => {
    child = spawn('ssh', TRACE_ARGS, { stdio: ['ignore', 'pipe', 'ignore'] });
    createInterface({ input: child.stdout }).on('line', (line) => {
      delay = 1000;
      if (isDumpSavedLine(line)) { log('trace: a dump was saved'); onDump(); }
    });
    child.on('close', () => {
      log(`trace: stream closed, reconnecting in ${delay / 1000} s`);
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 60_000);
    });
  };
  connect();
  process.on('exit', () => child?.kill());
}

const [command = 'start', arg] = process.argv.slice(2);
if (!['start', 'analyze', 'reset'].includes(command)) {
  console.error('Usage: node watcher.mjs [start | analyze <dump-id> | reset]');
  process.exit(1);
}
if (running()) {
  console.error(`The watcher is running (pid in ${PID_FILE}). Stop it first.`);
  process.exit(1);
}
const store = createStore('state');
const vsp = await connectVsp();

if (command === 'reset') {
  await resetLab({ vsp, store }, LAB_FILES.map((f) => ({ ...f, source: readFileSync(f.file, 'utf8') })));
  log('lab reset to its broken baseline; open proposals cancelled');
  await vsp.close();
  process.exit(0);
}

const host = command === 'start' ? execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8' }).trim().split('\n')[0] : '127.0.0.1';
const watcher = createWatcher({
  vsp, store, runAgent, notify, diff, log, demoUser: DEMO_USER,
  pageUrl: (id, view) => `http://${host}:${PORT}/p/${id}?v=${view}`,
});

if (command === 'analyze') {
  if (!arg) { console.error('Usage: node watcher.mjs analyze <dump-id>'); process.exit(1); }
  const p = await watcher.analyzeOnce(arg);
  console.log(JSON.stringify({ ...p, token: undefined, view: undefined }, null, 2));
  await vsp.close();
  process.exit(0);
}

writeFileSync(PID_FILE, String(process.pid));
process.on('exit', () => { try { unlinkSync(PID_FILE); } catch { /* already gone */ } });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { log(`stopped by ${signal}`); process.exit(0); });
await watcher.recoverOnStartup();
if (store.isFresh()) log(`first start: ignoring ${await watcher.ignoreOlderDumps()} older dumps`);
serve(watcher, store, host);
const check = () => watcher.checkDumps().catch((err) => log(`check failed: ${err.message}`));
followTrace(() => watcher.afterTraceLine().catch((err) => log(`check failed: ${err.message}`)));
setInterval(check, 5 * 60_000);
setInterval(() => watcher.expireOpen().catch((err) => log(`expiry failed: ${err.message}`)), 60_000);
await watcher.checkDumps(24 * 60 * 60_000).catch((err) => log(`check failed: ${err.message}`));
log(`watching dumps of ${DEMO_USER}; proposal pages on http://${host}:${PORT}`);
