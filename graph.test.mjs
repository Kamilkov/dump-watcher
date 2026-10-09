import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceHash } from './core.mjs';
import { investigationProblem } from './graph.mjs';
import { BASELINE_TESTS, DUMPED, FIXED, ORIGINAL, REPRO_TEST, DDL, DDL_FIXED, cdsFix, classFix, crashAt, dataFix, dumpEntry, fakeSap, openProposal, scriptedModels, setup, unitRun } from './test/fakes.mjs';
import { readFileSync } from 'node:fs';
import { diagram } from './graph.mjs';

const v2 = (opts = {}) => setup({ engine: 'langgraph', ...opts });
const analyzed = async (opts) => {
  const ctx = v2(opts);
  ctx.sap.dumps = [dumpEntry('d1')];
  await ctx.watcher.checkDumps();
  return ctx;
};
const onlyProposal = (store) => store.proposals()[0];
const includeWrites = (sap) => sap.calls.filter(([t, a]) => t === 'WriteSource' && a.include === 'testclasses').map(([, a]) => a);

test('a class fix becomes an open proposal bound to what code read', async () => {
  const { sap, store, notes, models } = await analyzed();
  const p = openProposal(store);
  assert.equal(store.status().state, 'awaiting_decision');
  assert.equal(p.status, 'open');
  assert.equal(p.original.hash, sourceHash(ORIGINAL));
  assert.equal(p.fixed, FIXED);
  assert.equal(p.result.test.method, REPRO_TEST.method);
  assert.equal(p.testHash, sourceHash(sap.tests));
  assert.ok(p.token && p.view);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].priority, 'high');
  assert.equal(models.calls.investigate, 1);
  assert.ok(store.seen().has('d1'));
});

test('code appends the test class to the original include, byte for byte', async () => {
  const { sap } = await analyzed();
  const [written] = includeWrites(sap);
  assert.ok(written.source.startsWith(BASELINE_TESTS));
  assert.ok(written.source.trimEnd().endsWith(REPRO_TEST.source));
  assert.equal(written.expected_source_hash, sourceHash(BASELINE_TESTS));
});

test('a CDS fix skips the test loop', async () => {
  const { sap, store, models } = await analyzed({ result: cdsFix });
  assert.equal(openProposal(store).result.verification, 'manual_reclick');
  assert.equal(models.calls.draftTest.length, 0);
  assert.equal(sap.calls.filter(([t]) => t === 'RunUnitTests').length, 0);
});

test('a data fix is reported without a test, a fix or an Approve button', async () => {
  const { sap, store, notes, models } = await analyzed({ result: dataFix });
  const p = onlyProposal(store);
  assert.equal(p.status, 'info');
  assert.equal(p.result.data_action, dataFix.data_action);
  assert.equal(p.token, undefined);
  assert.equal(store.status().state, 'idle');
  assert.equal(notes[0].priority, 'default');
  assert.equal(models.calls.draftFix.length, 0);
  assert.equal(sap.calls.filter(([t]) => t === 'WriteSource').length, 0);
});

test('the test loop feeds each contract failure back and stops after 3 attempts', async () => {
  const sap = fakeSap();
  sap.handlers.RunUnitTests = () => unitRun(null); // the new test never fails before the fix
  const { store, models } = await analyzed({ sap });
  assert.equal(models.calls.draftTest.length, 3);
  assert.match(models.calls.draftTest[1], /passed before the fix/);
  const p = onlyProposal(store);
  assert.equal(p.result.verdict, 'unsure');
  assert.match(p.result.explanation, /Not offered for approval: after 3 attempts/);
});

test('a retry writes over its own previous attempt', async () => {
  const sap = fakeSap();
  let runs = 0;
  sap.handlers.RunUnitTests = () => unitRun(++runs === 1 ? null : DUMPED); // attempt 1 breaks the contract, attempt 2 holds
  const second = { ...REPRO_TEST, source: REPRO_TEST.source.replace('quantity = 1', 'quantity = 2') };
  const { store, models } = await analyzed({ sap, models: scriptedModels(classFix, { tests: [REPRO_TEST, second] }) });
  const [first, retry] = includeWrites(sap);
  assert.equal(retry.expected_source_hash, sourceHash(first.source));
  assert.equal(models.calls.draftTest.length, 2);
  assert.equal(openProposal(store).status, 'open');
});

test('a test include changed by somebody else between attempts stops the analysis', async () => {
  const sap = fakeSap();
  sap.handlers.RunUnitTests = () => { sap.tests = 'edited by someone'; return unitRun(null); };
  const { store } = await analyzed({ sap });
  assert.match(onlyProposal(store).result.explanation, /test include of ZCL_DL_PRICING changed/);
  assert.equal(sap.tests, 'edited by someone');
  assert.equal(includeWrites(sap).length, 1);
});

