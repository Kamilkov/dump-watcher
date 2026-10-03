// Every decision the dump watcher makes. SAP, the agent and ntfy are passed in as `deps`.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LAB_PACKAGE = '$ZDUMP_LAB';
export const REPRO_CLASS = 'LTC_DUMP_REPRO';
export const TOKEN_TTL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_MS = 15 * 60 * 1000;
const TRACE_POLL_MS = 60 * 1000;

// ---------- dumps ----------

export const isDumpSavedLine = (line) => line.includes('RABAX: level LEV_RX_ERROR_SAVE completed');

export function newDemoDumps(listResult, seen, demoUser) {
  return (listResult?.dumps ?? [])
    .filter((d) => d.user === demoUser && !seen.has(d.id))
    .sort((a, b) => a.at.localeCompare(b.at));
}

export const dumpKey = (detail) => [detail.errorType, detail.program, detail.include, detail.line].join('|');

// Same canonical form as vsp's adt.SourceHash: CRLF → LF, trailing newlines dropped.
export const sourceHash = (text) =>
  'sha256:' + createHash('sha256').update(String(text).replace(/\r\n/g, '\n').replace(/\n+$/, '')).digest('hex');

export function objectUrl(type, name) {
  const n = name.toLowerCase();
  if (type === 'CLAS') return `/sap/bc/adt/oo/classes/${n}`;
  if (type === 'DDLS') return `/sap/bc/adt/ddic/ddl/sources/${n}`;
  throw new Error(`no URL rule for object type ${type}`);
}

const Z_NAME = /\b[ZY][A-Z0-9]*_[A-Z0-9_]+/;
const CX_NAME = /\bCX_[A-Z0-9_]+/;
const mentionsCode = (v) => [v.name, v.value].some((s) => Z_NAME.test(String(s)) || CX_NAME.test(String(s)));

export function summarizeDump({ dump, detail }) {
  // The stop frame's variables (parameters, locals) are the evidence; elsewhere keep only Z/CX mentions.
  const stopFrame = detail.stack?.[0]?.name;
  const variables = [
    ...(detail.variables ?? []).filter((v) => v.frame === stopFrame),
    ...(detail.variables ?? []).filter((v) => v.frame !== stopFrame && mentionsCode(v)),
  ];
  return [
    `Runtime error: ${detail.errorType}${detail.exception ? ` (exception ${detail.exception})` : ''}`,
    `Time: ${dump.at}   User: ${dump.user}`,
    `Short text: ${detail.shortText ?? dump.message ?? ''}`,
    `Stopped in: program ${detail.program}, include ${detail.include}, line ${detail.line}, procedure ${detail.procedure}`,
    `Main program: ${detail.mainProgram}`,
    '',
    'Call stack (innermost first):',
    ...(detail.stack ?? []).map((f) => `  ${f.type} ${f.name}  [${f.include}:${f.line}]`),
    '',
    'Source extract (rendered from the CURRENT source; the line where the dump stopped is missing):',
    ...(detail.source ?? []).map((s) => `  ${s.line}: ${s.text}`),
    '',
    'Variables where the dump stopped, then others that mention Z objects or CX_ classes:',
    ...variables.slice(0, 60).map((v) => `  [${v.frame}] ${v.name} = ${String(v.value).slice(0, 200)}`),
  ].join('\n');
}

// ---------- agent ----------

export function agentArgs(model) {
  return [
    '-p',
    '--append-system-prompt-file', 'agent/dump-repair.md',
    '--restricted', '--tools', '',
    '--mcp-config', '.mcp.json', '--strict-mcp-config',
    '--settings', 'agent/settings.json',
    '--permission-mode', 'dontAsk',
    '--output-format', 'stream-json', '--verbose',
    ...(model ? ['--model', model] : []),
  ];
}

const blockText = (content) =>
  typeof content === 'string' ? content : (content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

export function parseAgentStream(lines) {
  const calls = new Map();
  const toolResults = [];
  let finalText = '';
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const content = event.message?.content;
    if (event.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) if (b.type === 'tool_use') calls.set(b.id, { name: b.name, input: b.input ?? {} });
    } else if (event.type === 'user' && Array.isArray(content)) {
      for (const b of content) {
        const call = b.type === 'tool_result' && calls.get(b.tool_use_id);
        if (call) toolResults.push({ ...call, output: blockText(b.content), isError: b.is_error === true });
      }
    } else if (event.type === 'result') {
      finalText = event.result ?? '';
    }
  }
  return { finalText, toolResults };
}

