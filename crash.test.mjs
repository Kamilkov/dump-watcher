// Crash equivalence (spec section 9): a run stopped anywhere and restarted ends like a run never stopped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DDL, DDL_FIXED, DUMPED, FIXED, ORIGINAL, cdsFix, classFix, dataFix, dumpEntry, fakeSap, openProposal, scriptedModels, setup, unitRun } from './test/fakes.mjs';

const ACTIONABLE = new Set(['awaiting_decision', 'awaiting_reclick']);
const PATHS = {
  'class fix, approved': { result: classFix, answers: ['approve'] },
  'class fix, tests fail after it': { result: classFix, answers: ['approve'], sap: (sap) => { sap.handlers.RunUnitTests = () => unitRun(DUMPED); } },
  'class fix, the restore fails': {
    result: classFix, answers: ['approve'],
    sap: (sap) => {
      sap.handlers.RunUnitTests = () => unitRun(DUMPED);
      const write = sap.handlers.WriteSource;
      sap.handlers.WriteSource = (args) => { if (args.source === ORIGINAL) throw new Error('WriteSource: connection reset'); return write(args); };
    },
  },
  'class fix, the fix draft fails': {
    result: classFix, answers: [],
    models: () => ({ ...scriptedModels(classFix), draftFix: async () => { throw new Error('the model is overloaded'); } }),
  },
  'CDS fix, works': { result: cdsFix, answers: ['approve', 'works'] },
  'CDS fix, still broken': { result: cdsFix, answers: ['approve', 'broken'] },
  'class fix, rejected': { result: classFix, answers: ['reject'] },
  'data fix': { result: dataFix, answers: [] },
};

// Answers each pause the way the phone would, until the flow ends.
async function drive({ watcher, store }, answers) {
  await watcher.checkDumps();
  for (;;) {
    const s = store.status();
    if (!ACTIONABLE.has(s.state)) return;
    const p = store.proposal(s.proposalId);
    const answer = await watcher.act(answers[s.state === 'awaiting_decision' ? 0 : 1], p.id, p.token);
    if (['Invalid or expired link', 'This proposal is no longer open'].includes(answer)) throw new Error(`stuck at ${s.state}: ${answer}`);
  }
}

// Every proposal and every seen dump, so a second analysis of the same dump shows up.
const snapshot = ({ store, sap }) => ({
  state: store.status().state,
  proposals: store.proposals()
    .map((p) => ({ dumpId: p.dumpId, status: p.status, verdict: p.result.verdict, cause: p.result.cause, fixedHash: p.fixedHash, testHash: p.testHash, testSource: p.testSource, count: p.count }))
    .sort((a, b) => a.dumpId.localeCompare(b.dumpId)),
  seen: [...store.seen()].sort(),
  sources: { ...sap.sources }, tests: sap.tests, inactive: { ...sap.inactive },
});

// One run of a path. With `stopAt`, the run stops for good at that pass of that crash point.
function start(name, stopAt) {
  const path = PATHS[name];
  const sap = fakeSap();
  path.sap?.(sap);
  const passed = [];
  let stopped;
  const reached = new Promise((resolve) => { stopped = resolve; });
  let armed = stopAt;
  const crash = async (point) => {
    passed.push(point);
    if (armed && point === armed.point && passed.filter((p) => p === point).length === armed.nth) {
      armed = null;
      stopped();
      await new Promise(() => {});
    }
  };
  const ctx = setup({ engine: 'langgraph', sap, result: path.result, models: path.models?.(), crash });
  sap.dumps = [dumpEntry('d1')];
  return { ctx, path, passed, reached };
}

