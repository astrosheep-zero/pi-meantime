import { usePaseo, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { MeantimeCardData, TaskSummary } from "../shared/tasks.js";
import { foldItem } from "../shared/tasks.js";
import { completionResult, monoFont, secondaryColor } from "./rows.js";
import { TaskTable } from "./task-view.js";
import { WaitCard } from "./wait-card.js";

const RESOLUTION_PAGE_LIMIT = 500;

export function MeantimeTaskCard(props: PluginTimelineItemProps<MeantimeCardData>) {
  const { item, theme, layout } = props;
  if (item.data.source === "meantime" && item.data.action === "wait") return <WaitCard {...props} />;
  const { colors } = theme;
  const data = item.data;
  // Even a snapshot-backed launch handle is historical evidence of starting,
  // not a continuing observation of a running process.
  const tasks = data.source === "handle"
    ? data.tasks.map(task => task.state === "running" ? { ...task, state: "started" } : task)
    : data.tasks;
  return (
    <View style={{ gap: 4 }}>
      <TaskTable tasks={tasks} colors={colors} layout={layout}
        status={data.source === "completion" ? completionResult : undefined} />
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
  const [resolved, setResolved] = useState<Readonly<Record<string, TaskSummary>>>({});
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
      const next: Record<string, TaskSummary> = {};
      for (const id of unresolvedWait) {
        const found = byId.get(id);
        if (found) next[id] = found;
      }
      setResolved(next);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [agentId, paseo, waitKey]);

  if (unresolvedWait.length === 0) return <MeantimeTaskCard {...props} />;
  const tasks = data.tasks.map(task => {
    const found = resolved[task.id];
    if (!found) return task;
    // Resolve identity only: later timeline results must not rewrite this receipt.
    return { ...task, command: task.command ?? found.command, tool: task.tool ?? found.tool };
  });
  return <MeantimeTaskCard {...props} item={{ ...item, data: { ...data, tasks } }} />;
}
