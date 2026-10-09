// The LangGraph engine (v2): the explicit pipeline of the spec. The model only drafts text; code
// reads, checks and writes, and owns both retry limits.
import { randomBytes } from 'node:crypto';
import { Annotation, Command, END, MemorySaver, START, StateGraph, interrupt } from '@langchain/langgraph';
import { z } from 'zod';
import { LAB_PACKAGE, REPRO_CLASS, forbiddenReason, objectUrl, restoreOriginal, runContract, sourceHash, summarizeDump, writeOwned } from './core.mjs';

const TEST_ATTEMPTS = 3;
const FIX_ATTEMPTS = 2;
const HOLDS_REPRO = /\bclass\s+ltc_dump_repro\s+definition\b/i;
const PAUSES = { approve: 'awaiting_decision', reclick: 'awaiting_reclick' };
const field = () => Annotation(); // the last value written wins

const State = Annotation.Root({
  id: field(), dumpId: field(), dumpAt: field(), key: field(), count: field(), title: field(), runtimeError: field(), summary: field(),
  investigation: field(), problem: field(), original: field(), tests: field(),
  testDraft: field(), testAttempts: field(), testProblem: field(), testWritten: field(), testHash: field(),
  fix: field(), fixAttempts: field(), fixProblem: field(),
  decision: field(), restoreReason: field(), outcome: field(),
});

// A4H keeps its system time zone on UTC (STZAC), so a revision date without a zone is UTC.
// vsp lists an object here while any part of it is inactive (first probe, spec section 3).
const inactive = (list, name) => new RegExp(`\\b${name}\\b`, 'i').test(JSON.stringify(list ?? []));

const asUtc = (date) => (/(Z|[+-]\d\d:?\d\d)$/.test(date) ? date : `${date}Z`);

export function investigationProblem(inv) {
  if (!inv.cause.trim() || inv.cause.length > 120) return 'cause must be 1-120 characters';
  if (inv.verdict === 'code_fix' && !inv.object) return 'a code_fix needs object';
  if (inv.verdict === 'data_fix' && !inv.data_action?.trim()) return 'a data_fix needs data_action';
  return null;
}

// The original include, byte for byte, then the model's class.
const includeFor = (s) => `${s.tests.source}\n\n${s.testDraft.source.trim()}\n`;

const threadInput = ({ id, entry, dump, key, count }) => ({
  id, dumpId: entry.id, dumpAt: entry.at, key, count,
  title: `${dump.detail.errorType} in ${String(dump.detail.program).replace(/=+CP$/, '')}`,
  runtimeError: dump.detail.errorType,
  summary: summarizeDump(dump), // the full dump stays out of the state, so it is neither saved nor traced
  problem: null, testAttempts: 0, fixAttempts: 0, testWritten: [],
});

// The proposal in v1's shape, so the page, the store and the rehearsal output stay the same.
function proposalFrom(s, now) {
  const base = { id: s.id, dumpId: s.dumpId, key: s.key, count: s.count, createdAt: now(), tokenAt: now(), runtimeError: s.runtimeError, title: s.title };
  const inv = s.investigation;
  if (s.problem) {
    const result = { ...inv, verdict: 'unsure', confidence: 'low', cause: String(inv.cause).slice(0, 120), explanation: `${inv.explanation}\n\nNot offered for approval: ${s.problem}`.trim() };
    return { ...base, result, status: 'info' };
  }
  if (inv.verdict !== 'code_fix') return { ...base, result: inv, status: 'info' };
  const { type, name } = inv.object;
  const unitTest = type === 'CLAS';
  return {
    ...base,
    result: {
      ...inv, explanation: `${inv.explanation}\n\n${s.fix.rationale}`, fixed_source: s.fix.source,
      test: unitTest ? { class: REPRO_CLASS, method: s.testDraft.method } : null,
      verification: unitTest ? 'unit_test' : 'manual_reclick',
    },
    status: 'open',
    objectUrl: objectUrl(type, name), original: s.original, fixed: s.fix.source, fixedHash: sourceHash(s.fix.source),
    ...(unitTest ? { testHash: s.testHash, testSource: includeFor(s) } : {}),
  };
}

