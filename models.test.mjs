import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FixDraft, Investigation, READ_TOOLS, TestDraft, chatModel, jsonSchema, readTools } from './models.mjs';

const listed = [...READ_TOOLS, 'WriteSource', 'UpdateClassInclude', 'Activate', 'RunUnitTests'].map((name) => ({
  name, description: `${name} tool`,
  inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
}));

function fakeVsp(answer = () => 'ok') {
  const vsp = {
    calls: [],
    listTools: async () => listed,
    async call(tool, args) { vsp.calls.push([tool, args]); return answer(tool, args); },
  };
  return vsp;
}
const getSource = async (vsp) => (await readTools(vsp)).find((t) => t.name === 'GetSource');

test('the investigation gets exactly the 7 read tools', async () => {
  const tools = await readTools(fakeVsp());
  assert.deepEqual(tools.map((t) => t.name).sort(), [...READ_TOOLS].sort());
});

test("a read tool passes its arguments to vsp, returns text, and keeps vsp's schema", async () => {
  const vsp = fakeVsp(() => ({ source: 'CLASS zcl_x.' }));
  const tool = await getSource(vsp);
  assert.equal(await tool.invoke({ name: 'ZCL_X' }), JSON.stringify({ source: 'CLASS zcl_x.' }));
  assert.deepEqual(vsp.calls, [['GetSource', { name: 'ZCL_X' }]]);
  await assert.rejects(tool.invoke({}), /expected schema/);
});

test('a failing read comes back to the model as text, and long output is cut', async () => {
  assert.equal(await (await getSource(fakeVsp(() => { throw new Error('GetSource: not found'); }))).invoke({ name: 'ZCL_X' }), 'Error: GetSource: not found');
  assert.equal((await (await getSource(fakeVsp(() => 'x'.repeat(200_000)))).invoke({ name: 'ZCL_X' })).length, 100_000);
});

test('readTools refuses a vsp without one of the read tools', async () => {
  const vsp = fakeVsp();
  vsp.listTools = async () => listed.filter((t) => t.name !== 'GetRevisions');
  await assert.rejects(readTools(vsp), /GetRevisions/);
});

test('the structured-output schemas are plain, strict and fully required', () => {
  for (const schema of [Investigation, TestDraft, FixDraft]) {
    const json = jsonSchema(schema);
    assert.equal(json.$schema, undefined);
    assert.equal(json.additionalProperties, false);
    assert.deepEqual([...json.required].sort(), Object.keys(json.properties).sort());
  }
});

test('the model client sends no sampling settings and no forced tool choice', () => {
  const params = chatModel('claude-opus-5-5', 'test-key').invocationParams({ outputConfig: { format: { type: 'json_schema', schema: jsonSchema(Investigation) } } });
  assert.equal(params.temperature, undefined);
  assert.equal(params.tool_choice, undefined);
  assert.equal(params.thinking, undefined);
  assert.equal(params.output_config.effort, 'high');
  assert.equal(params.output_config.format.type, 'json_schema');
});

test('the prompts keep the playbook rules', () => {
  const read = (name) => readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), 'utf8');
  assert.match(read('investigate'), /SAP code/);
  assert.match(read('draft-test'), /ltc_dump_repro/);
  assert.match(read('draft-test'), /cl_osql_test_environment/);
  assert.match(read('draft-fix'), /RAISE SHORTDUMP/);
  assert.match(read('draft-fix'), /cx_root/);
});
