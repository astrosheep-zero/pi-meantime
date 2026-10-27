import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { MeantimeCardData, TaskSummary } from "../shared/tasks.js";
import { Card } from "./card.js";
import { CODE_FONT_SIZE, CODE_LINE_HEIGHT, completionResult, dividerColor, monoFont, secondaryColor, stateText } from "./rows.js";
import { TaskGlyph, TaskLine } from "./task-view.js";

/** The wait outcome is the row's own status: "waiting", "done", "still
 * running". No second-line prose narrating what the wait did. */
function waitStatus(task: TaskSummary): string {
  const state = task.state;
  if (state === "waiting") return "waiting";
  if (["completed", "failed", "cancelled"].includes(state)) return completionResult(task);
  if (state === "running") return "still running";
  if (state === "cancel_requested") return "cancel requested";
  return stateText(state);
}

export function WaitCard({ item, theme, layout }: PluginTimelineItemProps<MeantimeCardData>) {
  const { colors } = theme;
  if (item.data.tasks.length === 0) return (
    <Card colors={colors}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 10 }}>
        <TaskGlyph task={{ state: "waiting" }} colors={colors} />
        <Text style={{ flex: 1, color: colors.foreground, fontFamily: monoFont(layout.platform),
          fontSize: CODE_FONT_SIZE, lineHeight: CODE_LINE_HEIGHT }}>All pending tasks</Text>
        <Text style={{ color: secondaryColor(colors), fontSize: 12, lineHeight: 16 }}>{stateText("waiting")}</Text>
      </View>
    </Card>
  );
  const tasks = item.data.tasks;
  const divider = dividerColor(colors);
  return (
    <Card colors={colors}>
      {tasks.map((task, index) => {
        const status = waitStatus(task);
        return (
          <View key={task.id} style={index > 0 ? { borderTopWidth: 1, borderTopColor: divider } : undefined}>
            <TaskLine task={task} colors={colors} layout={layout} status={status} waitStatus={status} />
          </View>
        );
      })}
    </Card>
  );
}
