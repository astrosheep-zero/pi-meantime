import { usePaseo, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { TaskSummary } from "../shared/tasks.js";
import { foldItem, foldTimeline, isActiveTask, sortTasks } from "../shared/tasks.js";
import { TintedCard, taskTone } from "./card.js";
import { secondaryColor, stateColor } from "./rows.js";
import { TaskLine } from "./task-view.js";

const PAGE_LIMIT = 500;

/**
 * Read-only board of an agent's pi-meantime background tasks, folded from
 * the client-cached timeline. No server component: the timeline is the only
 * source of truth (v1 doctrine). Control stays in chat — ask the agent to
 * `meantime cancel <id>`.
 * The panel chrome already names the panel, so the body is just one rail card
 * per task — the same object the timeline shows — plus muted footnotes.
 */
export function MeantimeBoard({ agentId, theme, layout }: PluginAgentPanelProps) {
  const paseo = usePaseo();
  const colors = useMemo(() => theme.colors, [theme]);
  const [tasks, setTasks] = useState<readonly TaskSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasOlder, setHasOlder] = useState(false);

  useEffect(() => {
    const handle = paseo.agents.ref(agentId);
    let cancelled = false;
    const load = () => {
      handle.timeline.refetch({ direction: "tail", limit: PAGE_LIMIT }).then(page => {
        if (cancelled) return;
        setTasks(foldTimeline(page.entries));
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
      padding: layout.compact ? 12 : 20,
      gap: 8,
      backgroundColor: theme.colors.surface0,
      maxWidth: 720,
      width: "100%" as const,
      alignSelf: "center" as const,
    },
    muted: { color: secondaryColor(theme.colors), fontSize: 11.5, lineHeight: 16 },
    error: { color: stateColor("failed", theme.colors), fontSize: 11.5 },
  }), [colors, theme.colors, layout.compact]);

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.screen}>
      {tasks.length === 0
        ? <Text style={styles.muted}>No background tasks</Text>
        : tasks.map(task => (
          <TintedCard key={task.id} colors={colors} layout={layout} tone={taskTone(task)}>
            <TaskLine task={task} colors={colors} layout={layout} showId muted={!isActiveTask(task)} />
          </TintedCard>
        ))}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {hasOlder
        ? <Text style={styles.muted}>Only the latest {PAGE_LIMIT} timeline entries were scanned; older tasks may be missing.</Text>
        : null}
      {tasks.some(isActiveTask)
        ? <Text style={styles.muted}>Ask the agent to cancel a task.</Text>
        : null}
    </ScrollView>
  );
}
