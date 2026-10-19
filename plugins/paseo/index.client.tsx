import type { PluginClientContext } from "@getpaseo/plugin/client";
import { MeantimeBoard } from "./client/board.js";
import { MeantimeTaskCard } from "./client/task-card.js";
import { cardDataSchema, recognizeTimelineToolCall } from "./shared/tasks.js";

export default function contribute(client: PluginClientContext) {
  client.addTimelineTransformer({
    id: "meantime-task",
    query: { itemType: "tool_call" },
    transform({ item, phase }) {
      const data = recognizeTimelineToolCall(item);
      if (!data) return undefined;
      return {
        items: [{
          type: "plugin" as const,
          kind: "meantime-task",
          version: 1,
          data: { ...data, phase },
        }],
      };
    },
  });
  client.addTimelineRenderer({
    kind: "meantime-task",
    version: 1,
    schema: cardDataSchema,
    Component: MeantimeTaskCard,
  });
  client.addWorkspacePanel({
    id: "meantime-board",
    title: "Background tasks",
    icon: "Layers",
    context: "agent",
    locations: ["workspace", "explorer"],
    Component: MeantimeBoard,
  });
  client.addCommandCenterItem({
    id: "open-meantime-board",
    title: "Open background tasks",
    icon: "Layers",
    context: "agent",
    onSelect({ openPanel }) {
      openPanel("meantime-board");
    },
  });
  return () => {};
}
