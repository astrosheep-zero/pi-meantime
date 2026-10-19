import { usePaseo, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { TaskSummary } from "../shared/tasks.js";
import { foldItem, isActiveTask, sortTasks } from "../shared/tasks.js";
import { taskRowSpec } from "./rows.js";

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
  const [now, setNow] = useState(() => Date.now());

  const anyActive = tasks.some(isActiveTask);
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyActive]);

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
      flex: 1,
      padding: layout.compact ? 12 : 20,
      gap: 10,
      backgroundColor: colors.surface0,
    },
    title: { color: colors.foreground, fontSize: layout.compact ? 18 : 22 },
    muted: { color: colors.foregroundMuted, fontSize: 12 },
    error: { color: colors.statusDanger, fontSize: 13 },
    card: {
      backgroundColor: colors.surface1,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 8,
      padding: layout.compact ? 8 : 10,
      gap: 4,
    },
    rowHeading: { color: colors.foreground, fontSize: 13, flexShrink: 1 },
    rowMeta: { color: colors.foregroundMuted, fontSize: 12 },
  }), [colors, layout.compact]);

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.screen}>
      <Text style={styles.title}>Background tasks{tasks.length ? ` (${tasks.length})` : ""}</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {tasks.length === 0 && !error
        ? <Text style={styles.muted}>No pi-meantime tasks found on this agent's timeline.</Text>
        : null}
      {tasks.map(task => {
        const row = taskRowSpec(task, colors, now);
        return (
          <View key={task.id} style={styles.card}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ color: row.color, fontSize: 12 }}>●</Text>
              <Text style={styles.rowHeading} numberOfLines={1}>{row.heading}</Text>
              {row.elapsed ? <Text style={styles.rowMeta}>{row.elapsed}</Text> : null}
              <Text style={[styles.rowMeta, { color: row.color }]}>{row.state}</Text>
            </View>
            {row.command ? <Text style={styles.rowMeta} numberOfLines={2}>{row.command}</Text> : null}
            {row.progress ? <Text style={styles.rowMeta} numberOfLines={1}>{row.progress}</Text> : null}
            {row.outputPath ? <Text style={styles.rowMeta} numberOfLines={1}>{row.outputPath}</Text> : null}
            {row.note ? <Text style={styles.rowMeta}>{row.note}</Text> : null}
          </View>
        );
      })}
      {hasOlder
        ? <Text style={styles.muted}>Only the latest {PAGE_LIMIT} timeline entries were scanned; older tasks may be missing.</Text>
        : null}
      <Text style={styles.muted}>Read-only. To cancel, ask the agent: meantime cancel {"<id>"}.</Text>
    </ScrollView>
  );
}
