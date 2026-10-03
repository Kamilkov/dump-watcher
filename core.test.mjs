import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dumpKey, isDumpSavedLine, newDemoDumps, objectUrl, sourceHash, summarizeDump } from './core.mjs';

test('only the dump-saved trace line counts', () => {
  assert.equal(isDumpSavedLine('A  ** RABAX: level LEV_RX_ERROR_SAVE completed.'), true);
  assert.equal(isDumpSavedLine('A  ** RABAX: level LEV_RX_ERROR_SAVE entered.'), false);
  assert.equal(isDumpSavedLine('A  ** RABAX: level LEV_RX_END completed.'), false);
});

test('new dumps are DEMO dumps not seen yet, oldest first', () => {
  const list = { dumps: [
    { id: 'c', at: '2026-10-01T10:02:00Z', user: 'DEMO' },
    { id: 'a', at: '2026-10-01T10:00:00Z', user: 'DEMO' },
    { id: 'b', at: '2026-10-01T10:01:00Z', user: 'DEVELOPER' },
    { id: 'd', at: '2026-10-01T09:00:00Z', user: 'DEMO' },
  ] };
  assert.deepEqual(newDemoDumps(list, new Set(['d']), 'DEMO').map((d) => d.id), ['a', 'c']);
  assert.deepEqual(newDemoDumps(null, new Set(), 'DEMO'), []);
});

test('the dump key is runtime error, program, include and line', () => {
  assert.equal(dumpKey({ errorType: 'E', program: 'P', include: 'I', line: 5 }), 'E|P|I|5');
});

test('sourceHash matches vsp: CRLF and trailing newlines do not count', () => {
  const expected = 'sha256:' + createHash('sha256').update('a\nb').digest('hex');
  assert.equal(sourceHash('a\r\nb\n\n'), expected);
  assert.equal(sourceHash('a\nb'), expected);
});

test('object URLs for classes and CDS views', () => {
  assert.equal(objectUrl('CLAS', 'ZCL_DL_PRICING'), '/sap/bc/adt/oo/classes/zcl_dl_pricing');
  assert.equal(objectUrl('DDLS', 'ZC_DL_ORDER'), '/sap/bc/adt/ddic/ddl/sources/zc_dl_order');
  assert.throws(() => objectUrl('PROG', 'X'));
});

test('the summary of a real dump keeps the facts and stays small', () => {
  const text = summarizeDump(JSON.parse(readFileSync('test/fixtures/dump-case1.json', 'utf8')));
  assert.match(text, /Runtime error: GETWA_NOT_ASSIGNED/);
  assert.match(text, /ZCL_DL_PRICING/);
  assert.match(text, /the line where the dump stopped is missing/);
  assert.ok(text.length < 20_000, `summary has ${text.length} characters`);
});

test('variables are kept only when they mention Z objects or CX_ classes, cut to 200 characters', () => {
  const text = summarizeDump({
    dump: { at: '2026-10-01T10:00:00Z', user: 'DEMO' },
    detail: { errorType: 'E', program: 'P', include: 'I', line: 1, procedure: 'X', mainProgram: 'M', stack: [], source: [], variables: [
      { frame: 'F', name: 'SY-SUBRC', value: '0 0000' },
      { frame: 'F', name: 'LO_ERROR', value: `{O:1*\\CLASS=CX_SADL_GW_V4_MODEL_EXCEPTION} ${'x'.repeat(500)}` },
      { frame: 'F', name: 'ENTITY', value: 'ZC_SCEPLAYERVH 5455' },
    ] },
  });
  assert.doesNotMatch(text, /SY-SUBRC/);
  assert.match(text, /LO_ERROR/);
  assert.match(text, /ZC_SCEPLAYERVH/);
  assert.ok(!text.includes('x'.repeat(201)));
});

import {
  agentArgs, checkTestContract, extractResultJson, findBoundSource, forbiddenReason,
  parseAgentStream, renderPage, validateResult,
} from './core.mjs';

const fixture = (name) => JSON.parse(readFileSync(`test/fixtures/${name}`, 'utf8'));

test('the agent runs with exactly the isolation flags from the spec', () => {
  const args = agentArgs();
  for (const flag of ['-p', '--restricted', '--strict-mcp-config', '--verbose']) assert.ok(args.includes(flag), flag);
  const after = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(after('--tools'), '');
  assert.equal(after('--permission-mode'), 'dontAsk');
  assert.equal(after('--output-format'), 'stream-json');
  assert.equal(after('--settings'), 'agent/settings.json');
  assert.equal(after('--mcp-config'), '.mcp.json');
  assert.equal(after('--append-system-prompt-file'), 'agent/dump-repair.md');
  assert.ok(!args.includes('--model'));
  assert.deepEqual(agentArgs('opus').slice(-2), ['--model', 'opus']);
});

