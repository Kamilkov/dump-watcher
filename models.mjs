// The LangChain side of the LangGraph engine: the 7 read tools, the investigation agent and two
// drafting calls. graph.mjs sees only three functions, so its tests run on scripted answers.
import { readFileSync } from 'node:fs';
import { ChatAnthropic } from '@langchain/anthropic';
import { createAgent, providerStrategy, tool } from 'langchain';
import { z } from 'zod';

export const READ_TOOLS = ['GetSource', 'GetClassInclude', 'GetRevisions', 'GetRevisionSource', 'GrepObject', 'SearchObject', 'GetCDSDependencies'];
const TOOL_OUTPUT_MAX = 100_000; // ponytail: a hard cut, as Claude Code caps MCP output; trim smarter if a case needs it

export const Investigation = z.object({
  verdict: z.enum(['code_fix', 'data_fix', 'unsure']),
  cause: z.string().describe('One line for a phone notification, at most 120 characters'),
  explanation: z.string().describe('What happened and why, in plain words'),
  object: z.object({ type: z.enum(['CLAS', 'DDLS']), name: z.string() }).nullable().describe('The Z object to fix; only for code_fix, otherwise null'),
  data_action: z.string().nullable().describe('What to maintain; only for data_fix, otherwise null'),
  confidence: z.enum(['high', 'medium', 'low']),
});
export const TestDraft = z.object({
  source: z.string().describe('Only the local test class ltc_dump_repro: its DEFINITION and its IMPLEMENTATION'),
  method: z.string().describe('The name of the one test method that reproduces the dump'),
});
export const FixDraft = z.object({
  source: z.string().describe('The complete fixed main source of the class, or the complete DDL source'),
  rationale: z.string().describe('Why this fix is right, in one or two sentences'),
});

// Anthropic's structured output takes a plain JSON schema; zod adds a $schema key.
export function jsonSchema(schema) {
  const { $schema, ...plain } = z.toJSONSchema(schema);
  return plain;
}

const prompt = (name) => readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), 'utf8');

// Current Claude models reject sampling settings and disabled thinking, so neither is set.
// Opus 5.5 defaults to medium effort; root-cause work gets high.
export const chatModel = (model, apiKey) => new ChatAnthropic({ model, apiKey, maxTokens: 16_000, outputConfig: { effort: 'high' } });

// The read tools come from vsp's own list, so their schemas match the server exactly.
export async function readTools(vsp, log = () => {}) {
  const listed = (await vsp.listTools()).filter((t) => READ_TOOLS.includes(t.name));
  const missing = READ_TOOLS.filter((name) => !listed.some((t) => t.name === name));
  if (missing.length) throw new Error(`vsp offers no ${missing.join(', ')}`);
  return listed.map((t) => tool(async (args) => {
    log(`  agent → ${t.name} ${args.name ?? args.class_name ?? args.object_url ?? args.query ?? ''}`);
    try {
      const out = await vsp.call(t.name, args);
      return (typeof out === 'string' ? out : JSON.stringify(out)).slice(0, TOOL_OUTPUT_MAX);
    } catch (err) {
      return `Error: ${err.message}`;
    }
  }, { name: t.name, description: t.description ?? t.name, schema: t.inputSchema }));
}

export function createModels({ vsp, model, apiKey, log = () => {}, timeoutMs = 5 * 60_000 }) {
  const chat = chatModel(model, apiKey);
  let tools;
  // Single calls use native structured output, never the default forced tool call.
  const draft = (schema, name) => (user) => chat.withStructuredOutput(schema, { method: 'jsonSchema' })
    .invoke([{ role: 'system', content: prompt(name) }, { role: 'user', content: user }], { runName: name });
  return {
    async investigate(summary) {
      tools ??= await readTools(vsp, log);
      // providerStrategy, not the bare schema: without a model profile, createAgent would force a tool call.
      const agent = createAgent({ model: chat, tools, systemPrompt: prompt('investigate'), responseFormat: providerStrategy(jsonSchema(Investigation)) });
      try {
        const result = await agent.invoke(
          { messages: [{ role: 'user', content: summary }] },
          { recursionLimit: 50, signal: AbortSignal.timeout(timeoutMs), runName: 'investigate' },
        );
        return Investigation.parse(result.structuredResponse);
      } catch (err) {
        if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new Error(`the investigation took longer than ${timeoutMs / 60_000} minutes`);
        throw err;
      }
    },
    draftTest: draft(TestDraft, 'draft-test'),
    draftFix: draft(FixDraft, 'draft-fix'),
  };
}
