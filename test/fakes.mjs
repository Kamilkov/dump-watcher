// Test doubles shared by the test files: a fake SAP with saved and active versions, a scripted
// agent, and a watcher on a temporary state folder.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeEngine, createStore, createWatcher, sourceHash } from '../core.mjs';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { createLanggraphEngine } from '../graph.mjs';

export const ORIGINAL = "CLASS zcl_dl_pricing IMPLEMENTATION.\n  METHOD discount_pct.\n    RAISE SHORTDUMP TYPE zcx_dl_config_missing.\n    result = <tier>-discount_pct.\n  ENDMETHOD.\nENDCLASS.";
export const FIXED = ORIGINAL.replace('result = <tier>-discount_pct.', 'IF <tier> IS ASSIGNED.\n      result = <tier>-discount_pct.\n    ENDIF.');
export const DDL = "define view entity ZC_DL_Order { @Consumption.valueHelpDefinition: [{ entity: { name: 'ZC_DL_Order' } }] Customer }";
export const DDL_FIXED = DDL.replace("name: 'ZC_DL_Order'", "name: 'ZI_DL_CustomerVH'");
export const BASELINE_TESTS = 'CLASS ltc_pricing DEFINITION FOR TESTING.\nENDCLASS.\nCLASS ltc_pricing IMPLEMENTATION.\nENDCLASS.';
export const DUMPED = [{ kind: 'exception', severity: 'critical', title: 'Runtime Error GETWA_NOT_ASSIGNED' }];

export const REPRO_TEST = {
  source: "CLASS ltc_dump_repro DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.\n  PRIVATE SECTION.\n    METHODS small_order_has_no_discount FOR TESTING.\nENDCLASS.\n\nCLASS ltc_dump_repro IMPLEMENTATION.\n  METHOD small_order_has_no_discount.\n    cl_abap_unit_assert=>assert_equals( act = zcl_dl_pricing=>discount_pct( quantity = 1 currency = 'EUR' ) exp = 0 ).\n  ENDMETHOD.\nENDCLASS.",
  method: 'small_order_has_no_discount',
};
const holdsRepro = (source) => /\bclass\s+ltc_dump_repro\s+definition\b/i.test(source);

// A test run. Without `repro`, the reproduction test is missing from the run, as when its include isn't active.
export function unitRun(reproAlerts, { repro = true } = {}) {
  return { classes: [
    { name: 'LTC_PRICING', testMethods: [{ name: 'MEDIUM_ORDER_GETS_5_PERCENT' }] },
    ...(repro ? [{ name: 'LTC_DUMP_REPRO', testMethods: [{ name: 'SMALL_ORDER_HAS_NO_DISCOUNT', ...(reproAlerts ? { alerts: reproAlerts } : {}) }] }] : []),
  ] };
}

const keyOf = (name, include) => (include ? `${name.toUpperCase()}/${include}` : name.toUpperCase());

export function fakeSap() {
  const sap = {
    sources: { ZCL_DL_PRICING: ORIGINAL, ZC_DL_ORDER: DDL }, // the active versions
    tests: BASELINE_TESTS, // the active test include of ZCL_DL_PRICING
    inactive: {}, // saved but not activated, by NAME or NAME/testclasses: reads see these, tests don't
    stopBeforeActivate: null, // (key) => true: WriteSource saves, then never answers, as if the watcher died mid-call
    activationError: null, // a text: every activation fails, the way SAP refuses a syntax error
    dumps: [],
    detailFor: (id) => ({ errorType: 'GETWA_NOT_ASSIGNED', program: 'ZCL_DL_PRICING===CP', include: 'ZCL_DL_PRICING===CM001', line: 14, procedure: 'DISCOUNT_PCT', mainProgram: 'SAPMHTTP', stack: [], source: [], variables: [] }),
    calls: [],
    saved: (name, include) => sap.inactive[keyOf(name, include)] ?? (include === 'testclasses' ? sap.tests : sap.sources[name.toUpperCase()]),
    activate(name) {
      if (sap.activationError) throw new Error(`Activate: activation failed: ${sap.activationError}`);
      for (const [key, source] of Object.entries(sap.inactive)) {
        const [object, include] = key.split('/');
        if (object !== name.toUpperCase()) continue;
        if (include === 'testclasses') sap.tests = source; else sap.sources[object] = source;
        delete sap.inactive[key];
      }
    },
    handlers: {
      ListDumps: () => ({ dumps: sap.dumps }),
      GetDump: ({ dump_id }) => ({ dump: sap.dumps.find((d) => d.id === dump_id), detail: sap.detailFor(dump_id) }),
      SearchObject: ({ query }) => [{ Name: query.toUpperCase(), PackageName: '$ZDUMP_LAB' }],
      SyntaxCheck: () => null,
      GetRevisions: () => [],
      GetInactiveObjects: () => Object.keys(sap.inactive).map((key) => ({ object: { name: key.split('/')[0] } })),
      GetSource: ({ name, include }) => {
        const source = sap.saved(name, include);
        return { source, sourceHash: sourceHash(source) };
      },
      // Active code only: the reproduction test runs once its include is active.
      RunUnitTests: () => unitRun(sap.sources.ZCL_DL_PRICING === FIXED ? null : DUMPED, { repro: holdsRepro(sap.tests) }),
      WriteSource: ({ name, include, source, expected_source_hash, package: pkg }) => {
        if (pkg !== '$ZDUMP_LAB') throw new Error('WriteSource: an explicit package is required');
        if (expected_source_hash && expected_source_hash !== sourceHash(sap.saved(name, include))) throw new Error('WriteSource: SOURCE_DRIFT: expected source hash differs');
        const key = keyOf(name, include);
        sap.inactive[key] = source;
        if (sap.stopBeforeActivate?.(key)) return new Promise(() => {});
        sap.activate(name);
        return { success: true };
      },
      UpdateClassInclude: ({ class_name, source }) => { sap.inactive[keyOf(class_name, 'testclasses')] = source; return 'Class include updated successfully'; },
      Activate: ({ object_name }) => { sap.activate(object_name); return { success: true }; },
    },
    async call(tool, args) {
      sap.calls.push([tool, args]);
      const handler = sap.handlers[tool];
      if (!handler) throw new Error(`unexpected tool ${tool}`);
      return handler(args);
    },
  };
  return sap;
}

