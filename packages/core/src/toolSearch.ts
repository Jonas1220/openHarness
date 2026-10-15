import type { Tool } from './types.ts';

/**
 * Tool search: with many MCP tools connected, sending every tool definition on every request
 * fills the context and confuses small models. Instead, MCP tools are "deferred": the model
 * sees one search_tools tool, and tools it finds are loaded for the rest of the chat.
 * Claude Code and Codex do the same for large tool sets.
 */
export type ToolSearchSetting = 'auto' | 'on' | 'off';

/** In auto mode, defer MCP tools once there are more than this many. */
export const AUTO_THRESHOLD = 10;

export const isDeferrable = (t: Tool) => t.name.startsWith('mcp__');

export function useToolSearch(tools: Tool[], setting: ToolSearchSetting = 'auto'): boolean {
  const deferrable = tools.filter(isDeferrable).length;
  if (setting === 'off' || deferrable === 0) return false;
  return setting === 'on' || deferrable > AUTO_THRESHOLD;
}

/** Rank tools for a query by word overlap with their name and description. */
export function rankTools(tools: Tool[], query: string): Tool[] {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  if (!words.length) return [];
  const scored = tools.map((t) => {
    const name = t.name.toLowerCase().replace(/^mcp__/, '').replace(/_/g, ' ');
    const desc = t.description.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (name.includes(w)) score += 3;
      if (desc.includes(w)) score += 1;
    }
    return { t, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.t);
}

export function searchToolsTool(deferred: () => Tool[], activate: (names: string[]) => void): Tool {
  return {
    name: 'search_tools',
    kind: 'meta',
    description:
      'Find and load additional tools from connected MCP servers. Describe what you need (e.g. "create github issue", "query database"), or load exact tools with "select:name1,name2". Loaded tools can be called directly afterwards.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the tool should do, or select:<names>.' },
        max_results: { type: 'number', description: 'How many tools to load (default 5).' },
      },
      required: ['query'],
    },
    describe: (a) => `Search tools: ${a.query}`,
    async run(args) {
      const query = String(args.query ?? '').trim();
      const all = deferred();
      let found: Tool[];
      if (query.startsWith('select:')) {
        const names = query.slice(7).split(',').map((s) => s.trim());
        found = all.filter((t) => names.includes(t.name));
      } else {
        found = rankTools(all, query).slice(0, Math.min(Math.max(Number(args.max_results) || 5, 1), 15));
      }
      if (!found.length) {
        const servers = [...new Set(all.map((t) => t.name.split('__')[1]))].join(', ');
        return { output: `No tools match "${query}". Connected servers: ${servers}. Try other words.` };
      }
      activate(found.map((t) => t.name));
      return {
        output: `Loaded ${found.length} tool(s); call them directly now:\n${found.map((t) => `- ${t.name}: ${t.description.slice(0, 200)}`).join('\n')}`,
      };
    },
  };
}

export function deferredToolsPrompt(deferred: Tool[]): string {
  const servers = [...new Set(deferred.map((t) => t.name.split('__')[1]))];
  return `# More tools
${deferred.length} more tools from MCP servers (${servers.join(', ')}) are available but not loaded. When a task needs one of them, call search_tools with a short description of what you need; matching tools are loaded and can then be called directly.`;
}
