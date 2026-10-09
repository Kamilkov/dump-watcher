import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOKEN_TTL_MS, createStore, resetLab, sourceHash } from './core.mjs';
import {
  DDL, DDL_FIXED, DUMPED, FIXED, ORIGINAL, agentReturning, cdsFix, classFix, crashAt, dataFix, dumpEntry, fakeSap, openProposal, setup, unitRun,
} from './test/fakes.mjs';

// ---------- the fake ----------

test('the fake SAP shows saved text at once, but runs it only after activation', async () => {
  const sap = fakeSap();
  await sap.call('UpdateClassInclude', { class_name: 'ZCL_DL_PRICING', source: 'saved tests' });
  assert.equal((await sap.call('GetSource', { name: 'ZCL_DL_PRICING', include: 'testclasses' })).source, 'saved tests');
  assert.notEqual(sap.tests, 'saved tests');
  await sap.call('Activate', { object_name: 'ZCL_DL_PRICING' });
  assert.equal(sap.tests, 'saved tests');
});

// ---------- v1 only: the Claude Code agent's output ----------

test('no JSON from the agent gives an informational unsure result', async () => {
  const { sap, store, watcher, notes } = setup({ result: null });
  sap.dumps = [dumpEntry('d1')];
  await watcher.checkDumps();
  assert.equal(store.status().state, 'idle');
  const [p] = store.proposals();
  assert.equal(p.status, 'info');
  assert.equal(p.result.verdict, 'unsure');
  assert.match(p.result.explanation, /no JSON/);
  assert.equal(notes[0].priority, 'default');
  assert.equal(p.token, undefined);
});

const unsureBecause = async (pattern, configure) => {
  const ctx = setup(configure?.setupArgs);
  configure?.before?.(ctx);
  ctx.sap.dumps = [dumpEntry('d1')];
  await ctx.watcher.checkDumps();
  const [p] = ctx.store.proposals();
  assert.equal(p.result.verdict, 'unsure');
  assert.match(p.result.explanation, pattern);
  assert.equal(ctx.store.status().state, 'idle');
  assert.equal(p.original, undefined);
};

test('a proposal without an include_hash read is not offered', () => unsureBecause(/never read/, {
  setupArgs: { runAgent: Object.assign(async () => ({ finalText: '```json\n' + JSON.stringify(classFix) + '\n```', toolResults: [] }), { runs: 0 }) },
}));

test('a source changed after the agent read it is not offered', () => {
  const sap = fakeSap();
  const agent = agentReturning(classFix, sap);
  const changing = async (summary) => { const out = await agent(summary); sap.sources.ZCL_DL_PRICING = 'someone else edited this'; return out; };
  return unsureBecause(/changed after the agent read it/, { setupArgs: { sap, runAgent: changing } });
});

test('a test that does not reproduce the dump is not offered', () => unsureBecause(/does not reproduce/, {
  before: ({ sap }) => { sap.handlers.RunUnitTests = () => unitRun(null); },
}));

test('a fix outside the lab package is not offered', () => unsureBecause(/not in \$ZDUMP_LAB/, {
  before: ({ sap }) => { sap.handlers.SearchObject = () => ({ results: [{ Name: 'ZCL_DL_PRICING', PackageName: 'ZPROD' }] }); },
}));

test('a catch-all fix is not offered', () => unsureBecause(/catch-all/, {
  setupArgs: { result: { ...classFix, fixed_source: `${FIXED}\nTRY. CATCH cx_root. ENDTRY.` } },
}));

test('a fix with syntax errors is not offered', () => unsureBecause(/syntax errors: line 3: Unknown field/, {
  before: ({ sap }) => { sap.handlers.SyntaxCheck = () => [{ line: 3, severity: 'E', text: 'Unknown field' }, { line: 1, severity: 'W', text: 'warn' }]; },
}));

test('an agent failure is reported once and not retried', async () => {
  const runAgent = Object.assign(async () => { throw new Error('the agent took longer than 5 minutes'); }, { runs: 0 });
  const { sap, store, watcher, notes } = setup({ runAgent });
  sap.dumps = [dumpEntry('d1')];
  await watcher.checkDumps();
  await watcher.checkDumps();
  assert.equal(store.status().state, 'idle');
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /Couldn't analyze GETWA_NOT_ASSIGNED/);
  assert.ok(store.seen().has('d1'));
});

