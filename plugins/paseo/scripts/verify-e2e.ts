// E2E self-verification: fetch THIS agent's live timeline from the local
// Paseo daemon and run the plugin's recognition/folding over real wire data.
// Usage: node scripts/verify-e2e.ts [agentId]
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi } from "@getpaseo/client";
import { buildDaemonWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import { WebSocket } from "ws";
import { foldTimeline, recognizeToolCall } from "../shared/tasks.ts";

const agentId = process.argv[2] ?? process.env.PASEO_AGENT_ID;
if (!agentId) throw new Error("pass an agent id");

import { readFileSync } from "node:fs";

// Same shape as the paseo CLI: the daemon trusts the local credential file
// (same-machine proof); the app password is for remote clients.
const daemon = new DaemonClient({
  url: buildDaemonWebSocketUrl("100.126.66.71:6767", { useTls: false }),
  clientId: "pi-meantime-paseo-verify",
  clientType: "cli",
  appVersion: "0.1.0",
  connectTimeoutMs: 10_000,
  reconnect: { enabled: false },
  localCredential: () => readFileSync(`${process.env.HOME}/.paseo/local-credential`, "utf8").trim(),
});
await daemon.connect();
const client = createPaseoApi(daemon);

const page = await client.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 500 });
console.log(`entries=${page.entries.length} hasOlder=${page.hasOlder} error=${page.error}`);

let recognized = 0;
for (const entry of page.entries) {
  const item = entry.item;
  if (item.type !== "tool_call") continue;
  const data = recognizeToolCall(item);
  if (!data) continue;
  recognized++;
  console.log(`\n[card] source=${data.source} action=${data.action ?? "-"}`);
  for (const task of data.tasks) {
    console.log(`  ${task.id} | ${task.tool} | ${task.state}${task.command ? ` | ${task.command}` : ""}`);
  }
}

console.log(`\nrecognized ${recognized} meantime-related tool call(s)`);
console.log("folded board:", JSON.stringify(foldTimeline(page.entries), null, 2));

await daemon.close();
