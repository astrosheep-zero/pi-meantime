import { usePaseo, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { TaskSummary } from "../shared/tasks.js";
import { foldItem, foldTimeline, sortTasks } from "../shared/tasks.js";
import { TintedCard } from "./card.js";
import { secondaryColor, typeStyle } from "./rows.js";
import { Pip, StatusRule } from "./task-view.js";
import { ListCard } from "./task-card.js";

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

  useEffect(() => {
    const handle = paseo.agents.ref(agentId);
    let cancelled = false;
    const load = () => {
      handle.timeline.refetch({ direction: "tail", limit: PAGE_LIMIT }).then(page => {
        if (cancelled) return;
        setTasks(foldTimeline(page.entries));
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

  return <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: layout.compact ? 12 : 20, gap: 8, backgroundColor: colors.surface0, maxWidth: 720, width: "100%", alignSelf: "center" }}>
    {error ? <TintedCard colors={colors} tone="bad" layout={layout}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pip tone="bad" colors={colors} />
        <Text style={{ ...typeStyle(layout.platform, "title", true), color: colors.foreground }}>Background tasks unavailable</Text>
      </View>
      <StatusRule colors={colors} />
      <Text style={{ ...typeStyle(layout.platform, "body"), color: secondaryColor(colors) }}>{error}</Text>
    </TintedCard> : null}
    {tasks.length > 0 || !error ? <ListCard colors={colors} layout={layout} data={{ source: "meantime", action: "list", tasks: [...tasks] }}
      hint="Ask the agent to cancel a task." /> : null}
  </ScrollView>;
}