// ---------- shared code, tested once ----------

test('SAP down during intake leaves the watcher idle and working', async () => {
  const { sap, store, watcher, agent } = setup();
  sap.dumps = [dumpEntry('d1')];
  sap.handlers.GetDump = () => { throw new Error('ssh: connect to host vps port 22: Connection refused'); };
  await assert.rejects(watcher.checkDumps(), /Connection refused/);
  assert.equal(store.status().state, 'idle');
  sap.handlers.GetDump = ({ dump_id }) => ({ dump: sap.dumps.find((d) => d.id === dump_id), detail: sap.detailFor(dump_id) });
  await watcher.checkDumps();
  assert.equal(agent.runs, 1);
});

test('after a trace line, the watcher polls every 2 s until the dump shows up in the feed', async () => {
  const sleeps = [];
  const ctx = setup({ sleep: async (ms) => { sleeps.push(ms); if (sleeps.length === 12) ctx.sap.dumps = [dumpEntry('d1')]; } });
  await ctx.watcher.afterTraceLine();
  assert.ok(sleeps.every((ms) => ms === 2000));
  assert.equal(ctx.agent.runs, 1);
});

test('after a trace line, polling stops 60 s after the last trace line', async () => {
  const sleeps = [];
  const { watcher, agent } = setup({ sleep: async (ms) => { sleeps.push(ms); } });
  await watcher.afterTraceLine();
  assert.equal(sleeps.length, 30);
  assert.equal(agent.runs, 0);
});

test('a trace line during polling extends the window instead of starting a second loop', async () => {
  const sleeps = [];
  let second;
  const ctx = setup({ sleep: async (ms) => { sleeps.push(ms); if (sleeps.length === 5) second = ctx.watcher.afterTraceLine(); } });
  await ctx.watcher.afterTraceLine();
  await second;
  assert.equal(sleeps.length, 35);
});

test('routine checks ask the feed for the last 15 minutes; the first start looks back 24 hours', async () => {
  const calls = [];
  const ctx = setup();
  ctx.sap.handlers.ListDumps = (args) => { calls.push(args.since); return { dumps: [] }; };
  await ctx.watcher.checkDumps();
  await ctx.watcher.ignoreOlderDumps();
  await ctx.watcher.checkDumps(24 * 60 * 60_000);
  assert.deepEqual(calls, ['2026-10-01T09:45:00Z', '2026-09-30T10:00:00Z', '2026-09-30T10:00:00Z']);
});

test('notify failing does not break the flow', async () => {
  const { sap, store, watcher } = setup({ notify: async () => { throw new Error('ntfy unreachable'); } });
  sap.dumps = [dumpEntry('d1')];
  await watcher.checkDumps();
  assert.equal(store.status().state, 'awaiting_decision');
});

test('the first start ignores older dumps', async () => {
  const { sap, store, watcher, agent } = setup();
  assert.equal(store.isFresh(), true);
  sap.dumps = [dumpEntry('old1'), dumpEntry('old2', 'DEMO', '2026-10-01T09:00:00Z')];
  assert.equal(await watcher.ignoreOlderDumps(), 2);
  assert.equal(store.isFresh(), false);
  await watcher.checkDumps();
  assert.equal(agent.runs, 0);
});

test('the analysis runs under its proposal id', async () => {
  const sap = fakeSap();
  const agent = agentReturning(classFix, sap);
  let during;
  const ctx = setup({ sap, runAgent: Object.assign(async (summary) => { during = ctx.store.status(); return agent(summary); }, { runs: 0 }) });
  sap.dumps = [dumpEntry('d1')];
  await ctx.watcher.checkDumps();
  assert.equal(during.state, 'analyzing');
  assert.equal(during.proposalId, openProposal(ctx.store).id);
});

