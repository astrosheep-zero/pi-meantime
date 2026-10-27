import { usePaseo, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { MeantimeCardData, TaskSummary } from "../shared/tasks.js";
import { foldItem, resolveWaitTask } from "../shared/tasks.js";
import { Card } from "./card.js";
import { CODE_FONT_SIZE, CODE_LINE_HEIGHT, completionResult, monoFont, secondaryColor, stateText } from "./rows.js";
import { TaskGlyph, TaskTable } from "./task-view.js";

const RESOLUTION_PAGE_LIMIT = 500;

/** The wait outcome is the row's own status: "waiting", "done", "still
 * running". No second-line prose narrating what the wait did. */
function waitStatus(task: TaskSummary): string {
  return task.state === "running" ? "still running" : completionResult(task);
}

export function MeantimeTaskCard(props: PluginTimelineItemProps<MeantimeCardData>) {
  const { item, theme, layout } = props;
  const { colors } = theme;
  const data = item.data;
  if (data.source === "meantime" && data.action === "wait" && data.tasks.length === 0) return (
    <Card colors={colors}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 10 }}>
        <TaskGlyph task={{ state: "waiting" }} colors={colors} />
        <Text style={{ flex: 1, color: colors.foreground, fontFamily: monoFont(layout.platform),
          fontSize: CODE_FONT_SIZE, lineHeight: CODE_LINE_HEIGHT }}>All pending tasks</Text>
        <Text style={{ color: secondaryColor(colors), fontSize: 12, lineHeight: 16 }}>{stateText("waiting")}</Text>
      </View>
    </Card>
  );
  // Even a snapshot-backed launch handle is historical evidence of starting,
  // not a continuing observation of a running process.
  const tasks = data.source === "handle"
    ? data.tasks.map(task => task.state === "running" ? { ...task, state: "started" } : task)
    : data.tasks;
  return (
    <View style={{ gap: 4 }}>
      <TaskTable tasks={tasks} colors={colors} layout={layout}
        status={data.source === "completion" ? completionResult : data.source === "meantime" && data.action === "wait" ? waitStatus : undefined} />
      {data.moreOffset !== undefined ? <Text style={{ color: secondaryColor(colors), fontSize: 10,
        fontFamily: monoFont(layout.platform) }}>More tasks not shown (offset {data.moreOffset})</Text> : null}
    </View>
  );
}

/**
 * Timeline transformer only sees one item. A running `meantime wait` carries
 * just the target id, so resolve that id against the agent timeline (the same
 * folding the board uses) to show the command being awaited instead of a bare
 * mt_xxxxxxxx. Pure card rendering stays in MeantimeTaskCard for node tests.
 */
export function ConnectedMeantimeTaskCard(props: PluginTimelineItemProps<MeantimeCardData>) {
  const paseo = usePaseo();
  const { agentId, item } = props;
  const data = item.data;
  const [resolved, setResolved] = useState<ReadonlyMap<string, TaskSummary>>(new Map());
  const unresolvedWait = data.source === "meantime" && data.action === "wait"
    ? data.tasks.filter(task => task.command === undefined).map(task => task.id)
    : [];
  const waitKey = unresolvedWait.join(",");

  useEffect(() => {
    if (unresolvedWait.length === 0) return;
    let cancelled = false;
    paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: RESOLUTION_PAGE_LIMIT }).then(page => {
      if (cancelled) return;
      const byId = new Map<string, TaskSummary>();
      for (const entry of page.entries) foldItem(byId, entry.item);
      setResolved(byId);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [agentId, paseo, waitKey]);

  if (unresolvedWait.length === 0) return <MeantimeTaskCard {...props} />;
  const tasks = data.tasks.map(task => resolveWaitTask(task, resolved));
  return <MeantimeTaskCard {...props} item={{ ...item, data: { ...data, tasks } }} />;
}
