// PreToolUse hook for the headless agent: it may write and activate only test includes of lab classes.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const LAB_CLASS = /^zcl_dl_[a-z0-9_]+$/;
const LAB_CLASS_URL = /^\/sap\/bc\/adt\/oo\/classes\/zcl_dl_[a-z0-9_]+$/;
const lower = (value) => String(value ?? '').toLowerCase();

export function refusal({ tool_name: tool = '', tool_input: input = {} }) {
  const name = tool.split('__').pop();
  if (['UpdateSource', 'WriteSource', 'EditSource'].includes(name))
    return `${name} is not allowed: the agent may only write test includes, with UpdateClassInclude`;
  if (name === 'UpdateClassInclude' && !(LAB_CLASS.test(lower(input.class_name)) && lower(input.include_type) === 'testclasses'))
    return `UpdateClassInclude is limited to the testclasses include of lab classes (got ${input.class_name ?? '?'} / ${input.include_type ?? '?'})`;
  if (name === 'Activate' && !LAB_CLASS_URL.test(lower(input.object_url)))
    return `Activate is limited to lab classes (got ${input.object_url || 'no object_url'})`;
  if (name === 'CreateTestInclude' && !LAB_CLASS.test(lower(input.class_name)))
    return 'CreateTestInclude is limited to lab classes';
  return null;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reason = refusal(JSON.parse(readFileSync(0, 'utf8')));
  if (reason) {
    process.stderr.write(reason);
    process.exit(2); // exit code 2 blocks the tool call and shows the reason to the agent
  }
}