test('the stream pairs tool calls with their results and keeps the final text', () => {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__vsp-lab__GetSource', input: { name: 'ZCL_DL_PRICING' } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '{"source":"x"}' }] }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'mcp__vsp-lab__RunQuery', input: {} }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'not permitted', is_error: true }] } }),
    'not json',
    JSON.stringify({ type: 'result', subtype: 'success', result: 'final words' }),
  ];
  const { finalText, toolResults } = parseAgentStream(lines);
  assert.equal(finalText, 'final words');
  assert.deepEqual(toolResults, [
    { name: 'mcp__vsp-lab__GetSource', input: { name: 'ZCL_DL_PRICING' }, output: '{"source":"x"}', isError: false },
    { name: 'mcp__vsp-lab__RunQuery', input: {}, output: 'not permitted', isError: true },
  ]);
});

test('the last JSON block wins; none or malformed gives null', () => {
  assert.deepEqual(extractResultJson('a\n```json\n{"n":1}\n```\nb\n```json\n{"n":2}\n```'), { n: 2 });
  assert.equal(extractResultJson('no block here'), null);
  assert.equal(extractResultJson('```json\n{"n":\n```'), null);
  assert.equal(extractResultJson(undefined), null);
});

const classFix = {
  verdict: 'code_fix', cause: 'Orders under 10 units match no discount tier.', explanation: 'The loop leaves <tier> unassigned.',
  object: { type: 'CLAS', name: 'ZCL_DL_PRICING' }, fixed_source: 'fixed', test: { class: 'LTC_DUMP_REPRO', method: 'small_order_has_no_discount' },
  verification: 'unit_test', confidence: 'high',
};

test('result validation', () => {
  assert.equal(validateResult(classFix), null);
  assert.equal(validateResult({ ...classFix, verdict: 'data_fix', data_action: 'Maintain ZDL_CONFIG for XYZ' }), null);
  assert.equal(validateResult({ ...classFix, object: { type: 'DDLS', name: 'ZC_DL_ORDER' }, test: null, verification: 'manual_reclick' }), null);
  assert.match(validateResult(null), /no JSON/);
  assert.match(validateResult({ ...classFix, verdict: 'maybe' }), /unknown verdict/);
  assert.match(validateResult({ ...classFix, cause: 'x'.repeat(121) }), /cause/);
  assert.match(validateResult({ ...classFix, test: { class: 'LTC_PRICING', method: 'm' } }), /LTC_DUMP_REPRO/);
  assert.match(validateResult({ ...classFix, fixed_source: '' }), /fixed_source/);
  assert.match(validateResult({ ...classFix, verdict: 'data_fix' }), /data_action/);
  assert.match(validateResult({ ...classFix, object: { type: 'DDLS', name: 'Z' }, verification: 'unit_test' }), /manual_reclick/);
});

test('forbidden fixes: catch-alls added, deliberate dumps removed', () => {
  const original = "METHOD m.\n  RAISE SHORTDUMP TYPE zcx_x.\n  MESSAGE e001(zz) TYPE 'X'.\nENDMETHOD.";
  assert.equal(forbiddenReason(original, `${original}\n* comment`), null);
  assert.match(forbiddenReason(original, original.replace('ENDMETHOD.', 'TRY. CATCH cx_root. ENDTRY.\nENDMETHOD.')), /catch-all/);
  assert.match(forbiddenReason(original, original.replace('RAISE SHORTDUMP TYPE zcx_x.', '')), /RAISE SHORTDUMP/);
  assert.match(forbiddenReason(original, original.replace("TYPE 'X'", "TYPE 'E'")), /TYPE 'X'/);
  const withCatch = 'TRY. CATCH cx_root. ENDTRY.';
  assert.equal(forbiddenReason(withCatch, withCatch), null);
});

test('the proposal binds to the last include_hash read of the main source', () => {
  const read = (input, output, isError = false) => ({ name: 'mcp__vsp-lab__GetSource', input, output, isError });
  const results = [
    read({ name: 'ZCL_DL_PRICING', include_hash: true }, JSON.stringify({ source: 'old', sourceHash: 'h-old' })),
    read({ name: 'ZCL_DL_PRICING', include_hash: true }, JSON.stringify({ source: 'new', sourceHash: 'h-new' })),
    read({ name: 'ZCL_DL_PRICING', include_hash: true, include: 'testclasses' }, JSON.stringify({ source: 't', sourceHash: 'h-t' })),
    read({ name: 'ZCL_DL_PRICING' }, 'plain text source'),
    read({ name: 'ZCL_OTHER', include_hash: true }, JSON.stringify({ source: 'o', sourceHash: 'h-o' })),
  ];
  assert.deepEqual(findBoundSource(results, 'zcl_dl_pricing'), { source: 'new', hash: 'h-new' });
  assert.equal(findBoundSource(results.slice(2, 4), 'ZCL_DL_PRICING'), null);
  assert.equal(findBoundSource([], 'ZCL_DL_PRICING'), null);
});