for (const name of Object.keys(PATHS)) {
  test(`crash equivalence: ${name}`, async () => {
    const reference = start(name);
    await drive(reference.ctx, reference.path.answers);
    const expected = snapshot(reference.ctx);
    const counts = {};
    const stops = reference.passed.map((point) => ({ point, nth: (counts[point] = (counts[point] ?? 0) + 1) }));
    assert.ok(stops.length >= 3, 'the run passed its crash points');

    for (const stop of stops) {
      const label = `${stop.point} #${stop.nth}`;
      const run = start(name, stop);
      drive(run.ctx, run.path.answers).catch(() => {});
      await run.reached;
      const calls = run.ctx.sap.calls.length;
      const pushes = run.ctx.notes.length;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(run.ctx.sap.calls.length, calls, `${label}: SAP was called after the stop`);
      assert.equal(run.ctx.notes.length, pushes, `${label}: a push went out after the stop`);

      const restarted = { ...run.ctx, watcher: run.ctx.make() };
      await restarted.watcher.recoverOnStartup();
      await drive(restarted, run.path.answers);

      assert.deepEqual(snapshot(run.ctx), expected, `${label}: the end state differs`);
      for (const sent of reference.ctx.notes) {
        assert.ok(run.ctx.notes.some((n) => n.title === sent.title && n.body === sent.body), `${label}: "${sent.body}" was never sent`);
      }
      assert.ok(run.ctx.notes.length <= reference.ctx.notes.length + 1, `${label}: more than one repeated push`);
      for (const [, args] of run.ctx.sap.calls.filter(([t]) => t === 'WriteSource')) {
        assert.ok(args.expected_source_hash, `${label}: a write without a precondition`);
      }
    }
  });
}

// Saved is not active: vsp saves, unlocks, then activates. These stop in between.
function stopOnce(sap, key) {
  let stopped;
  const saved = new Promise((resolve) => { stopped = resolve; });
  sap.stopBeforeActivate = (k) => {
    if (k !== key || !stopped) return false;
    stopped();
    stopped = null;
    return true;
  };
  return saved;
}
const after = (sap, from) => sap.calls.slice(from).map(([t]) => t);

test('a fix saved but not activated is activated before the tests run', async () => {
  const ctx = setup({ engine: 'langgraph' });
  ctx.sap.dumps = [dumpEntry('d1')];
  await ctx.watcher.checkDumps();
  const p = openProposal(ctx.store);
  const saved = stopOnce(ctx.sap, 'ZCL_DL_PRICING');
  ctx.watcher.act('approve', p.id, p.token); // WriteSource saves the fix, then the watcher dies
  await saved;
  assert.equal(ctx.sap.inactive.ZCL_DL_PRICING, FIXED);
  assert.equal(ctx.sap.sources.ZCL_DL_PRICING, ORIGINAL);
  const from = ctx.sap.calls.length;
  await ctx.make().recoverOnStartup();
  const calls = after(ctx.sap, from);
  assert.ok(calls.indexOf('Activate') >= 0 && calls.indexOf('Activate') < calls.indexOf('RunUnitTests'));
  assert.equal(ctx.store.proposal(p.id).status, 'fixed');
  assert.equal(ctx.sap.sources.ZCL_DL_PRICING, FIXED);
});

test('a saved fix that will not activate ends in recovery_required, and no test runs', async () => {
  const ctx = setup({ engine: 'langgraph' });
  ctx.sap.dumps = [dumpEntry('d1')];
  await ctx.watcher.checkDumps();
  const p = openProposal(ctx.store);
  const saved = stopOnce(ctx.sap, 'ZCL_DL_PRICING');
  ctx.watcher.act('approve', p.id, p.token);
  await saved;
  ctx.sap.activationError = 'syntax error in line 4';
  const from = ctx.sap.calls.length;
  await ctx.make().recoverOnStartup();
  assert.equal(ctx.store.status().state, 'recovery_required');
  assert.ok(!after(ctx.sap, from).includes('RunUnitTests'));
  assert.ok(!ctx.notes.some((n) => /^Fixed/.test(n.body)));
});

