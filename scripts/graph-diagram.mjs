// Writes docs/graph.md from the compiled graph: node scripts/graph-diagram.mjs
import { writeFileSync } from 'node:fs';
import { diagram } from '../graph.mjs';

const mermaid = await diagram();
writeFileSync(new URL('../docs/graph.md', import.meta.url), `# The LangGraph engine

Generated from \`graph.mjs\` by \`node scripts/graph-diagram.mjs\`. Don't edit it by hand.

\`\`\`mermaid
${mermaid}
\`\`\`
`);