export function buildGraph(ctx, models) {
  const { vsp, store, tell, finish, save, issueToken, pageUrl, diff, now, crash, log } = ctx;
  const deps = { vsp, crash };
  // Every step starts at a crash point, so a test can stop a run between any two steps.
  const step = (name, fn) => async (s) => { await crash(`enter:${name}`); return fn(s); };
  const readSource = (type, name, include) =>
    vsp.call('GetSource', { object_type: type, name, include_hash: true, include_context: false, ...(include ? { include } : {}) });

  async function investigate(s) {
    const investigation = await models.investigate(s.summary);
    return { investigation, problem: investigationProblem(investigation) };
  }

  async function readTarget(s) {
    const { type, name } = s.investigation.object;
    const hits = await vsp.call('SearchObject', { query: name, maxResults: 10 });
    const hit = (Array.isArray(hits) ? hits : hits?.results ?? []).find((h) => String(h.Name).toUpperCase() === name.toUpperCase());
    if (hit?.PackageName !== LAB_PACKAGE) return { problem: `${name} is not in ${LAB_PACKAGE}` };
    // Every write activates the whole object, so somebody's saved, inactive edit would go live with it.
    if (inactive(await vsp.call('GetInactiveObjects', {}), name)) return { problem: `${name} has an inactive version; activate or discard it, then trigger the dump again` };
    const current = await readSource(type, name);
    const revisions = await vsp.call('GetRevisions', { type, name }).catch((err) => {
      // A4H keeps no version history for DDL sources (404). Without history there is nothing to check.
      if (!/status 404/.test(err.message)) throw err;
      log(`readTarget: no revision history for ${type} ${name}`);
      return [];
    });
    const later = (Array.isArray(revisions) ? revisions : []).find((r) => Date.parse(asUtc(r.date)) > Date.parse(s.dumpAt));
    if (later) return { investigation: { ...s.investigation, verdict: 'already_changed', explanation: `${s.investigation.explanation}\n\n${name} changed at ${later.date}, after the dump.` } };
    const original = { source: current.source, hash: current.sourceHash };
    if (type !== 'CLAS') return { original };
    const tests = await readSource('CLAS', name, 'testclasses');
    if (HOLDS_REPRO.test(tests.source)) return { problem: `reset required: the test include of ${name} still holds ${REPRO_CLASS.toLowerCase()} from an earlier analysis` };
    return { original, tests: { source: tests.source, hash: tests.sourceHash } };
  }

  const brief = (s) => [
    `Dump summary:\n${s.summary}`,
    `Cause: ${s.investigation.cause}\n${s.investigation.explanation}`,
    `Current source of ${s.investigation.object.name}:\n${s.original.source}`,
  ].join('\n\n');

  async function draftTest(s) {
    const user = [brief(s), `Current test include:\n${s.tests.source}`, s.testProblem && `Your previous attempt broke the contract: ${s.testProblem}`].filter(Boolean).join('\n\n');
    return { testDraft: await models.draftTest(user), testAttempts: s.testAttempts + 1 };
  }

  async function runTests(s) {
    const { name } = s.investigation.object;
    const source = includeFor(s);
    const testWritten = [...s.testWritten, sourceHash(source)];
    const lastTry = s.testAttempts >= TEST_ATTEMPTS;
    const failed = (testProblem) => ({ testProblem, testWritten, ...(lastTry ? { problem: `after ${TEST_ATTEMPTS} attempts, the test still breaks the contract: ${testProblem}` } : {}) });
    // Writing the include activates the whole class, so the main source must still be the one read.
    if ((await readSource('CLAS', name)).sourceHash !== s.original.hash) return { problem: `${name} changed after it was read; nothing more was written` };
    let written;
    try {
      written = await writeOwned(deps, { type: 'CLAS', name, include: 'testclasses', source, replaces: [s.tests.hash, ...s.testWritten], point: 'testInclude' });
    } catch (err) {
      return failed(`the test include did not save or activate: ${err.message.slice(0, 400)}`);
    }
    if (written === 'foreign') return { problem: `the test include of ${name} changed since it was read; nothing more was written` };
    if (written === 'unconfirmed') return failed('the test include is saved but could not be activated');
    const testProblem = await runContract(vsp, { objectUrl: objectUrl('CLAS', name), method: s.testDraft.method, runtimeError: s.runtimeError }, 'before');
    return testProblem ? failed(testProblem) : { testProblem: null, testWritten, testHash: sourceHash(source) };
  }

  async function draftFix(s) {
    const user = [brief(s), s.fixProblem && `Your previous fix was refused: ${s.fixProblem}`].filter(Boolean).join('\n\n');
    return { fix: await models.draftFix(user), fixAttempts: s.fixAttempts + 1 };
  }

  async function checkFix(s) {
    const { type, name } = s.investigation.object;
    let fixProblem = forbiddenReason(s.original.source, s.fix.source);
    if (!fixProblem) {
      const messages = await vsp.call('SyntaxCheck', { object_url: objectUrl(type, name), content: s.fix.source });
      const errors = (Array.isArray(messages) ? messages : []).filter((m) => m.severity === 'E');
      if (errors.length) fixProblem = `the fix has syntax errors: ${errors.map((e) => `line ${e.line}: ${e.text}`).join('; ')}`;
    }
    if ((await readSource(type, name)).sourceHash !== s.original.hash) return { problem: `${name} changed after it was read` };
    if (!fixProblem) return { fixProblem: null };
    return s.fixAttempts < FIX_ATTEMPTS ? { fixProblem } : { fixProblem, problem: fixProblem };
  }

  // A rerun reuses the proposal file and its token; a crash right after the push repeats the push once.
  async function propose(s) {
    let p = store.proposal(s.id);
    if (!p) {
      p = { ...proposalFrom(s, now), view: randomBytes(16).toString('hex'), diff: await diff(s.original.source, s.fix.source) };
      issueToken(p);
      store.saveProposal(p);
    }
    store.setStatus('awaiting_decision', { proposalId: p.id });
    await tell({ title: p.title, body: p.result.cause, click: pageUrl(p.id, p.view), priority: 'high' });
    return {};
  }

  // Leaves the watcher's state alone: the engine records the end after the thread's last checkpoint.
  async function report(s) {
    let p = store.proposal(s.id);
    if (!p) {
      p = { ...proposalFrom(s, now), view: randomBytes(16).toString('hex') };
      store.saveProposal(p);
    }
    await tell({ title: p.title, body: p.result.cause, click: pageUrl(p.id, p.view), priority: 'default' });
    return {};
  }

  const closing = (status, message) => ({ status, message, state: status === 'recovery_required' ? 'recovery_required' : 'idle' });
  const stale = (what) => ({ outcome: closing('stale', `Stale: ${what} changed since the proposal. Nothing was written`) });
  const needsReset = (reason) => ({ outcome: closing('recovery_required', `Recovery required: run node watcher.mjs reset (${reason})`) });

  async function approve() {
    const decision = interrupt({ pause: 'approve' }, { responseSchema: z.enum(['approve', 'reject', 'expire']) });
    if (decision === 'reject') return { decision, outcome: closing('rejected', 'Rejected: nothing was changed') };
    if (decision === 'expire') return { decision, outcome: closing('expired', 'Proposal expired') };
    return { decision, outcome: null };
  }

  // As v1: the test include and the source still have the hashes the proposal is bound to.
  async function checkStale(s) {
    const p = store.proposal(s.id);
    const { type, name } = p.result.object;
    if (p.testHash && (await readSource('CLAS', name, 'testclasses')).sourceHash !== p.testHash) return stale('the tests');
    if ((await readSource(type, name)).sourceHash !== p.original.hash) return stale(name);
    store.setStatus('applying', { proposalId: p.id });
    save(p, 'applying');
    return {};
  }

  async function write(s) {
    const p = store.proposal(s.id);
    const { type, name } = p.result.object;
    // Writing the fix activates the whole class, so its test include must still be the approved one.
    if (p.testHash && (await readSource('CLAS', name, 'testclasses')).sourceHash !== p.testHash) return needsReset(`the test include of ${name} changed while the fix was applied; nothing was activated`);
    let written;
    try {
      written = await writeOwned(deps, { type, name, source: p.fixed, replaces: [p.original.hash], point: 'writeFix' });
    } catch (err) {
      if (err.message.includes('SOURCE_DRIFT')) return stale(name);
      return { restoreReason: `writing the fix failed: ${err.message.slice(0, 120)}` };
    }
    if (written === 'foreign') return needsReset(`${name} holds neither the original nor the fix`);
    if (written === 'unconfirmed') return needsReset('the fix is saved but could not be confirmed active');
    return {};
  }

  async function verify(s) {
    const p = store.proposal(s.id);
    const problem = await runContract(vsp, { objectUrl: p.objectUrl, method: p.result.test.method, runtimeError: p.runtimeError }, 'after');
    return problem ? { restoreReason: problem } : { outcome: closing('fixed', 'Fixed ✅ Tests pass') };
  }

  async function announceApplied(s) {
    const p = store.proposal(s.id);
    if (!p.token) issueToken(p); // a rerun keeps the token it already sent
    const message = 'Applied: open the value help to confirm';
    await finish(p, 'awaiting_reclick', 'awaiting_reclick', message);
    return { outcome: { status: 'awaiting_reclick', state: 'awaiting_reclick', message } };
  }

  async function reclick() {
    const decision = interrupt({ pause: 'reclick' }, { responseSchema: z.enum(['works', 'broken', 'expire']) });
    if (decision === 'works') return { decision, outcome: closing('confirmed', 'Fixed ✅ (confirmed by re-click)') };
    if (decision === 'expire') return { decision, outcome: closing('expired', 'Applied, unconfirmed (no re-click within an hour)') };
    return { decision, outcome: null, restoreReason: 'still broken after re-click' };
  }

  async function restore(s) {
    const p = store.proposal(s.id);
    store.setStatus('applying', { proposalId: p.id });
    save(p, 'applying');
    const problem = await restoreOriginal(deps, p);
    if (!problem) return { outcome: closing('reverted', `Reverted ❌ ${s.restoreReason}`) };
    log(`restore: ${problem}`);
    return needsReset(s.restoreReason);
  }

  // The proposal's final status and the message. The watcher's state follows when the engine records
  // the thread's end, so a crash before then reruns this step: the message can repeat, never get lost.
  async function close(s) {
    const p = store.proposal(s.id);
    if (s.outcome.state === 'recovery_required') delete p.token;
    save(p, s.outcome.status);
    await tell({ title: p.title, body: s.outcome.message, click: pageUrl(p.id, p.view) });
    return {};
  }

  return new StateGraph(State)
    .addNode('investigate', step('investigate', investigate))
    .addNode('readTarget', step('readTarget', readTarget))
    .addNode('draftTest', step('draftTest', draftTest))
    .addNode('runTests', step('runTests', runTests))
    .addNode('draftFix', step('draftFix', draftFix))
    .addNode('checkFix', step('checkFix', checkFix))
    .addNode('propose', step('propose', propose))
    .addNode('approve', step('approve', approve))
    .addNode('checkStale', step('checkStale', checkStale))
    .addNode('write', step('write', write))
    .addNode('verify', step('verify', verify))
    .addNode('announceApplied', step('announceApplied', announceApplied))
    .addNode('reclick', step('reclick', reclick))
    .addNode('restore', step('restore', restore))
    .addNode('close', step('close', close))
    .addNode('report', step('report', report))
    .addEdge(START, 'investigate')
    .addConditionalEdges('investigate', (s) => (!s.problem && s.investigation.verdict === 'code_fix' ? 'readTarget' : 'report'), ['readTarget', 'report'])
    .addConditionalEdges('readTarget', (s) => (s.problem || s.investigation.verdict !== 'code_fix' ? 'report' : s.investigation.object.type === 'CLAS' ? 'draftTest' : 'draftFix'), ['draftTest', 'draftFix', 'report'])
    .addEdge('draftTest', 'runTests')
    .addConditionalEdges('runTests', (s) => (s.problem ? 'report' : s.testProblem ? 'draftTest' : 'draftFix'), ['draftTest', 'draftFix', 'report'])
    .addEdge('draftFix', 'checkFix')
    .addConditionalEdges('checkFix', (s) => (s.problem ? 'report' : s.fixProblem ? 'draftFix' : 'propose'), ['draftFix', 'propose', 'report'])
    .addEdge('propose', 'approve')
    .addConditionalEdges('approve', (s) => (s.outcome ? 'close' : 'checkStale'), ['checkStale', 'close'])
    .addConditionalEdges('checkStale', (s) => (s.outcome ? 'close' : 'write'), ['write', 'close'])
    .addConditionalEdges('write', (s) => (s.outcome ? 'close' : s.restoreReason ? 'restore' : s.investigation.object.type === 'CLAS' ? 'verify' : 'announceApplied'), ['verify', 'announceApplied', 'restore', 'close'])
    .addConditionalEdges('verify', (s) => (s.outcome ? 'close' : 'restore'), ['close', 'restore'])
    .addEdge('announceApplied', 'reclick')
    .addConditionalEdges('reclick', (s) => (s.outcome ? 'close' : 'restore'), ['close', 'restore'])
    .addEdge('restore', 'close')
    .addEdge('close', END)
    .addEdge('report', END);
}

