// The only connection to SAP: an MCP client for a server defined in .mcp.json.
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export async function connectVsp(server = 'vsp-lab') {
  const config = JSON.parse(readFileSync(new URL('./.mcp.json', import.meta.url), 'utf8'));
  const { command, args } = config.mcpServers[server];
  const client = new Client({ name: 'dump-watcher', version: '1.0.0' });
  // ssh needs the caller's environment (HOME, SSH_AUTH_SOCK) to find its key.
  await client.connect(new StdioClientTransport({ command, args, env: { ...process.env }, stderr: 'ignore' }));
  return {
    async call(tool, args = {}) {
      const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 300_000 });
      const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (res.isError) throw new Error(`${tool}: ${text}`);
      try { return JSON.parse(text); } catch { return text; }
    },
    close: () => client.close(),
    listTools: async () => (await client.listTools()).tools,
  };
}
