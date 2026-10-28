import { usePaseo, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { TaskSummary } from "../shared/tasks.js";
import { foldItem, foldTimeline, sortTasks } from "../shared/tasks.js";
import { Card } from "./card.js";
import { meantimeTheme } from "./palette.js";
import { dividerColor, secondaryColor, stateColor } from "./rows.js";
import { TaskLine } from "./task-view.js";

const PAGE_LIMIT = 500;

/**
 * Read-only board of an agent's pi-meantime background tasks, folded from
 * the client-cached timeline. No server component: the timeline is the only
 * source of truth (v1 doctrine). Control stays in chat — ask the agent to
 * `meantime cancel <id>`.
 */
export function MeantimeBoard({ agentId, theme, layout }: PluginAgentPanelProps) {
  const paseo = usePaseo();
  const colors = useMemo(() => meantimeTheme(theme).colors, [theme]);
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
      padding: layout.compact ? 14 : 24,
      gap: 12,
      backgroundColor: colors.surface0,
      maxWidth: 720,
      width: "100%" as const,
      alignSelf: "center" as const,
    },
    title: { color: colors.foreground, fontSize: 13, lineHeight: 16, fontWeight: "500" as const, letterSpacing: -0.2 },
    muted: { color: secondaryColor(colors), fontSize: 12, lineHeight: 16 },
    error: { color: stateColor("failed", colors), fontSize: 12 },
  }), [colors, layout.compact]);

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.screen}>
      <Card colors={colors}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12,
          paddingHorizontal: 12, paddingVertical: 9,
          borderBottomWidth: tasks.length > 0 ? 1 : 0, borderBottomColor: dividerColor(colors) }}>
          <Text style={styles.title}>Background tasks</Text>
          <Text style={styles.muted}>
            {tasks.length === 0 ? "None" : `${tasks.length} task${tasks.length === 1 ? "" : "s"}`}
          </Text>
        </View>
        {tasks.length === 0
          ? <Text style={{ ...styles.muted, paddingHorizontal: 12, paddingVertical: 9 }}>Nothing on this agent's timeline</Text>
          : tasks.map((task, index) => (
            <View key={task.id} style={index > 0
              ? { borderTopWidth: 1, borderTopColor: dividerColor(colors) } : undefined}>
              <TaskLine task={task} colors={colors} layout={layout} showId />
            </View>
          ))}
      </Card>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {hasOlder
        ? <Text style={styles.muted}>Only the latest {PAGE_LIMIT} timeline entries were scanned; older tasks may be missing.</Text>
        : null}
      <Text style={styles.muted}>Ask the agent to cancel a task.</Text>
    </ScrollView>
  );
}