test('a restore saved but not activated is activated before "Reverted" goes out', async () => {
  const ctx = setup({ engine: 'langgraph', result: cdsFix });
  ctx.sap.dumps = [dumpEntry('d1')];
  await ctx.watcher.checkDumps();
  const p = openProposal(ctx.store);
  await ctx.watcher.act('approve', p.id, p.token);
  const saved = stopOnce(ctx.sap, 'ZC_DL_ORDER');
  ctx.watcher.act('broken', p.id, ctx.store.proposal(p.id).token);
  await saved;
  assert.equal(ctx.sap.inactive.ZC_DL_ORDER, DDL);
  assert.equal(ctx.sap.sources.ZC_DL_ORDER, DDL_FIXED);
  assert.ok(!ctx.notes.some((n) => /^Reverted/.test(n.body)));
  await ctx.make().recoverOnStartup();
  assert.equal(ctx.sap.sources.ZC_DL_ORDER, DDL);
  assert.match(ctx.notes.at(-1).body, /^Reverted ❌ still broken after re-click/);
});

test('a test include saved but not activated is activated before the contract runs', async () => {
  const ctx = setup({ engine: 'langgraph' });
  ctx.sap.dumps = [dumpEntry('d1')];
  const saved = stopOnce(ctx.sap, 'ZCL_DL_PRICING/testclasses');
  ctx.watcher.checkDumps(); // never answers: the watcher dies inside the analysis
  await saved;
  const from = ctx.sap.calls.length;
  await ctx.make().recoverOnStartup();
  const calls = after(ctx.sap, from);
  assert.ok(calls.indexOf('Activate') >= 0 && calls.indexOf('Activate') < calls.indexOf('RunUnitTests'));
  assert.equal(ctx.models.calls.draftTest.length, 1); // the first run after the restart already found the test
  assert.equal(ctx.store.status().state, 'awaiting_decision');
  assert.ok(ctx.store.seen().has('d1'));
});

// Writing one part of a class activates all of it. A part somebody else saved stays inactive.
test('a replayed test-include write leaves a main-source edit made meanwhile inactive', async () => {
  const ctx = setup({ engine: 'langgraph' });
  ctx.sap.dumps = [dumpEntry('d1')];
  const saved = stopOnce(ctx.sap, 'ZCL_DL_PRICING/testclasses');
  ctx.watcher.checkDumps(); // never answers: the watcher dies inside the analysis
  await saved;
  ctx.sap.inactive.ZCL_DL_PRICING = 'edited by someone'; // saved while the watcher was down
  const from = ctx.sap.calls.length;
  await ctx.make().recoverOnStartup();
  assert.ok(!after(ctx.sap, from).includes('Activate'));
  assert.equal(ctx.sap.sources.ZCL_DL_PRICING, ORIGINAL);
  assert.equal(ctx.sap.inactive.ZCL_DL_PRICING, 'edited by someone');
  assert.match(ctx.store.proposals()[0].result.explanation, /ZCL_DL_PRICING changed after it was read/);
});

test('a replayed fix write leaves a test-include edit made meanwhile inactive', async () => {
  const ctx = setup({ engine: 'langgraph' });
  ctx.sap.dumps = [dumpEntry('d1')];
  await ctx.watcher.checkDumps();
  const p = openProposal(ctx.store);
  const saved = stopOnce(ctx.sap, 'ZCL_DL_PRICING');
  ctx.watcher.act('approve', p.id, p.token); // WriteSource saves the fix, then the watcher dies
  await saved;
  ctx.sap.inactive['ZCL_DL_PRICING/testclasses'] = 'edited by someone';
  const from = ctx.sap.calls.length;
  await ctx.make().recoverOnStartup();
  assert.ok(!after(ctx.sap, from).includes('Activate'));
  assert.equal(ctx.sap.sources.ZCL_DL_PRICING, ORIGINAL);
  assert.equal(ctx.sap.inactive['ZCL_DL_PRICING/testclasses'], 'edited by someone');
  assert.equal(ctx.store.status().state, 'recovery_required');
});
