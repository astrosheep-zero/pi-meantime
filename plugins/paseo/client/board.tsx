import { usePaseo, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { TaskSummary } from "../shared/tasks.js";
import { foldItem, sortTasks } from "../shared/tasks.js";
import { TintedCard } from "./card.js";
import { secondaryColor, typeStyle } from "./rows.js";
import { Pip, StatusRule } from "./task-view.js";
import { ListCard, ListTitle } from "./task-card.js";
import { loadBoardTasks } from "./board-data.js";

/** Read-only task inventory folded from the complete timeline, including older pages. */
export function MeantimeBoard({ agentId, theme, layout }: PluginAgentPanelProps) {
  const paseo = usePaseo();
  const colors = useMemo(() => theme.colors, [theme]);
  const [tasks, setTasks] = useState<readonly TaskSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handle = paseo.agents.ref(agentId);
    let cancelled = false, generation = 0;
    let loading: unknown[] | undefined, request: AbortController | undefined;
    const load = () => {
      request?.abort(); request = new AbortController();
      const ticket = ++generation, updates: unknown[] = [];
      loading = updates;
      loadBoardTasks(handle.timeline, request.signal).then(history => {
        if (cancelled || ticket !== generation) return;
        const byId = new Map(history.map(task => [task.id, task]));
        for (const item of updates) foldItem(byId, item);
        loading = undefined;
        setTasks(sortTasks([...byId.values()]));
        setError(null);
      }).catch((cause: unknown) => {
        if (!cancelled && ticket === generation) {
          loading = undefined;
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    };
    setTasks(null); setError(null);
    const subscription = handle.timeline.subscribe(event => {
      if (cancelled) return;
      const inner = event.event;
      if (inner.type === "replacement" || inner.type === "subscription_restored") {
        load();
        return;
      }
      if (inner.type !== "timeline") return;
      loading?.push(inner.item);
      setTasks(prev => {
        if (!prev) return prev;
        const byId = new Map(prev.map(task => [task.id, task]));
        return foldItem(byId, inner.item) ? sortTasks([...byId.values()]) : prev;
      });
    });
    subscription.ready.then(() => { if (!cancelled) load(); }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { cancelled = true; request?.abort(); subscription(); };
  }, [agentId, paseo]);

  return <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: layout.compact ? 12 : 20, gap: 8, backgroundColor: colors.surface0, maxWidth: 720, width: "100%", alignSelf: "center" }}>
    {error ? <TintedCard colors={colors} tone="bad" layout={layout}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pip tone="bad" colors={colors} />
        <ListTitle colors={colors} layout={layout} flex />
      </View>
      <StatusRule colors={colors} />
      <Text style={{ ...typeStyle(layout.platform, "body"), color: secondaryColor(colors) }}>{error}</Text>
    </TintedCard> : null}
    {tasks ? <ListCard colors={colors} layout={layout} data={{ source: "meantime", action: "list", tasks: [...tasks], total: tasks.length, remainingCount: 0 }}
      hint="Ask the agent to cancel a task." /> : null}
  </ScrollView>;
}
