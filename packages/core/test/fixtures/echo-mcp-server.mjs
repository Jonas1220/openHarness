// Minimal stdio MCP server used by the tests.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo', version: '1.0.0' });
server.registerTool('echo', { description: 'Echo the text back', inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: 'text', text: `echo: ${text} (${process.env.ECHO_PREFIX ?? 'no-env'})` }],
}));
await server.connect(new StdioServerTransport());