export function extractResultJson(text) {
  const blocks = [...String(text ?? '').matchAll(/```json[^\n]*\n([\s\S]*?)```/g)];
  if (!blocks.length) return null;
  try { return JSON.parse(blocks.at(-1)[1]); } catch { return null; }
}

const VERDICTS = ['code_fix', 'data_fix', 'already_changed', 'unsure'];

export function validateResult(r) {
  if (!r || typeof r !== 'object') return 'the agent returned no JSON result';
  if (!VERDICTS.includes(r.verdict)) return `unknown verdict "${r.verdict}"`;
  if (typeof r.cause !== 'string' || !r.cause.trim() || r.cause.length > 120) return 'cause must be 1-120 characters';
  if (typeof r.explanation !== 'string' || !r.explanation.trim()) return 'explanation is missing';
  if (!['high', 'medium', 'low'].includes(r.confidence)) return 'confidence must be high, medium or low';
  if (r.verdict === 'data_fix' && !String(r.data_action ?? '').trim()) return 'a data_fix needs data_action';
  if (r.verdict !== 'code_fix') return null;
  if (!['CLAS', 'DDLS'].includes(r.object?.type) || !r.object?.name) return 'a code_fix needs object {type: CLAS|DDLS, name}';
  if (typeof r.fixed_source !== 'string' || !r.fixed_source.trim()) return 'a code_fix needs fixed_source';
  if (r.object.type === 'DDLS') return r.verification === 'manual_reclick' ? null : 'a CDS fix is verified by manual_reclick';
  if (r.verification !== 'unit_test') return 'a class fix is verified by unit_test';
  if (String(r.test?.class ?? '').toUpperCase() !== REPRO_CLASS || !r.test?.method) return `a class fix needs test {class: ${REPRO_CLASS}, method}`;
  return null;
}

const CATCH_ALL = /catch\s+(?:cx_root|cx_static_check|cx_dynamic_check|cx_no_check)\b/gi;
const SHORTDUMP = /raise\s+shortdump/gi;
const TYPE_X = /type\s+'x'/gi;
const count = (re, s) => (String(s).match(re) ?? []).length;

export function forbiddenReason(original, fixed) {
  if (count(CATCH_ALL, fixed) > count(CATCH_ALL, original)) return 'the fix adds a catch-all exception handler';
  if (count(SHORTDUMP, fixed) < count(SHORTDUMP, original)) return 'the fix removes a RAISE SHORTDUMP';
  if (count(TYPE_X, fixed) < count(TYPE_X, original)) return "the fix removes a MESSAGE ... TYPE 'X'";
  return null;
}

export function findBoundSource(toolResults, objectName) {
  const name = objectName.toUpperCase();
  for (const r of [...toolResults].reverse()) {
    const i = r.input ?? {};
    if (!r.name.endsWith('__GetSource') || r.isError || i.include_hash !== true || i.include || i.method) continue;
    if (String(i.name ?? '').toUpperCase() !== name) continue;
    try {
      const { source, sourceHash: hash } = JSON.parse(r.output);
      if (typeof source === 'string' && typeof hash === 'string') return { source, hash };
    } catch { /* plain-text output; keep looking */ }
  }
  return null;
}

function testMethods(unitResult) {
  return (unitResult?.classes ?? []).flatMap((c) =>
    (c.testMethods ?? []).map((m) => ({
      cls: String(c.name).toUpperCase(),
      method: String(m.name).toUpperCase(),
      alerts: [...(m.alerts ?? []), ...(c.alerts ?? [])],
    })));
}
const alertText = (alerts) => alerts.map((a) => [a.title, ...(a.details ?? [])].join(' ')).join(' ').toUpperCase();

export function checkTestContract(unitResult, { method, runtimeError }, phase) {
  const all = testMethods(unitResult);
  // A dumping test is reported on its class only ("runtime abortion"), with no method entry.
  const repro = all.find((m) => m.cls === REPRO_CLASS && m.method === String(method).toUpperCase())
    ?? (unitResult?.classes ?? []).filter((c) => String(c.name).toUpperCase() === REPRO_CLASS && c.alerts?.length)
      .map((c) => ({ cls: REPRO_CLASS, method: String(method).toUpperCase(), alerts: c.alerts }))[0];
  const others = all.filter((m) => m !== repro);
  if (!repro) return `the test ${REPRO_CLASS}=>${method} did not run`;
  if (!others.length) return 'no existing test ran';
  if (others.some((m) => m.alerts.length)) return 'an existing test failed';
  if (phase === 'after') return repro.alerts.length ? 'the new test still fails after the fix' : null;
  if (!repro.alerts.length) return 'the new test passed before the fix, so it does not reproduce the dump';
  if (!alertText(repro.alerts).includes(String(runtimeError).toUpperCase())) return `the new test failed, but not with ${runtimeError}`;
  return null;
}

