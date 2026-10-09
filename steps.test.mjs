import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restoreOriginal, runContract, sourceHash, writeOwned } from './core.mjs';
import { BASELINE_TESTS, DDL, DDL_FIXED, FIXED, ORIGINAL, REPRO_TEST, fakeSap } from './test/fakes.mjs';

const ddl = { type: 'DDLS', name: 'ZC_DL_ORDER' };
const writes = (sap) => sap.calls.filter(([t]) => t === 'WriteSource');

test('the write rule writes over the hash it expects, with that hash as the precondition', async () => {
  const sap = fakeSap();
  assert.equal(await writeOwned({ vsp: sap }, { ...ddl, source: DDL_FIXED, replaces: [sourceHash(DDL)] }), 'written');
  assert.equal(writes(sap)[0][1].expected_source_hash, sourceHash(DDL));
  assert.equal(sap.sources.ZC_DL_ORDER, DDL_FIXED);
});

test('the write rule leaves a version it does not own alone', async () => {
  const sap = fakeSap();
  sap.sources.ZC_DL_ORDER = 'edited by someone';
  assert.equal(await writeOwned({ vsp: sap }, { ...ddl, source: DDL_FIXED, replaces: [sourceHash(DDL)] }), 'foreign');
  assert.equal(writes(sap).length, 0);
});

test('a target that is only saved gets activated before the write rule skips it', async () => {
  const sap = fakeSap();
  sap.inactive.ZC_DL_ORDER = DDL_FIXED; // saved by a run that died before activating
  assert.equal(await writeOwned({ vsp: sap }, { ...ddl, source: DDL_FIXED, replaces: [sourceHash(DDL)] }), 'skipped');
  assert.equal(writes(sap).length, 0);
  assert.equal(sap.sources.ZC_DL_ORDER, DDL_FIXED);
  assert.deepEqual(sap.inactive, {});
});

test('a saved target that will not activate is reported, not skipped', async () => {
  const sap = fakeSap();
  sap.inactive.ZC_DL_ORDER = DDL_FIXED;
  sap.activationError = 'syntax error in line 3';
  assert.equal(await writeOwned({ vsp: sap }, { ...ddl, source: DDL_FIXED, replaces: [sourceHash(DDL)] }), 'unconfirmed');
  assert.equal(sap.sources.ZC_DL_ORDER, DDL);
});

test('the crash point follows the write', async () => {
  const sap = fakeSap();
  const points = [];
  const crash = async (point) => { points.push([point, sap.sources.ZC_DL_ORDER]); };
  await writeOwned({ vsp: sap, crash }, { ...ddl, source: DDL_FIXED, replaces: [sourceHash(DDL)], point: 'writeFix' });
  assert.deepEqual(points, [['writeFix', DDL_FIXED]]);
});

test('a class include goes through WriteSource with include', async () => {
  const sap = fakeSap();
  const include = `${BASELINE_TESTS}\n\nCLASS ltc_dump_repro DEFINITION FOR TESTING.\nENDCLASS.\n`;
  assert.equal(await writeOwned({ vsp: sap }, { type: 'CLAS', name: 'ZCL_DL_PRICING', include: 'testclasses', source: include, replaces: [sourceHash(BASELINE_TESTS)] }), 'written');
  assert.equal(writes(sap)[0][1].include, 'testclasses');
  assert.equal(sap.tests, include);
});

test('the contract fails while the reproduction test is missing or only saved', async () => {
  const sap = fakeSap();
  const contract = { objectUrl: '/sap/bc/adt/oo/classes/zcl_dl_pricing', method: REPRO_TEST.method, runtimeError: 'GETWA_NOT_ASSIGNED' };
  assert.match(await runContract(sap, contract, 'before'), /did not run/);
  await sap.call('UpdateClassInclude', { class_name: 'ZCL_DL_PRICING', source: `${BASELINE_TESTS}\n\n${REPRO_TEST.source}\n` });
  assert.match(await runContract(sap, contract, 'before'), /did not run/);
  await sap.call('Activate', { object_name: 'ZCL_DL_PRICING' });
  assert.equal(await runContract(sap, contract, 'before'), null);
});

const cdsProposal = { result: { object: ddl }, original: { source: DDL, hash: sourceHash(DDL) }, fixedHash: sourceHash(DDL_FIXED) };

test('restoreOriginal puts the original back over our fix', async () => {
  const sap = fakeSap();
  sap.sources.ZC_DL_ORDER = DDL_FIXED;
  assert.equal(await restoreOriginal({ vsp: sap }, cdsProposal), null);
  assert.equal(sap.sources.ZC_DL_ORDER, DDL);
});

test("restoreOriginal leaves somebody else's edit alone", async () => {
  const sap = fakeSap();
  sap.sources.ZC_DL_ORDER = 'edited by someone';
  assert.match(await restoreOriginal({ vsp: sap }, cdsProposal), /neither the fix nor the original/);
  assert.equal(sap.sources.ZC_DL_ORDER, 'edited by someone');
});

test('restoreOriginal writes nothing when the original is already back', async () => {
  const sap = fakeSap();
  assert.equal(await restoreOriginal({ vsp: sap }, cdsProposal), null);
  assert.equal(writes(sap).length, 0);
  assert.ok(sap.calls.some(([t]) => t === 'Activate'));
});

test('restoreOriginal leaves a class alone when its test include changed', async () => {
  const sap = fakeSap();
  sap.sources.ZCL_DL_PRICING = FIXED;
  sap.inactive['ZCL_DL_PRICING/testclasses'] = 'edited by someone';
  const p = {
    result: { object: { type: 'CLAS', name: 'ZCL_DL_PRICING' } }, original: { source: ORIGINAL, hash: sourceHash(ORIGINAL) },
    fixedHash: sourceHash(FIXED), testHash: sourceHash(BASELINE_TESTS),
  };
  assert.match(await restoreOriginal({ vsp: sap }, p), /test include of ZCL_DL_PRICING changed/);
  assert.equal(sap.sources.ZCL_DL_PRICING, FIXED);
  assert.equal(sap.inactive['ZCL_DL_PRICING/testclasses'], 'edited by someone');
});
