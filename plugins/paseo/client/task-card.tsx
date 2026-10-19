import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { MeantimeCardData } from "../shared/tasks.js";
import { completionResult, formatElapsed, monoFont, stateColor } from "./rows.js";
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
      {data.source === "completion" ? data.tasks.map(task => (
        <TaskPanel key={task.id} colors={colors} layout={layout} title={<>
          {task.tool ? `${task.tool} ` : ""}{task.id} ─ <Text style={{ color: stateColor(task.state, colors) }}>{completionResult(task)}</Text>
        </>}>
          {task.command || task.tool ? <TaskCommand task={task} colors={colors} layout={layout} /> : null}
          <TaskNotes task={task} colors={colors} layout={layout} />
          {formatElapsed(task) ? <Text style={{ textAlign: "right", color: colors.foregroundMuted,
            fontFamily: monoFont(layout.platform), fontSize: 10, lineHeight: 16, opacity: 0.65 }}>
            {formatElapsed(task)}
          </Text> : null}
        </TaskPanel>
      )) : <TaskTable tasks={tasks} colors={colors} layout={layout} />}
      {data.moreOffset !== undefined ? <Text style={{ color: colors.foregroundMuted, fontSize: 10,
        fontFamily: monoFont(layout.platform) }}>More tasks not shown (offset {data.moreOffset})</Text> : null}
    </View>
  );
}
