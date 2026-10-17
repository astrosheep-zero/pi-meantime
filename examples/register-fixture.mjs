// Development only: start a local MCP server with sleep/echo/failure fixtures.
// This starts a plain Node process, not a delegated coding agent.
import { fileURLToPath } from 'node:url';
export default function fixture(pi) {
  pi.registerMcpServer('bg_poc_fixture', {
    command: process.execPath,
    args: [fileURLToPath(new URL('../test/fixtures/mcp-server.mjs', import.meta.url))],
    exposure: 'direct', timeout: 15,
  });
}