export function createLanggraphEngine(ctx, { models, checkpointer }) {
  const graph = buildGraph(ctx, models).compile({ checkpointer });
  const config = (id) => ({ configurable: { thread_id: id }, durability: 'sync' });
  const pausedAt = (state) => state.tasks.find((t) => t.interrupts?.length)?.name;

  // A thread that has ended: its dump is seen, and the watcher takes the outcome's state. Until this
  // runs, the watcher's state stays as it was, so a restart finds the thread and finishes it.
  async function record(id) {
    const { next, values } = await graph.getState(config(id));
    if (next.length) return values.outcome?.message; // paused at a decision
    await ctx.crash('threadEnd');
    ctx.store.markSeen(values.dumpId);
    ctx.settle(id, values.outcome?.state ?? 'idle');
    return values.outcome?.message;
  }

  // Runs the thread until it pauses or ends, with one log line per finished step.
  async function run(input, id) {
    for await (const update of await graph.stream(input, { ...config(id), streamMode: 'updates' })) {
      for (const name of Object.keys(update)) ctx.log(name === '__interrupt__' ? 'graph: waiting for a decision' : `graph: ${name}`);
    }
    return record(id);
  }

  return {
    analyze: async (item) => { await run(threadInput(item), item.id); },

    // Rehearsal: a throwaway thread that stops before anything reaches the store or the phone.
    async analyzeOnce(item) {
      const rehearsal = buildGraph(ctx, models).compile({ checkpointer: new MemorySaver(), interruptBefore: ['propose', 'report'] });
      const cfg = { configurable: { thread_id: item.id } };
      await rehearsal.invoke(threadInput(item), cfg);
      const s = (await rehearsal.getState(cfg)).values;
      const p = proposalFrom(s, ctx.now);
      if (p.status === 'open') p.diff = await ctx.diff(s.original.source, s.fix.source);
      return p;
    },

    decide: (action, p) => run(new Command({ resume: action }), p.id),

    async recover() {
      const s = ctx.store.status();
      if (!s.proposalId || !['analyzing', 'awaiting_decision', 'applying', 'awaiting_reclick'].includes(s.state)) return;
      let state = await graph.getState(config(s.proposalId));
      if (!state.values.dumpId) { ctx.store.setStatus('idle'); return; } // no checkpoint yet: the unseen dump is analyzed again
      ctx.store.markSeen(state.values.dumpId); // from its first checkpoint on, the thread owns its dump
      if (!state.next.length) return record(s.proposalId); // it ended, but the watcher never recorded that
      if (!pausedAt(state)) {
        ctx.log(`recover: continuing at ${state.next.join(', ')}`);
        await run(null, s.proposalId);
        state = await graph.getState(config(s.proposalId));
      }
      const pause = pausedAt(state);
      const p = ctx.store.proposal(s.proposalId);
      // A decision saved just before a crash answers its own pause only; each pause happens once per thread.
      if (pause && p?.pending?.pause === PAUSES[pause]) {
        ctx.log(`recover: delivering the saved decision "${p.pending.action}"`);
        await run(new Command({ resume: p.pending.action }), s.proposalId);
      }
    },
  };
}

// The graph's shape without a watcher behind it: for docs/graph.md and LangGraph Studio's graph view.
// Running it needs the watcher's context, so runs and their traces come from the watcher and LangSmith.
export const studioGraph = buildGraph({}, {}).compile();
export const diagram = async () => (await studioGraph.getGraphAsync()).drawMermaid();