test('an include that still holds ltc_dump_repro needs a reset first', async () => {
  const sap = fakeSap();
  sap.tests = `${BASELINE_TESTS}\n\n${REPRO_TEST.source}\n`;
  const { store, models } = await analyzed({ sap });
  assert.match(onlyProposal(store).result.explanation, /reset required/);
  assert.equal(sap.calls.filter(([t]) => t === 'WriteSource').length, 0);
  assert.equal(models.calls.draftTest.length, 0);
});

test('a second rehearsal of the same class asks for a reset instead of writing a duplicate class', async () => {
  const ctx = v2();
  ctx.sap.dumps = [dumpEntry('d1')];
  assert.equal((await ctx.watcher.analyzeOnce('d1')).status, 'open');
  assert.match((await ctx.watcher.analyzeOnce('d1')).result.explanation, /reset required/);
  assert.equal(includeWrites(ctx.sap).length, 1);
});

test('a rehearsal stops before the proposal: no page, no notification', async () => {
  const ctx = v2();
  ctx.sap.dumps = [dumpEntry('d1')];
  const p = await ctx.watcher.analyzeOnce('d1');
  assert.equal(p.status, 'open');
  assert.equal(p.diff, '--- diff');
  assert.equal(ctx.notes.length, 0);
  assert.equal(ctx.store.proposals().length, 0);
  assert.equal(ctx.store.status().state, 'idle');
});

test('the fix loop feeds the problem back and stops after 2 attempts', async () => {
  const { store, models } = await analyzed({ models: scriptedModels(classFix, { fixes: [`${FIXED}\nTRY. CATCH cx_root. ENDTRY.`] }) });
  assert.equal(models.calls.draftFix.length, 2);
  assert.match(models.calls.draftFix[1], /catch-all/);
  assert.match(onlyProposal(store).result.explanation, /Not offered for approval: the fix adds a catch-all/);
});

test('a source changed while the fix was drafted is not offered', async () => {
  const sap = fakeSap();
  const models = scriptedModels(classFix);
  const draftFix = models.draftFix;
  models.draftFix = async (user) => { sap.sources.ZCL_DL_PRICING = 'someone else edited this'; return draftFix(user); };
  const { store } = await analyzed({ sap, models });
  assert.match(onlyProposal(store).result.explanation, /changed after it was read/);
});

test('an object outside the lab package is not offered', async () => {
  const sap = fakeSap();
  sap.handlers.SearchObject = () => ({ results: [{ Name: 'ZCL_DL_PRICING', PackageName: 'ZPROD' }] });
  const { store } = await analyzed({ sap });
  assert.match(onlyProposal(store).result.explanation, /not in \$ZDUMP_LAB/);
});

test('a change after the dump time means already_changed; a date without a zone is UTC', async () => {
  const sap = fakeSap();
  sap.handlers.GetRevisions = () => [{ version: '2', date: '2026-10-01T10:00:30', author: 'DEVELOPER' }];
  const { store } = await analyzed({ sap });
  assert.equal(onlyProposal(store).result.verdict, 'already_changed');
});

test('a revision before the dump does not count', async () => {
  const sap = fakeSap();
  sap.handlers.GetRevisions = () => [{ version: '1', date: '2026-10-01T09:00:00Z', author: 'DEVELOPER' }];
  const { store } = await analyzed({ sap });
  assert.equal(openProposal(store).status, 'open');
});

test('an investigation that breaks a rule across fields becomes unsure', async () => {
  const base = { verdict: 'code_fix', cause: 'x', explanation: 'y', object: { type: 'CLAS', name: 'Z' }, data_action: null, confidence: 'high' };
  assert.equal(investigationProblem(base), null);
  assert.match(investigationProblem({ ...base, object: null }), /needs object/);
  assert.match(investigationProblem({ ...base, verdict: 'data_fix', object: null }), /needs data_action/);
  assert.match(investigationProblem({ ...base, cause: 'x'.repeat(121) }), /1-120/);
  const { store } = await analyzed({ models: scriptedModels({ ...classFix, object: null }) });
  assert.equal(onlyProposal(store).result.verdict, 'unsure');
});

test('a watcher that dies while reporting sends the report after a restart, and analyzes the dump once', async () => {
  const crash = crashAt('beforePush');
  const ctx = v2({ result: dataFix, crash });
  ctx.sap.dumps = [dumpEntry('d1')];
  ctx.watcher.checkDumps(); // never answers: the watcher died with the report saved and not yet sent
  await crash.reached;
  assert.equal(ctx.notes.length, 0);
  const restarted = ctx.make();
  await restarted.recoverOnStartup();
  await restarted.checkDumps();
  assert.equal(ctx.notes.length, 1);
  assert.equal(ctx.store.proposals().length, 1);
  assert.equal(ctx.models.calls.investigate, 1);
  assert.ok(ctx.store.seen().has('d1'));
  assert.equal(ctx.store.status().state, 'idle');
});