test('reset restores the lab, checks hashes and cancels open proposals', async () => {
  const { sap, store, watcher } = setup();
  sap.dumps = [dumpEntry('d1')];
  await watcher.checkDumps();
  const p = openProposal(store);
  sap.sources.ZCL_DL_PRICING = FIXED;
  await resetLab({ vsp: sap, store }, [
    { type: 'CLAS', name: 'ZCL_DL_PRICING', include: 'testclasses', source: 'baseline tests' },
    { type: 'CLAS', name: 'ZCL_DL_PRICING', source: ORIGINAL },
  ]);
  assert.equal(sap.sources.ZCL_DL_PRICING, ORIGINAL);
  assert.equal(sap.tests, 'baseline tests');
  assert.equal(store.proposal(p.id).status, 'cancelled');
  assert.equal(store.proposal(p.id).token, undefined);
  assert.equal(store.status().state, 'idle');
});

test('reset fails loudly when an object does not match afterwards', async () => {
  const sap = fakeSap();
  sap.handlers.WriteSource = () => ({ success: true }); // pretends to write, changes nothing
  const store = createStore(mkdtempSync(join(tmpdir(), 'dump-watcher-')));
  await assert.rejects(resetLab({ vsp: sap, store }, [{ type: 'CLAS', name: 'ZCL_DL_PRICING', source: FIXED }]), /did not reset/);
});

// ---------- v1 recovery ----------

test('restart recovery: applying needs recovery, analyzing is redone', async () => {
  const a = setup();
  a.store.setStatus('applying', { proposalId: 'abc123' });
  await a.watcher.recoverOnStartup();
  assert.equal(a.store.status().state, 'recovery_required');
  assert.match(a.notes[0].body, /node watcher.mjs reset/);

  const b = setup();
  b.store.setStatus('analyzing', { dumpId: 'd1' });
  await b.watcher.recoverOnStartup();
  assert.equal(b.store.status().state, 'idle');
  b.sap.dumps = [dumpEntry('d1')];
  await b.watcher.checkDumps();
  assert.equal(b.agent.runs, 1);
});

test('v1: a "Still broken" lost to a crash ends in recovery_required at startup', async () => {
  const crash = crashAt('decision', 2); // the first decision is Approve, the second "Still broken"
  const ctx = setup({ result: cdsFix, crash });
  ctx.sap.dumps = [dumpEntry('d1')];
  await ctx.watcher.checkDumps();
  const p = openProposal(ctx.store);
  await ctx.watcher.act('approve', p.id, p.token);
  ctx.watcher.act('broken', p.id, ctx.store.proposal(p.id).token); // never answers: the watcher died
  await crash.reached;
  assert.equal(ctx.sap.sources.ZC_DL_ORDER, DDL_FIXED);
  await ctx.make().recoverOnStartup();
  assert.equal(ctx.store.status().state, 'recovery_required');
  assert.match(ctx.notes.at(-1).body, /before undoing a fix/);
});

