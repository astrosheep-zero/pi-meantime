import type { PluginClientContext } from "@getpaseo/plugin/client";
import { MeantimeBoard } from "./client/board.js";
import { MeantimeTaskCard } from "./client/task-card.js";
import { cardDataSchema, recognizeTimelineToolCall } from "./shared/tasks.js";

export default function contribute(client: PluginClientContext) {
  const removals = [
    client.addTimelineTransformer({
      id: "meantime-task",
      query: { itemType: "tool_call" },
      transform({ item }) {
        const data = recognizeTimelineToolCall(item);
        if (!data) return undefined;
        return {
          items: [{
            type: "plugin" as const,
            kind: "meantime-task",
            version: 1,
            data,
          }],
        };
      },
    }),
    client.addTimelineRenderer({
      kind: "meantime-task",
      version: 1,
      schema: cardDataSchema,
      Component: MeantimeTaskCard,
    }),
    client.addWorkspacePanel({
      id: "meantime-board",
      title: "Background tasks",
      icon: "Layers",
      context: "agent",
      locations: ["workspace", "explorer"],
      Component: MeantimeBoard,
    }),
    client.addCommandCenterItem({
      id: "open-meantime-board",
      title: "Open background tasks",
      icon: "Layers",
      context: "agent",
      onSelect({ openPanel }) {
        openPanel("meantime-board");
      },
    }),
  ];
  return () => { for (const remove of removals) remove(); };
}
