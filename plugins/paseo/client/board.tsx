import { usePaseo, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { TaskSummary } from "../shared/tasks.js";
import { foldItem, isActiveTask, sortTasks } from "../shared/tasks.js";
import { monoFont, secondaryColor, stateColor } from "./rows.js";
import { TaskTable } from "./task-view.js";

const PAGE_LIMIT = 500;

/**
 * Read-only board of an agent's pi-meantime background tasks, folded from
 * the client-cached timeline. No server component: the timeline is the only
 * source of truth (v1 doctrine). Control stays in chat — ask the agent to
 * `meantime cancel <id>`.
 */
export function MeantimeBoard({ agentId, theme, layout }: PluginAgentPanelProps) {
  const paseo = usePaseo();
  const { colors } = theme;
  const [tasks, setTasks] = useState<readonly TaskSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasOlder, setHasOlder] = useState(false);

  const active = useMemo(() => tasks.filter(isActiveTask), [tasks]);
  const finished = useMemo(() => tasks.filter(task => !isActiveTask(task)), [tasks]);

  useEffect(() => {
    const handle = paseo.agents.ref(agentId);
    let cancelled = false;
    const load = () => {
      handle.timeline.refetch({ direction: "tail", limit: PAGE_LIMIT }).then(page => {
        if (cancelled) return;
        const byId = new Map<string, TaskSummary>();
        for (const entry of page.entries) foldItem(byId, entry.item);
        setTasks(sortTasks([...byId.values()]));
        setHasOlder(page.hasOlder);
        setError(page.error);
      }).catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    };
    load();
    const subscription = handle.timeline.subscribe(event => {
      if (cancelled) return;
      const inner = event.event;
      if (inner.type === "replacement" || inner.type === "subscription_restored") {
        load();
        return;
      }
      if (inner.type !== "timeline") return;
      setTasks(prev => {
        const byId = new Map(prev.map(task => [task.id, task]));
        return foldItem(byId, inner.item) ? sortTasks([...byId.values()]) : prev;
      });
    });
    subscription.ready.catch(() => {});
    return () => { cancelled = true; subscription(); };
  }, [agentId, paseo]);

  const styles = useMemo(() => ({
    screen: {
      flexGrow: 1,
      padding: layout.compact ? 14 : 24,
      gap: 12,
      backgroundColor: colors.surface0,
      maxWidth: 720,
      width: "100%" as const,
      alignSelf: "center" as const,
    },
    title: { color: colors.foreground, fontSize: 10, lineHeight: 16, fontFamily: monoFont(layout.platform) },
    summary: { color: secondaryColor(colors), fontSize: 10, lineHeight: 16, fontFamily: monoFont(layout.platform) },
    muted: { color: secondaryColor(colors), fontSize: 10, lineHeight: 16, fontFamily: monoFont(layout.platform) },
    error: { color: stateColor("failed", colors), fontSize: 10, fontFamily: monoFont(layout.platform) },
  }), [colors, layout.compact, layout.platform]);

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.screen}>
      <View style={{ gap: 2 }}>
        <Text style={styles.title}>Background tasks</Text>
        <Text style={styles.summary}>
          {tasks.length === 0 ? "Nothing on this agent's timeline"
            : `${active.length} active · ${finished.length} finished`}
        </Text>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {tasks.length > 0 ? <TaskTable tasks={tasks} colors={colors} layout={layout} showId /> : null}
      {hasOlder
        ? <Text style={styles.muted}>Only the latest {PAGE_LIMIT} timeline entries were scanned; older tasks may be missing.</Text>
        : null}
      <Text style={styles.muted}>Read-only. To cancel, ask the agent: meantime cancel {"<id>"}.</Text>
    </ScrollView>
  );
}
