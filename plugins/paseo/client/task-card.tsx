import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { MeantimeCardData } from "../shared/tasks.js";
import { completionResult, formatElapsed, monoFont, secondaryColor, stateColor } from "./rows.js";
import { TaskCommand, TaskNotes, TaskPanel, TaskTable } from "./task-view.js";

export function MeantimeTaskCard({ item, theme, layout }: PluginTimelineItemProps<MeantimeCardData>) {
  const { colors } = theme;
  const data = item.data;
  // Even a snapshot-backed launch handle is historical evidence of starting,
  // not a continuing observation of a running process.
  const tasks = data.source === "handle"
    ? data.tasks.map(task => task.state === "running" ? { ...task, state: "started" } : task)
    : data.tasks;
  return (
    <View style={{ gap: 8 }}>
      {data.source === "completion" ? data.tasks.map(task => {
        const hasIdentity = Boolean(task.command || task.tool);
        const result = <Text style={{ color: stateColor(task.state, colors) }}>{completionResult(task)}</Text>;
        return (
          <TaskPanel key={task.id} colors={colors} layout={layout}
            title={hasIdentity ? result : <>{task.id} ─ {result}</>}>
            {hasIdentity ? <TaskCommand task={task} colors={colors} layout={layout} /> : null}
            <TaskNotes task={task} colors={colors} layout={layout} />
            {formatElapsed(task) ? <Text style={{ textAlign: "right", color: secondaryColor(colors),
              fontFamily: monoFont(layout.platform), fontSize: 10, lineHeight: 16 }}>
              {formatElapsed(task)}
            </Text> : null}
          </TaskPanel>
        );
      }) : <TaskTable tasks={tasks} colors={colors} layout={layout} />}
      {data.moreOffset !== undefined ? <Text style={{ color: secondaryColor(colors), fontSize: 10,
        fontFamily: monoFont(layout.platform) }}>More tasks not shown (offset {data.moreOffset})</Text> : null}
    </View>
  );
}