test('test contract on the real captured runs', () => {
  const repro = { method: 'small_order_has_no_discount', runtimeError: 'GETWA_NOT_ASSIGNED' };
  assert.equal(checkTestContract(fixture('unit-before.json'), repro, 'before'), null);
  assert.equal(checkTestContract(fixture('unit-after.json'), repro, 'after'), null);
  assert.match(checkTestContract(fixture('unit-after.json'), repro, 'before'), /passed before the fix/);
  assert.match(checkTestContract(fixture('unit-before.json'), repro, 'after'), /still fails/);
  assert.match(checkTestContract(fixture('unit-before.json'), { ...repro, runtimeError: 'COMPUTE_INT_ZERODIVIDE' }, 'before'), /not with/);
});

test('test contract rejects missing, empty and unrelated results', () => {
  const run = (repro, baseline) => ({ classes: [
    ...(baseline ? [{ name: 'LTC_PRICING', testMethods: [{ name: 'MEDIUM_ORDER_GETS_5_PERCENT', ...baseline }] }] : []),
    ...(repro ? [{ name: 'LTC_DUMP_REPRO', testMethods: [{ name: 'SMALL_ORDER_HAS_NO_DISCOUNT', ...repro }] }] : []),
  ] });
  const dumped = { alerts: [{ kind: 'exception', title: 'Runtime Error GETWA_NOT_ASSIGNED' }] };
  const failed = { alerts: [{ kind: 'failedAssertion', title: 'Expected 5' }] };
  const repro = { method: 'small_order_has_no_discount', runtimeError: 'GETWA_NOT_ASSIGNED' };
  assert.match(checkTestContract({}, repro, 'before'), /did not run/);
  assert.match(checkTestContract(run(null, {}), repro, 'before'), /did not run/);
  assert.match(checkTestContract(run(dumped, null), repro, 'after'), /no existing test ran/);
  assert.match(checkTestContract(run(dumped, failed), repro, 'before'), /existing test failed/);
  assert.match(checkTestContract(run({}, failed), repro, 'after'), /existing test failed/);
  assert.equal(checkTestContract(run(dumped, {}), repro, 'before'), null);
  assert.equal(checkTestContract(run({}, {}), repro, 'after'), null);
});

test('the page escapes everything the agent wrote', () => {
  const html = renderPage({
    id: 'abc', view: 'v', token: 'tok', status: 'open', title: '<b>GETWA</b>', count: 1,
    result: { ...classFix, cause: '<img src=x onerror=alert(1)>', explanation: '<script>alert(1)</script>' },
    diff: '- <tier>\n+ "x" & \'y\'', testSource: '</pre><script>',
  });
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;tier&gt;'));
  assert.ok(html.includes('&quot;x&quot; &amp; &#39;y&#39;'));
});

test('the page shows only the actions the state allows', () => {
  const base = { id: 'abc', view: 'v', title: 't', count: 1, result: classFix };
  const open = renderPage({ ...base, status: 'open', token: 'tok' });
  assert.match(open, /action="\/p\/abc\/approve"/);
  assert.match(open, /action="\/p\/abc\/reject"/);
  assert.match(open, /value="tok"/);
  const reclick = renderPage({ ...base, status: 'awaiting_reclick', token: 'tok2' });
  assert.match(reclick, /\/works"/);
  assert.match(reclick, /\/broken"/);
  assert.doesNotMatch(reclick, /approve/);
  assert.doesNotMatch(renderPage({ ...base, status: 'fixed' }), /<form/);
  assert.doesNotMatch(renderPage({ ...base, status: 'open' }), /<form/); // token already used
  assert.match(renderPage({ ...base, status: 'info', result: { ...classFix, verdict: 'data_fix', data_action: 'Maintain XYZ' } }), /Maintain XYZ/);
});

test('variables of the frame where the dump stopped are always kept, first', () => {
  const text = summarizeDump({
    dump: { at: '2026-10-01T19:25:10Z', user: 'DEMO' },
    detail: {
      errorType: 'RAISE_SHORTDUMP', program: 'ZCL_DL_PRICING===CP', include: 'I', line: 5, procedure: 'DISCOUNT_PCT', mainProgram: 'SAPMHTTP',
      stack: [{ type: 'METHOD', name: 'ZCL_DL_PRICING=>DISCOUNT_PCT', include: 'I', line: 5 }, { type: 'METHOD', name: 'LHC_LABORDER=>RECALCULATE', include: 'J', line: 9 }],
      source: [],
      variables: [
        { frame: 'LHC_LABORDER=>RECALCULATE', name: 'ZC_REF', value: 'ZC_DL_ORDER 545' },
        { frame: 'LHC_LABORDER=>RECALCULATE', name: 'COUNT', value: '3 0000' },
        { frame: 'ZCL_DL_PRICING=>DISCOUNT_PCT', name: 'CURRENCY', value: 'XYZ 55522 89A00' },
        { frame: 'ZCL_DL_PRICING=>DISCOUNT_PCT', name: 'QUANTITY', value: '20 1000' },
      ],
    },
  });
  assert.match(text, /\[ZCL_DL_PRICING=>DISCOUNT_PCT\] CURRENCY = XYZ/);
  assert.match(text, /QUANTITY = 20/);
  assert.doesNotMatch(text, /COUNT = 3/);
  assert.ok(text.indexOf('CURRENCY = XYZ') < text.indexOf('ZC_REF'), 'stop-frame variables come first');
});
