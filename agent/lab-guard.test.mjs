import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { refusal } from './lab-guard.mjs';

const call = (tool, input) => refusal({ tool_name: `mcp__vsp-lab__${tool}`, tool_input: input });
const testInclude = { class_name: 'ZCL_DL_PRICING', include_type: 'testclasses', source: 'CLASS ltc_dump_repro ...' };

test('the agent may write and activate test includes of lab classes', () => {
  assert.equal(call('UpdateClassInclude', testInclude), null);
  assert.equal(call('UpdateClassInclude', { ...testInclude, class_name: 'zcl_dl_pricing', include_type: 'TESTCLASSES' }), null);
  assert.equal(call('Activate', { object_url: '/sap/bc/adt/oo/classes/ZCL_DL_PRICING', object_name: 'ZCL_DL_PRICING' }), null);
  assert.equal(call('CreateTestInclude', { class_name: 'ZCL_DL_PRICING' }), null);
  assert.equal(call('GetSource', { object_type: 'CLAS', name: 'CL_SADL_SHORTDUMP' }), null);
});

test('every other include, class or activation is refused', () => {
  assert.match(call('UpdateClassInclude', { ...testInclude, include_type: 'main' }), /limited/);
  assert.match(call('UpdateClassInclude', { ...testInclude, include_type: 'implementations' }), /limited/);
  assert.match(call('UpdateClassInclude', { ...testInclude, class_name: 'ZBP_DL_ORDER' }), /limited/);
  assert.match(call('UpdateClassInclude', { ...testInclude, class_name: 'ZCL_DL_PRICING_X/../ZCL_OTHER' }), /limited/);
  assert.match(call('UpdateClassInclude', {}), /limited/);
  assert.match(call('Activate', { object_url: '/sap/bc/adt/ddic/ddl/sources/zc_dl_order' }), /limited/);
  assert.match(call('Activate', { object_url: '/sap/bc/adt/oo/classes/zbp_dl_order' }), /limited/);
  assert.match(call('CreateTestInclude', { class_name: 'CL_SADL_SHORTDUMP' }), /limited/);
});

test('direct source writes are refused even if a permission rule slipped through', () => {
  for (const tool of ['UpdateSource', 'WriteSource', 'EditSource'])
    assert.match(call(tool, { object_url: '/sap/bc/adt/oo/classes/zcl_dl_pricing/source/main' }), /not allowed/, tool);
});

test('as a hook, a refusal exits with code 2 and an allowed call exits with 0', () => {
  const refused = JSON.stringify({ tool_name: 'mcp__vsp-lab__UpdateClassInclude', tool_input: { ...testInclude, include_type: 'main' } });
  assert.throws(() => execFileSync('node', ['agent/lab-guard.mjs'], { input: refused, stdio: 'pipe' }), (err) => err.status === 2 && /limited/.test(err.stderr));
  const allowed = JSON.stringify({ tool_name: 'mcp__vsp-lab__UpdateClassInclude', tool_input: testInclude });
  execFileSync('node', ['agent/lab-guard.mjs'], { input: allowed, stdio: 'pipe' });
});