test('a failed investigation is reported once, like v1', async () => {
  const models = scriptedModels(classFix);
  models.investigate = async () => { throw new Error('the investigation took longer than 5 minutes'); };
  const { store, notes } = await analyzed({ models });
  assert.equal(store.status().state, 'idle');
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /Couldn't analyze GETWA_NOT_ASSIGNED/);
  assert.ok(store.seen().has('d1'));
});

test('recover delivers a saved decision to its own pause only', async () => {
  const crash = crashAt('decision');
  const ctx = await analyzed({ result: cdsFix, crash });
  const p = openProposal(ctx.store);
  ctx.watcher.act('approve', p.id, p.token); // the watcher dies right after saving the decision
  await crash.reached;
  assert.equal(ctx.sap.sources.ZC_DL_ORDER, DDL);
  await ctx.make().recoverOnStartup();
  assert.equal(ctx.sap.sources.ZC_DL_ORDER, DDL_FIXED);
  assert.equal(ctx.store.status().state, 'awaiting_reclick');
  // The Approve is still on file, but the thread now waits at the re-click: nothing more is delivered.
  await ctx.make().recoverOnStartup();
  assert.equal(ctx.store.status().state, 'awaiting_reclick');
  assert.equal(ctx.sap.calls.filter(([t, a]) => t === 'WriteSource' && a.source === DDL_FIXED).length, 1);
});

test('after Reject, the next dump of the class asks for a reset', async () => {
  const ctx = await analyzed();
  const p = openProposal(ctx.store);
  assert.equal(await ctx.watcher.act('reject', p.id, p.token), 'Rejected: nothing was changed');
  ctx.sap.dumps.push(dumpEntry('d2', 'DEMO', '2026-10-01T09:59:59Z'));
  await ctx.watcher.checkDumps();
  const second = ctx.store.proposals().find((q) => q.dumpId === 'd2');
  assert.match(second.result.explanation, /reset required/);
});

test('a version that is neither the original nor the fix at write time needs a reset', async () => {
  const ctx = await analyzed();
  const p = openProposal(ctx.store);
  const read = ctx.sap.handlers.GetSource;
  let reads = 0;
  ctx.sap.handlers.GetSource = (args) => {
    const out = read(args);
    if (!args.include && ++reads === 1) ctx.sap.sources.ZCL_DL_PRICING = 'edited right after the stale check';
    return out;
  };
  assert.match(await ctx.watcher.act('approve', p.id, p.token), /^Recovery required.*neither the original nor the fix/);
  assert.equal(ctx.sap.sources.ZCL_DL_PRICING, 'edited right after the stale check');
  assert.equal(ctx.store.status().state, 'recovery_required');
});

test('docs/graph.md shows the compiled graph', async () => {
  assert.ok(readFileSync(new URL('./docs/graph.md', import.meta.url), 'utf8').includes(await diagram()));
});

// ---------- whole-class activation ----------

test('an inactive version of the target stops the analysis before any write', async () => {
  const sap = fakeSap();
  sap.inactive.ZCL_DL_PRICING = 'edited by someone'; // saved, not activated
  const { store } = await analyzed({ sap });
  assert.match(onlyProposal(store).result.explanation, /ZCL_DL_PRICING has an inactive version/);
  assert.equal(sap.calls.filter(([t]) => t === 'WriteSource' || t === 'Activate').length, 0);
  assert.equal(sap.inactive.ZCL_DL_PRICING, 'edited by someone');
});

test('a main-source edit saved while the test is drafted is never activated', async () => {
  const sap = fakeSap();
  const models = scriptedModels(classFix);
  const draftTest = models.draftTest;
  models.draftTest = async (user) => { sap.inactive.ZCL_DL_PRICING = 'edited by someone'; return draftTest(user); };
  const { store } = await analyzed({ sap, models });
  assert.match(onlyProposal(store).result.explanation, /ZCL_DL_PRICING changed after it was read/);
  assert.equal(includeWrites(sap).length, 0);
  assert.equal(sap.sources.ZCL_DL_PRICING, ORIGINAL);
  assert.equal(sap.inactive.ZCL_DL_PRICING, 'edited by someone');
});

// A4H keeps no version history for DDL sources: vsp's GetRevisions answers 404 there (2026-10-09).
test('a CDS view without revision history is analyzed without the revision check', async () => {
  const sap = fakeSap();
  sap.handlers.GetRevisions = ({ type, name }) => {
    throw new Error(`GetRevisions: GetRevisions failed: getting revisions for ${type} ${name}: ADT API error: status 404 at /sap/bc/adt/ddic/ddl/sources/${name}/source/main/versions: No suitable resource found`);
  };
  const { store } = await analyzed({ sap, result: cdsFix });
  assert.equal(onlyProposal(store).status, 'open');
});

test('any other revision error still ends the analysis', async () => {
  const sap = fakeSap();
  sap.handlers.GetRevisions = () => { throw new Error('GetRevisions: connection reset'); };
  const { store, notes } = await analyzed({ sap, result: cdsFix });
  assert.equal(store.proposals().length, 0);
  assert.match(notes[0].title, /Couldn't analyze/);
});
