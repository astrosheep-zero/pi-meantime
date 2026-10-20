import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { MeantimeCardData } from "../shared/tasks.js";
import { completionResult, monoFont, secondaryColor } from "./rows.js";
import { TaskLine, TaskTable } from "./task-view.js";

export function MeantimeTaskCard({ item, theme, layout }: PluginTimelineItemProps<MeantimeCardData>) {
  const { colors } = theme;
  const data = item.data;
  // Even a snapshot-backed launch handle is historical evidence of starting,
  // not a continuing observation of a running process.
  const tasks = data.source === "handle"
    ? data.tasks.map(task => task.state === "running" ? { ...task, state: "started" } : task)
    : data.tasks;
  return (
    <View style={{ gap: 4 }}>
      {data.source === "completion"
        ? <View style={{ marginTop: 4 }}>{tasks.map(task => <TaskLine key={task.id} task={task} colors={colors}
            layout={layout} status={completionResult(task)} />)}</View>
        : <TaskTable tasks={tasks} colors={colors} layout={layout} />}
      {data.moreOffset !== undefined ? <Text style={{ color: secondaryColor(colors), fontSize: 10,
        fontFamily: monoFont(layout.platform) }}>More tasks not shown (offset {data.moreOffset})</Text> : null}
    </View>
  );
}