// ---------- page ----------

export const STATUS_TEXT = {
  open: 'Waiting for your decision',
  info: 'For information: nothing to approve',
  applying: 'Applying the fix…',
  fixed: 'Fixed ✅',
  reverted: 'Reverted ❌',
  awaiting_reclick: 'Applied, awaiting re-click',
  confirmed: 'Fixed ✅ (confirmed by re-click)',
  rejected: 'Rejected',
  stale: 'Stale: the code changed since the proposal',
  expired: 'Expired',
  cancelled: 'Cancelled by reset',
  recovery_required: 'Recovery required: run node watcher.mjs reset',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function renderPage(p) {
  const form = (action, label) =>
    `<form method="post" action="/p/${esc(p.id)}/${action}"><input type="hidden" name="t" value="${esc(p.token)}"><button>${label}</button></form>`;
  const actions = !p.token ? ''
    : p.status === 'open' ? form('approve', 'Approve') + form('reject', 'Reject')
    : p.status === 'awaiting_reclick' ? form('works', 'Works ✅') + form('broken', 'Still broken')
    : '';
  const r = p.result;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.title)}</title>
<style>body{font:16px/1.4 system-ui;margin:16px;max-width:900px}pre{background:#f3f3f3;padding:8px;white-space:pre-wrap;overflow-wrap:anywhere}form{display:inline-block;margin:8px 8px 0 0}button{font-size:18px;padding:10px 18px}</style>
</head><body>
<h1>${esc(p.title)}</h1>
<p><b>Status:</b> ${esc(STATUS_TEXT[p.status] ?? p.status)}${p.count > 1 ? ` · seen ${esc(p.count)} times` : ''}</p>
<p><b>Verdict:</b> ${esc(r.verdict)} · ${esc(r.confidence)} confidence</p>
<p><b>Cause:</b> ${esc(r.cause)}</p>
<pre>${esc(r.explanation)}</pre>
${r.data_action ? `<p><b>Data to maintain:</b> ${esc(r.data_action)}</p>` : ''}
${p.diff ? `<h2>Fix</h2><pre>${esc(p.diff)}</pre>` : ''}
${p.testSource ? `<h2>Tests</h2><pre>${esc(p.testSource)}</pre>` : ''}
${actions}
</body></html>`;
}

// ---------- store ----------

export function createStore(dir) {
  mkdirSync(join(dir, 'proposals'), { recursive: true });
  const path = (name) => join(dir, name);
  const read = (name, fallback) => (existsSync(path(name)) ? JSON.parse(readFileSync(path(name), 'utf8')) : fallback);
  const write = (name, value) => {
    writeFileSync(`${path(name)}.tmp`, JSON.stringify(value, null, 2));
    renameSync(`${path(name)}.tmp`, path(name)); // a crash never leaves half a file
  };
  return {
    status: () => read('status.json', { state: 'idle' }),
    setStatus: (state, extra = {}) => write('status.json', { state, ...extra }),
    seen: () => new Set(read('seen.json', [])),
    isFresh: () => !existsSync(path('seen.json')),
    markSeen: (...ids) => write('seen.json', [...new Set([...read('seen.json', []), ...ids])]),
    proposal: (id) => (/^[0-9a-f]{1,32}$/.test(String(id)) ? read(join('proposals', `${id}.json`), null) : null),
    saveProposal: (p) => write(join('proposals', `${p.id}.json`), p),
    proposals: () => readdirSync(path('proposals')).filter((f) => f.endsWith('.json')).map((f) => read(join('proposals', f), null)),
  };
}

// ---------- watcher ----------

const ACTIONABLE = new Set(['awaiting_decision', 'awaiting_reclick']);
const DUMP_FIELDS = ['original', 'fixed', 'fixedHash', 'diff', 'testHash', 'testSource', 'objectUrl'];

export function createWatcher({
  vsp, store, runAgent, notify, diff, demoUser, pageUrl,
  now = Date.now, log = console.log, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const queue = []; // { entry, dump, key, count } waiting for an idle watcher
  let chain = Promise.resolve();
  const serial = (fn) => { const run = chain.then(fn); chain = run.catch(() => {}); return run; }; // one step at a time

  const tell = async (message) => { try { await notify(message); } catch (err) { log(`notify failed: ${err.message}`); } };
  const save = (p, status) => { p.status = status; store.saveProposal(p); };
  const issueToken = (p) => { p.token = randomBytes(16).toString('hex'); p.tokenAt = now(); };
  const useToken = (p, token) => {
    const ok = Boolean(p.token) && token === p.token && now() - p.tokenAt <= TOKEN_TTL_MS;
    if (ok) { delete p.token; store.saveProposal(p); }
    return ok;
  };
  // The dump feed is slow to scan and lags ~30 s behind SAP; ask only for a recent window.
  const since = (windowMs) => new Date(now() - windowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');

  async function finish(p, status, state, message) {
    save(p, status);
    store.setStatus(state, state === 'idle' ? {} : { proposalId: p.id });
    await tell({ title: p.title, body: message, click: pageUrl(p.id, p.view) });
    if (state === 'idle') serial(drain).catch((err) => log(`queue failed: ${err.message}`));
    return message;
  }

  async function intake(windowMs) {
    const list = await vsp.call('ListDumps', { user: demoUser, since: since(windowMs), max_results: 100 });
    const status = store.status();
    const open = ACTIONABLE.has(status.state) ? store.proposal(status.proposalId) : null;
    let found = 0;
    for (const entry of newDemoDumps(list, store.seen(), demoUser)) {
      if (queue.some((q) => q.entry.id === entry.id)) continue;
      const dump = await vsp.call('GetDump', { dump_id: entry.id });
      const key = dumpKey(dump.detail);
      found += 1;
      log(`dump ${entry.errorType} detected ${((now() - Date.parse(entry.at)) / 1000).toFixed(1)} s after it happened`);
      const twin = open?.key === key ? open : queue.find((q) => q.key === key);
      if (twin) {
        twin.count += 1;
        if (twin === open) store.saveProposal(open);
        store.markSeen(entry.id);
        continue;
      }
      queue.push({ entry, dump, key, count: 1 });
    }
    return found;
  }

  async function drain() {
    while (queue.length && store.status().state === 'idle') await analyze(queue.shift());
  }

  async function analyze(item) {
    store.setStatus('analyzing', { dumpId: item.entry.id });
    let p;
    try {
      p = await buildProposal(item);
    } catch (err) {
      store.markSeen(item.entry.id);
      store.setStatus('idle');
      await tell({ title: `Couldn't analyze ${item.entry.errorType}`, body: String(err.message).slice(0, 200) });
      return;
    }
    store.markSeen(item.entry.id);
    store.saveProposal(p);
    const actionable = p.status === 'open';
    store.setStatus(actionable ? 'awaiting_decision' : 'idle', actionable ? { proposalId: p.id } : {});
    await tell({ title: p.title, body: p.result.cause, click: pageUrl(p.id, p.view), priority: actionable ? 'high' : 'default' });
  }

  async function buildProposal({ entry, dump, key, count }) {
    const { finalText, toolResults } = await runAgent(summarizeDump(dump));
    const detail = dump.detail;
    const p = {
      id: randomBytes(6).toString('hex'), view: randomBytes(16).toString('hex'),
      dumpId: entry.id, key, count, createdAt: now(), tokenAt: now(), runtimeError: detail.errorType,
      title: `${detail.errorType} in ${String(detail.program).replace(/=+CP$/, '')}`,
    };
    let result = extractResultJson(finalText);
    let problem = validateResult(result);
    if (!problem && result.verdict === 'code_fix') {
      const checked = await verifyCodeFix(result, toolResults, detail.errorType);
      problem = checked.problem;
      Object.assign(p, checked.fix);
    }
    if (problem) {
      result = {
        ...(result ?? {}), verdict: 'unsure', confidence: 'low',
        cause: String(result?.cause || 'The agent could not explain this dump').slice(0, 120),
        explanation: `${result?.explanation ?? ''}\n\nNot offered for approval: ${problem}`.trim(),
      };
      for (const field of DUMP_FIELDS) delete p[field];
    }
    p.result = result;
    p.status = result.verdict === 'code_fix' ? 'open' : 'info';
    if (p.status === 'open') issueToken(p);
    return p;
  }

  async function verifyCodeFix(result, toolResults, runtimeError) {
    const { type, name } = result.object;
    const hits = await vsp.call('SearchObject', { query: name, maxResults: 10 });
    const hit = (Array.isArray(hits) ? hits : hits?.results ?? []).find((h) => String(h.Name).toUpperCase() === name.toUpperCase());
    if (hit?.PackageName !== LAB_PACKAGE) return { problem: `${name} is not in ${LAB_PACKAGE}` };
    const bound = findBoundSource(toolResults, name);
    if (!bound) return { problem: `the agent never read ${name} with include_hash, so the proposal cannot be bound to a version` };
    const forbidden = forbiddenReason(bound.source, result.fixed_source);
    if (forbidden) return { problem: forbidden };
    const url = objectUrl(type, name);
    const messages = await vsp.call('SyntaxCheck', { object_url: url, content: result.fixed_source });
    const errors = (Array.isArray(messages) ? messages : []).filter((m) => m.severity === 'E');
    if (errors.length) return { problem: `the fix has syntax errors: ${errors.map((e) => `line ${e.line}: ${e.text}`).join('; ')}` };
    const current = await vsp.call('GetSource', { object_type: type, name, include_hash: true, include_context: false });
    if (current.sourceHash !== bound.hash) return { problem: `${name} changed after the agent read it` };
    const fix = {
      objectUrl: url, original: bound, fixed: result.fixed_source,
      fixedHash: sourceHash(result.fixed_source), diff: await diff(bound.source, result.fixed_source),
    };
    if (type === 'CLAS') {
      const run = await vsp.call('RunUnitTests', { object_url: url });
      const broken = checkTestContract(run, { method: result.test.method, runtimeError }, 'before');
      if (broken) return { problem: broken };
      const tests = await vsp.call('GetSource', { object_type: 'CLAS', name, include: 'testclasses', include_hash: true, include_context: false });
      Object.assign(fix, { testHash: tests.sourceHash, testSource: tests.source });
    }
    return { problem: null, fix };
  }

  async function expireOpen() {
    const s = store.status();
    if (!ACTIONABLE.has(s.state)) return;
    const p = store.proposal(s.proposalId);
    if (!p || now() - p.tokenAt <= TOKEN_TTL_MS) return;
    delete p.token;
    await finish(p, 'expired', 'idle', s.state === 'awaiting_reclick' ? 'Applied, unconfirmed (no re-click within an hour)' : 'Proposal expired');
  }

  async function recoverOnStartup() {
    const s = store.status();
    if (s.state === 'applying') {
      const p = s.proposalId ? store.proposal(s.proposalId) : null;
      if (p) { delete p.token; save(p, 'recovery_required'); }
      store.setStatus('recovery_required', { proposalId: s.proposalId });
      await tell({ title: 'Recovery required', body: 'The watcher stopped while applying a fix. Run: node watcher.mjs reset' });
    } else if (s.state === 'analyzing') {
      store.setStatus('idle'); // the dump is still unseen, so the next check analyzes it again
    }
  }

  async function ignoreOlderDumps() {
    const fresh = newDemoDumps(await vsp.call('ListDumps', { user: demoUser, since: since(DAY_MS), max_results: 100 }), store.seen(), demoUser);
    store.markSeen(...fresh.map((d) => d.id));
    return fresh.length;
  }

  const STATE_FOR = { approve: 'awaiting_decision', reject: 'awaiting_decision', works: 'awaiting_reclick', broken: 'awaiting_reclick' };

  async function decide(action, id, token) {
    const expected = STATE_FOR[action];
    if (!expected) return `Unknown action ${action}`;
    const s = store.status();
    const p = store.proposal(id);
    if (!p || s.proposalId !== id || s.state !== expected) return 'This proposal is no longer open';
    if (!useToken(p, token)) return 'Invalid or expired link';
    if (action === 'reject') return finish(p, 'rejected', 'idle', 'Rejected: nothing was changed');
    if (action === 'works') return finish(p, 'confirmed', 'idle', 'Fixed ✅ (confirmed by re-click)');
    if (action === 'broken') {
      store.setStatus('applying', { proposalId: p.id });
      save(p, 'applying');
      return restore(p, 'still broken after re-click');
    }
    return apply(p);
  }

  async function apply(p) {
    const { type, name } = p.result.object;
    if (p.testHash) {
      const tests = await vsp.call('GetSource', { object_type: 'CLAS', name, include: 'testclasses', include_hash: true, include_context: false });
      if (tests.sourceHash !== p.testHash) return finish(p, 'stale', 'idle', 'Stale: the tests changed since the proposal. Nothing was written');
    }
    store.setStatus('applying', { proposalId: p.id });
    save(p, 'applying');
    try {
      await vsp.call('WriteSource', { object_type: type, name, package: LAB_PACKAGE, source: p.fixed, expected_source_hash: p.original.hash });
    } catch (err) {
      if (err.message.includes('SOURCE_DRIFT')) return finish(p, 'stale', 'idle', `Stale: ${name} changed since the proposal. Nothing was written`);
      return restore(p, `writing the fix failed: ${err.message.slice(0, 120)}`);
    }
    if (type === 'DDLS') {
      issueToken(p);
      return finish(p, 'awaiting_reclick', 'awaiting_reclick', 'Applied: open the value help to confirm');
    }
    let broken;
    try {
      const run = await vsp.call('RunUnitTests', { object_url: p.objectUrl });
      broken = checkTestContract(run, { method: p.result.test.method, runtimeError: p.runtimeError }, 'after');
    } catch (err) {
      broken = `the tests could not run: ${err.message.slice(0, 120)}`;
    }
    return broken ? restore(p, broken) : finish(p, 'fixed', 'idle', 'Fixed ✅ Tests pass');
  }

  async function restore(p, reason) {
    const { type, name } = p.result.object;
    try {
      await vsp.call('WriteSource', { object_type: type, name, package: LAB_PACKAGE, source: p.original.source });
      const back = await vsp.call('GetSource', { object_type: type, name, include_hash: true, include_context: false });
      if (back.sourceHash === p.original.hash) return finish(p, 'reverted', 'idle', `Reverted ❌ ${reason}`);
    } catch { /* unverifiable: fall through to recovery */ }
    delete p.token;
    return finish(p, 'recovery_required', 'recovery_required', `Recovery required: run node watcher.mjs reset (${reason})`);
  }

  const checkDumps = (windowMs = RECENT_MS) => serial(async () => { const found = await intake(windowMs); await drain(); return found; });

  // SAP lists a dump in the ADT feed ~30 s after the trace line. Poll every 2 s until 60 s after the
  // last trace line; a trace line during polling only extends the window, so one loop runs at a time.
  let pollUntil = 0;
  let polling = false;
  async function afterTraceLine() {
    pollUntil = now() + TRACE_POLL_MS;
    if (polling) return;
    polling = true;
    try {
      for (;;) {
        await checkDumps();
        if (now() >= pollUntil) return;
        await sleep(2000);
      }
    } finally {
      polling = false;
    }
  }

  return {
    checkDumps,
    afterTraceLine,
    analyzeOnce: (dumpId) => serial(async () => {
      const dump = await vsp.call('GetDump', { dump_id: dumpId });
      return buildProposal({ entry: dump.dump, dump, key: dumpKey(dump.detail), count: 1 });
    }),
    act: (action, id, token) => serial(() => decide(action, id, token)),
    expireOpen: () => serial(expireOpen),
    recoverOnStartup,
    ignoreOlderDumps,
  };
}

// ---------- reset ----------

const UNFINISHED = new Set(['open', 'applying', 'awaiting_reclick', 'recovery_required']);

export async function resetLab({ vsp, store }, files) {
  for (const f of files) {
    if (f.include === 'testclasses') {
      await vsp.call('UpdateClassInclude', { class_name: f.name, include_type: 'testclasses', source: f.source }); // UpdateSource cannot write includes
      await vsp.call('Activate', { object_url: objectUrl('CLAS', f.name), object_name: f.name });
    } else {
      await vsp.call('WriteSource', { object_type: f.type, name: f.name, package: LAB_PACKAGE, source: f.source });
    }
  }
  for (const f of files) {
    const back = await vsp.call('GetSource', { object_type: f.type, name: f.name, include_hash: true, include_context: false, ...(f.include ? { include: f.include } : {}) });
    if (back.sourceHash !== sourceHash(f.source)) throw new Error(`${f.name}${f.include ? ` (${f.include})` : ''} did not reset`);
  }
  for (const p of store.proposals()) {
    if (!UNFINISHED.has(p.status)) continue;
    delete p.token;
    p.status = 'cancelled';
    store.saveProposal(p);
  }
  store.setStatus('idle');
}