export const classFix = {
  verdict: 'code_fix', cause: 'Orders under 10 units match no discount tier.', explanation: 'The loop leaves <tier> unassigned.',
  object: { type: 'CLAS', name: 'ZCL_DL_PRICING' }, fixed_source: FIXED,
  test: { class: 'LTC_DUMP_REPRO', method: 'small_order_has_no_discount' }, verification: 'unit_test', confidence: 'high',
};
export const cdsFix = { ...classFix, object: { type: 'DDLS', name: 'ZC_DL_ORDER' }, fixed_source: DDL_FIXED, test: null, verification: 'manual_reclick' };

export const dataFix = {
  verdict: 'data_fix', cause: 'Currency XYZ has no ZDL_CONFIG entry.', explanation: 'The pricing class stops with a short dump when a currency has no configuration, by design.',
  data_action: 'Maintain ZDL_CONFIG for currency XYZ.', confidence: 'high',
};

// The v2 counterpart of agentReturning: answers in the shape of models.mjs, from the same v1 result.
export function scriptedModels(result, { tests = [REPRO_TEST], fixes } = {}) {
  const calls = { investigate: 0, draftTest: [], draftFix: [] };
  const pick = (list, n) => list[Math.min(n, list.length) - 1];
  return {
    calls,
    async investigate() {
      calls.investigate += 1;
      if (result === null) return { verdict: 'unsure', cause: 'I could not decide.', explanation: 'No cause found.', object: null, data_action: null, confidence: 'low' };
      const { verdict, cause, explanation, object = null, data_action = null, confidence } = result;
      return { verdict, cause, explanation, object, data_action, confidence };
    },
    async draftTest(user) {
      calls.draftTest.push(user);
      return pick(tests, calls.draftTest.length);
    },
    async draftFix(user) {
      calls.draftFix.push(user);
      return { source: pick(fixes ?? [result.fixed_source], calls.draftFix.length), rationale: 'Guard the unassigned field symbol.' };
    },
  };
}

export function agentReturning(result, sap, { readName = result?.object?.name ?? 'ZCL_DL_PRICING' } = {}) {
  const agent = async () => {
    agent.runs += 1;
    // The real agent writes and activates its reproduction test before it answers.
    if (result?.test && !holdsRepro(sap.tests)) sap.tests = `${sap.tests}\n\n${REPRO_TEST.source}\n`;
    const source = sap.sources[readName];
    return {
      finalText: result === null ? 'I could not decide.' : `Done.\n\`\`\`json\n${JSON.stringify(result)}\n\`\`\``,
      toolResults: readName ? [{ name: 'mcp__vsp-lab__GetSource', input: { name: readName, include_hash: true }, output: JSON.stringify({ source, sourceHash: sourceHash(source) }), isError: false }] : [],
    };
  };
  agent.runs = 0;
  return agent;
}

export const dumpEntry = (id, user = 'DEMO', at = '2026-10-01T09:59:58Z') => ({ id, at, user, errorType: 'GETWA_NOT_ASSIGNED', program: 'ZCL_DL_PRICING===CP', message: 'x' });

export function setup({ engine = 'claude', sap = fakeSap(), result = classFix, runAgent, models, notify, sleep, crash } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dump-watcher-'));
  const store = createStore(dir);
  const notes = [];
  let clock = Date.parse('2026-10-01T10:00:00Z');
  const agent = runAgent ?? agentReturning(result, sap);
  const scripted = models ?? scriptedModels(result);
  const engineFor = engine === 'langgraph'
    // Each watcher opens the checkpoint file again, as a restarted watcher would.
    ? (ctx) => createLanggraphEngine(ctx, { models: scripted, checkpointer: SqliteSaver.fromConnString(join(dir, 'graph.sqlite')) })
    : claudeEngine;
  // Another watcher over the same state folder, fake SAP, notes and clock: a restart.
  const make = (extra = {}) => createWatcher({
    vsp: sap, store, runAgent: agent, diff: async () => '--- diff', demoUser: 'DEMO', log: () => {},
    notify: notify ?? (async (n) => { notes.push(n); }),
    pageUrl: (id, view) => `http://test/p/${id}?v=${view}`,
    now: () => clock,
    sleep: async (ms) => { clock += ms; await sleep?.(ms); },
    engine: engineFor,
    ...(crash ? { crash } : {}),
    ...extra,
  });
  return {
    sap, store, dir, watcher: make(), make, notes, agent, models: scripted,
    runs: () => (engine === 'langgraph' ? scripted.calls.investigate : agent.runs),
    tick: (ms) => { clock += ms; },
  };
}

export const openProposal = (store) => store.proposal(store.status().proposalId);

// Stops the flow at the nth pass of a crash point, the way SIGKILL would: nothing after it runs.
// `reached` settles once it has stopped.
export function crashAt(point, nth = 1) {
  let seen = 0;
  let stopped;
  const hook = async (p) => {
    if (p !== point || ++seen !== nth) return;
    stopped();
    await new Promise(() => {});
  };
  hook.reached = new Promise((resolve) => { stopped = resolve; });
  return hook;
}
