import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import type { TaskSummary } from "../shared/tasks.js";
import { formatElapsed, monoFont, stateColor, stateLabel, tint } from "./rows.js";

type Colors = PluginTheme["colors"];
type Layout = { compact: boolean; platform: "ios" | "android" | "web" };

export function StatePill({ state, colors }: { state: string; colors: Colors }) {
  const color = stateColor(state, colors);
  return (
    <View style={{
      backgroundColor: tint(color, "1F"),
      borderRadius: 999,
      paddingHorizontal: 7,
      paddingVertical: 2,
    }}>
      <Text style={{ color, fontSize: 10, fontWeight: "600", letterSpacing: 0.6 }}>
        {stateLabel(state)}
      </Text>
    </View>
  );
}

/**
 * One task as a self-contained row: state-colored rail on the left, mono id
 * and tool on the first line, command/progress below, pill and elapsed on
 * the right. Shared by the timeline card and the board.
 */
export function TaskLine({ task, colors, layout, now }: {
  task: TaskSummary;
  colors: Colors;
  layout: Layout;
  now?: number;
}) {
  const color = stateColor(task.state, colors);
  const mono = monoFont(layout.platform);
  const elapsed = formatElapsed(task, now);
  const sub = task.progress ?? task.command;
  const notes: string[] = [];
  if (task.exitCode !== undefined) notes.push(`exit ${task.exitCode}`);
  if (task.cancelRequested) notes.push("cancel requested");
  if (task.recovered) notes.push("recovered");
  if (task.isError && task.state !== "failed") notes.push("error");

  return (
    <View style={{ flexDirection: "row", gap: 10, alignItems: "stretch" }}>
      <View style={{ width: 3, borderRadius: 2, backgroundColor: color }} />
      <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
          <Text style={{ color: colors.foreground, fontSize: 12.5, fontFamily: mono }} numberOfLines={1}>
            {task.id}
          </Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
            {task.tool}
          </Text>
        </View>
        {sub ? (
          <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontFamily: mono }} numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
        {task.outputPath && task.state !== "running" ? (
          <Text style={{ color: colors.foregroundMuted, fontSize: 10.5, fontFamily: mono, opacity: 0.8 }} numberOfLines={1}>
            {task.outputPath}
          </Text>
        ) : null}
        {notes.length ? (
          <Text style={{ color: colors.foregroundMuted, fontSize: 10.5 }} numberOfLines={1}>
            {notes.join(" · ")}
          </Text>
        ) : null}
      </View>
      <View style={{ alignItems: "flex-end", gap: 3 }}>
        <StatePill state={task.state} colors={colors} />
        {elapsed ? (
          <Text style={{ color: colors.foregroundMuted, fontSize: 10.5, fontVariant: ["tabular-nums"] }}>
            {elapsed}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** Small letterspaced section label, the premium-looking kind. */
export function SectionLabel({ text, colors, trailing }: { text: string; colors: Colors; trailing?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 10.5, fontWeight: "600", letterSpacing: 1.4 }}>
        {text.toUpperCase()}
      </Text>
      {trailing ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: 10.5, letterSpacing: 0.4 }}>{trailing}</Text>
      ) : null}
    </View>
  );
}