test("a watcher that dies before sending Couldn't analyze sends it after a restart, and analyzes the dump once", async () => {
  const crash = crashAt('beforePush');
  let runs = 0;
  const runAgent = Object.assign(async () => { runs += 1; throw new Error('the agent took longer than 5 minutes'); }, { runs: 0 });
  const ctx = setup({ runAgent, crash });
  ctx.sap.dumps = [dumpEntry('d1')];
  ctx.watcher.checkDumps(); // never answers: the watcher died with the failure saved and not yet sent
  await crash.reached;
  assert.equal(ctx.notes.length, 0);
  const restarted = ctx.make();
  await restarted.recoverOnStartup();
  await restarted.checkDumps();
  assert.equal(runs, 1);
  assert.equal(ctx.notes.length, 1);
  assert.match(ctx.notes[0].title, /Couldn't analyze GETWA_NOT_ASSIGNED/);
  assert.ok(ctx.store.seen().has('d1'));
  assert.equal(ctx.store.status().state, 'idle');
});

for (const point of ['beforePush', 'push']) {
  test(`v1: a crash at ${point} while reporting never analyzes the dump twice`, async () => {
    const crash = crashAt(point);
    const ctx = setup({ result: dataFix, crash });
    ctx.sap.dumps = [dumpEntry('d1')];
    ctx.watcher.checkDumps(); // never answers: the watcher died while reporting
    await crash.reached;
    const restarted = ctx.make();
    await restarted.recoverOnStartup();
    await restarted.checkDumps();
    assert.equal(ctx.agent.runs, 1);
    assert.equal(ctx.store.proposals().length, 1);
    assert.ok(ctx.store.seen().has('d1'));
  });
}

// ---------- both engines ----------

for (const engine of ['claude', 'langgraph']) {
  const proposed = async (args = {}) => {
    const ctx = setup({ engine, ...args });
    ctx.sap.dumps = [dumpEntry('d1')];
    await ctx.watcher.checkDumps();
    const p = openProposal(ctx.store);
    return { ...ctx, p, writesOf: (source) => ctx.sap.calls.filter(([t, a]) => t === 'WriteSource' && a.source === source).length };
  };

  test(`${engine}: a new DEMO dump becomes an open, bound proposal`, async () => {
    const { sap, store, watcher, notes } = setup({ engine });
    sap.dumps = [dumpEntry('d1')];
    assert.equal(await watcher.checkDumps(), 1);
    assert.equal(await watcher.checkDumps(), 0);
    assert.equal(store.status().state, 'awaiting_decision');
    const p = openProposal(store);
    assert.equal(p.status, 'open');
    assert.equal(p.original.hash, sourceHash(ORIGINAL));
    assert.equal(p.testHash, sourceHash(sap.tests));
    assert.ok(p.token && p.view);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].priority, 'high');
    assert.equal(notes[0].click, `http://test/p/${p.id}?v=${p.view}`);
    assert.ok(store.seen().has('d1'));
  });

  test(`${engine}: dumps of other users are ignored`, async () => {
    const { sap, store, watcher, runs } = setup({ engine });
    sap.dumps = [dumpEntry('d1', 'DEVELOPER')];
    await watcher.checkDumps();
    assert.equal(runs(), 0);
    assert.equal(store.status().state, 'idle');
  });

  test(`${engine}: a dump reported by trace and poll at once is analyzed once`, async () => {
    const { sap, watcher, runs } = setup({ engine });
    sap.dumps = [dumpEntry('d1')];
    await Promise.all([watcher.checkDumps(), watcher.checkDumps()]);
    assert.equal(runs(), 1);
  });

  test(`${engine}: a repeated dump only raises the counter of the open proposal`, async () => {
    const { sap, store, watcher, runs } = setup({ engine });
    sap.dumps = [dumpEntry('d1')];
    await watcher.checkDumps();
    sap.dumps.push(dumpEntry('d2', 'DEMO', '2026-10-01T09:59:59Z'));
    await watcher.checkDumps();
    assert.equal(runs(), 1);
    assert.equal(openProposal(store).count, 2);
    assert.ok(store.seen().has('d2'));
  });

  test(`${engine}: a different dump waits until the open proposal ends, then is analyzed`, async () => {
    const { sap, store, watcher, runs, tick } = setup({ engine });
    sap.detailFor = (id) => ({ ...fakeSap().detailFor(id), line: id === 'd2' ? 99 : 14 });
    sap.dumps = [dumpEntry('d1')];
    await watcher.checkDumps();
    sap.dumps.push(dumpEntry('d2', 'DEMO', '2026-10-01T09:59:59Z'));
    await watcher.checkDumps();
    assert.equal(runs(), 1);
    tick(TOKEN_TTL_MS + 1);
    await watcher.expireOpen();
    await watcher.checkDumps();
    assert.equal(runs(), 2);
    assert.equal(store.proposals().filter((p) => p.status === 'expired').length, 1);
  });

  test(`${engine}: using a token records the decision in the same save`, async () => {
    const { store, watcher, p } = await proposed();
    await watcher.act('reject', p.id, p.token);
    assert.deepEqual(store.proposal(p.id).pending, { action: 'reject', pause: 'awaiting_decision' });
  });

  test(`${engine}: expiry is recorded as a decision too`, async () => {
    const { store, watcher, p, tick } = await proposed();
    tick(TOKEN_TTL_MS + 1);
    await watcher.expireOpen();
    const expired = store.proposal(p.id);
    assert.deepEqual(expired.pending, { action: 'expire', pause: 'awaiting_decision' });
    assert.equal(expired.status, 'expired');
  });

  test(`${engine}: approve applies exactly the reviewed fix and verifies it`, async () => {
    const { sap, store, watcher, notes, p, writesOf } = await proposed();
    assert.equal(await watcher.act('approve', p.id, p.token), 'Fixed ✅ Tests pass');
    const write = sap.calls.find(([t, a]) => t === 'WriteSource' && a.source === FIXED)[1];
    assert.equal(write.expected_source_hash, sourceHash(ORIGINAL));
    assert.equal(writesOf(FIXED), 1);
    assert.equal(store.status().state, 'idle');
    assert.equal(store.proposal(p.id).status, 'fixed');
    assert.equal(notes.at(-1).body, 'Fixed ✅ Tests pass');
  });

  test(`${engine}: a double tap writes the fix once`, async () => {
    const { watcher, p, writesOf } = await proposed();
    const answers = await Promise.all([watcher.act('approve', p.id, p.token), watcher.act('approve', p.id, p.token)]);
    assert.equal(writesOf(FIXED), 1);
    assert.equal(answers.filter((a) => a.startsWith('Fixed')).length, 1);
  });

  test(`${engine}: an expired or wrong token is refused`, async () => {
    const { watcher, p, tick, writesOf } = await proposed();
    assert.equal(await watcher.act('approve', p.id, 'not-the-token'), 'Invalid or expired link');
    tick(TOKEN_TTL_MS + 1);
    assert.equal(await watcher.act('approve', p.id, p.token), 'Invalid or expired link');
    assert.equal(writesOf(FIXED), 0);
  });

  test(`${engine}: changed tests make the proposal stale without writing`, async () => {
    const { sap, store, watcher, p, writesOf } = await proposed();
    sap.tests = 'someone changed the tests';
    assert.match(await watcher.act('approve', p.id, p.token), /Stale: the tests changed/);
    assert.equal(writesOf(FIXED), 0);
    assert.equal(store.status().state, 'idle');
  });

  test(`${engine}: a changed source makes the proposal stale without writing`, async () => {
    const { sap, store, watcher, p } = await proposed();
    sap.sources.ZCL_DL_PRICING = 'someone else edited this';
    assert.match(await watcher.act('approve', p.id, p.token), /Stale: ZCL_DL_PRICING changed/);
    assert.equal(sap.sources.ZCL_DL_PRICING, 'someone else edited this');
    assert.equal(store.proposal(p.id).status, 'stale');
    assert.equal(store.status().state, 'idle');
  });

  test(`${engine}: failing tests after the fix lead to a verified restore`, async () => {
    const sap = fakeSap();
    sap.handlers.RunUnitTests = () => unitRun(DUMPED);
    const { store, watcher, p } = await proposed({ sap });
    assert.match(await watcher.act('approve', p.id, p.token), /^Reverted ❌ the new test still fails/);
    assert.equal(sap.sources.ZCL_DL_PRICING, ORIGINAL);
    assert.equal(store.status().state, 'idle');
  });

  test(`${engine}: a failed write restores the original`, async () => {
    const sap = fakeSap();
    const write = sap.handlers.WriteSource;
    sap.handlers.WriteSource = (args) => {
      if (args.source === FIXED) throw new Error('WriteSource: lock failed');
      return write(args);
    };
    const { watcher, p } = await proposed({ sap });
    assert.match(await watcher.act('approve', p.id, p.token), /^Reverted ❌ writing the fix failed/);
    assert.equal(sap.sources.ZCL_DL_PRICING, ORIGINAL);
  });

  test(`${engine}: a failed restore requires recovery and blocks further work`, async () => {
    const sap = fakeSap();
    sap.handlers.RunUnitTests = () => unitRun(DUMPED);
    const write = sap.handlers.WriteSource;
    sap.handlers.WriteSource = (args) => {
      if (args.source === ORIGINAL) throw new Error('WriteSource: connection reset');
      return write(args);
    };
    const { store, watcher, p, runs } = await proposed({ sap });
    assert.match(await watcher.act('approve', p.id, p.token), /^Recovery required/);
    assert.equal(store.status().state, 'recovery_required');
    sap.dumps.push(dumpEntry('d2', 'DEMO', '2026-10-01T09:59:59Z'));
    sap.detailFor = (id) => ({ ...fakeSap().detailFor(id), line: 77 });
    await watcher.checkDumps();
    assert.equal(runs(), 1);
    assert.equal(await watcher.act('approve', p.id, p.token), 'This proposal is no longer open');
  });

  test(`${engine}: a restore that cannot be verified requires recovery`, async () => {
    const sap = fakeSap();
    sap.handlers.RunUnitTests = () => unitRun(DUMPED);
    const { store, watcher, p } = await proposed({ sap });
    const write = sap.handlers.WriteSource;
    // The restore "succeeds", but SAP ends up with something other than the original.
    sap.handlers.WriteSource = (args) => write(args.source === ORIGINAL ? { ...args, source: `${ORIGINAL}\n* drift` } : args);
    assert.match(await watcher.act('approve', p.id, p.token), /^Recovery required/);
    assert.equal(store.status().state, 'recovery_required');
  });

  test(`${engine}: a CDS fix waits for the re-click, then is confirmed`, async () => {
    const { sap, store, watcher, p } = await proposed({ result: cdsFix });
    assert.equal(p.testHash, undefined);
    assert.equal(await watcher.act('approve', p.id, p.token), 'Applied: open the value help to confirm');
    assert.equal(sap.sources.ZC_DL_ORDER, DDL_FIXED);
    assert.equal(store.status().state, 'awaiting_reclick');
    const applied = store.proposal(p.id);
    assert.ok(applied.token && applied.token !== p.token);
    assert.equal(sap.calls.filter(([t]) => t === 'RunUnitTests').length, 0);
    assert.equal(await watcher.act('works', p.id, applied.token), 'Fixed ✅ (confirmed by re-click)');
    assert.equal(store.status().state, 'idle');
  });

  test(`${engine}: a CDS fix that is still broken is restored`, async () => {
    const { sap, store, watcher, p } = await proposed({ result: cdsFix });
    await watcher.act('approve', p.id, p.token);
    assert.match(await watcher.act('broken', p.id, store.proposal(p.id).token), /^Reverted ❌ still broken after re-click/);
    assert.equal(sap.sources.ZC_DL_ORDER, DDL);
  });

  test(`${engine}: "Still broken" after somebody else edited the object leaves their edit alone`, async () => {
    const { sap, store, watcher, p } = await proposed({ result: cdsFix });
    await watcher.act('approve', p.id, p.token);
    sap.sources.ZC_DL_ORDER = 'edited by someone';
    assert.match(await watcher.act('broken', p.id, store.proposal(p.id).token), /^Recovery required/);
    assert.equal(sap.sources.ZC_DL_ORDER, 'edited by someone');
    assert.equal(store.status().state, 'recovery_required');
  });

  test(`${engine}: a restore that finds the original already back writes nothing`, async () => {
    const { sap, store, watcher, p, writesOf } = await proposed({ result: cdsFix });
    await watcher.act('approve', p.id, p.token);
    sap.sources.ZC_DL_ORDER = DDL;
    assert.match(await watcher.act('broken', p.id, store.proposal(p.id).token), /^Reverted ❌ still broken after re-click/);
    assert.equal(writesOf(DDL), 0);
  });

  test(`${engine}: no re-click within an hour leaves the fix applied, unconfirmed`, async () => {
    const { sap, store, watcher, p, tick } = await proposed({ result: cdsFix });
    await watcher.act('approve', p.id, p.token);
    tick(TOKEN_TTL_MS + 1);
    await watcher.expireOpen();
    assert.equal(store.proposal(p.id).status, 'expired');
    assert.equal(sap.sources.ZC_DL_ORDER, DDL_FIXED);
    assert.equal(store.status().state, 'idle');
  });

  test(`${engine}: reject writes nothing`, async () => {
    const { store, watcher, p, writesOf } = await proposed();
    assert.equal(await watcher.act('reject', p.id, p.token), 'Rejected: nothing was changed');
    assert.equal(writesOf(FIXED), 0);
    assert.equal(store.status().state, 'idle');
  });
}
