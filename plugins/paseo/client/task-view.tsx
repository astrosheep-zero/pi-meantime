import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { TaskSummary } from "../shared/tasks.js";
import { isActiveTask, outputPreview } from "../shared/tasks.js";
import { Card } from "./card.js";
import { CODE_FONT_SIZE, CODE_LINE_HEIGHT, dividerColor, doneColor, formatElapsed, frameColor, mixColor, monoFont, secondaryColor, stateColor, stateText, taskStateLabel } from "./rows.js";

type Colors = PluginTheme["colors"];
type Layout = { compact: boolean; platform: "ios" | "android" | "web" };

/**
 * Status glyph in a fixed 14px slot pinned to the first text line: solid dot
 * for a live process, hollow ring when parked, check and cross for outcomes.
 * `muted` only quiets a success; a failure stays red wherever it appears.
 */
export function TaskGlyph({ task, colors, muted = false }: {
  task: Pick<TaskSummary, "state">; colors: Colors; muted?: boolean;
}) {
  const parked = task.state === "waiting" || task.state === "queued" || task.state === "cancel_requested";
  const slot = { width: 14, height: CODE_LINE_HEIGHT, alignItems: "center" as const, justifyContent: "center" as const };
  const mark = (glyph: string, color: string) => (
    <View style={slot}><Text style={{ fontSize: 12, lineHeight: CODE_LINE_HEIGHT, fontWeight: "600", color }}>{glyph}</Text></View>
  );
  if (task.state === "completed") return mark("✓", muted ? secondaryColor(colors) : doneColor(colors));
  if (task.state === "failed") return mark("✕", stateColor("failed", colors));
  if (task.state === "cancelled") return mark("✕", secondaryColor(colors));
  if (!isActiveTask(task) && !parked) return mark("?", frameColor(colors));
  const accent = stateColor(task.state, colors);
  const size = parked ? 8 : 7;
  const dot = { width: size, height: size, borderRadius: size / 2, borderWidth: parked ? 1.5 : 0,
    borderColor: accent, backgroundColor: parked ? "transparent" : accent };
  return <View style={slot}><View style={dot} /></View>;
}

/** Collapsed: one flattened line. Open: the same header unfolds in place with
 * a `$` prompt, selectable, so the drawer never prints the command twice. */
export function TaskCommand({ task, colors, layout, open = false, quiet = false }: {
  task: TaskSummary; colors: Colors; layout: Layout; open?: boolean; quiet?: boolean;
}) {
  const raw = task.command?.trim() || undefined;
  const command = raw === undefined || open ? raw : raw.replace(/\s+/g, " ");
  // Env assignments belong with the command word; only arguments recede.
  const head = command === undefined ? undefined : /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*\S+/.exec(command)?.[0];
  const tail = command === undefined ? "" : command.slice(head?.length ?? 0);
  const muted = secondaryColor(colors);
  return (
    <Text selectable={open} numberOfLines={open ? undefined : 1} style={{ minWidth: 0,
      color: quiet ? muted : colors.foreground,
      fontFamily: monoFont(layout.platform), fontSize: CODE_FONT_SIZE, lineHeight: CODE_LINE_HEIGHT }}>
      {command ? <>{open ? <Text style={{ color: muted }}>$ </Text> : null}{head}<Text style={{ color: muted }}>{tail}</Text></>
        // A sparse receipt has no command: name what it is, never pass the id off as one.
        : <>{task.tool ?? "task"}<Text style={{ color: frameColor(colors) }}> {task.id}</Text></>}
    </Text>
  );
}

/** The trailing word: an abnormal outcome always speaks; otherwise elapsed
 * time does, and only a row without a duration falls back to its state. */
function trailingWord(task: TaskSummary, elapsed: string | undefined): string | undefined {
  if (task.exitCode !== undefined && task.exitCode !== 0) return `exit ${task.exitCode}`;
  if (["failed", "cancelled", "cancel_requested", "outcome_unknown"].includes(task.state)) return stateText(task.state);
  return elapsed ? undefined : stateText(task.state);
}

/**
 * Command first; status and elapsed are trailing facts pinned to the first
 * 18px line, so notes or an unfolded command grow the row downward. Task ids
 * appear only where the user can act on them (the board).
 */
export function TaskLine({ task, colors, layout, showId, muted: quiet = false, defaultOpen = false }: {
  task: TaskSummary; colors: Colors; layout: Layout; showId?: boolean; muted?: boolean; defaultOpen?: boolean;
}) {
  const mono = monoFont(layout.platform);
  const muted = secondaryColor(colors);
  const meta = { fontSize: 12, lineHeight: CODE_LINE_HEIGHT, color: muted };
  const elapsed = formatElapsed(task);
  const word = trailingWord(task, elapsed);
  const alarm = task.state === "failed" || (task.exitCode !== undefined && task.exitCode !== 0);
  const [open, setOpen] = useState(defaultOpen);
  const notes = [task.progress,
    task.cancelRequested && task.state !== "cancel_requested" ? "cancel requested" : undefined].filter(Boolean);
  const success = task.state === "completed" && !alarm;
  return (
    <View>
      <Pressable onPress={() => setOpen(prev => !prev)} accessibilityRole="button" accessibilityLabel={taskStateLabel(task)}
        style={state => {
          const hovered = (state as { hovered?: boolean }).hovered;
          return { backgroundColor: hovered ? mixColor(colors.surface1, colors.foreground, 0.04) : "transparent",
            opacity: state.pressed ? 0.85 : 1 };
        }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, paddingHorizontal: 12, paddingVertical: 9 }}>
          <TaskGlyph task={task} colors={colors} muted={quiet && success} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <TaskCommand task={task} colors={colors} layout={layout} open={open} quiet={quiet && success} />
            {notes.map((note, index) => (
              <Text key={index} numberOfLines={1} style={{ ...meta, fontFamily: mono, fontSize: 11, lineHeight: 16 }}>{note}</Text>
            ))}
          </View>
          <View style={{ height: CODE_LINE_HEIGHT, flexDirection: "row", alignItems: "center", gap: 8 }}>
            {showId ? (
              <Text accessibilityLabel={task.id} selectable numberOfLines={1}
                style={{ ...meta, fontFamily: mono, fontSize: 11, color: frameColor(colors) }}>
                {task.id.replace(/^mt_/, "").slice(0, 4)}
              </Text>
            ) : null}
            {elapsed ? <Text numberOfLines={1} style={{ ...meta, fontVariant: ["tabular-nums"] }}>{elapsed}</Text> : null}
            {word ? <Text numberOfLines={1} style={{ ...meta, color: alarm ? stateColor("failed", colors) : muted }}>{word}</Text> : null}
            <Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} color={frameColor(colors)} />
          </View>
        </View>
      </Pressable>
      {open ? <TaskDetailInline task={task} colors={colors} layout={layout} /> : null}
    </View>
  );
}

/** Drawer under an open row: output sits in a recessed terminal well, then one
 * quiet footer line of facts. The command lives in the header above. */
export function TaskDetailInline({ task, colors, layout }: {
  task: TaskSummary; colors: Colors; layout: Layout;
}) {
  const mono = monoFont(layout.platform);
  const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour12: false });
  const footer = [
    task.id,
    task.createdAt !== undefined && task.endedAt !== undefined
      ? `${clock(task.createdAt)} → ${clock(task.endedAt)}`
      : task.createdAt !== undefined ? `started ${clock(task.createdAt)}` : undefined,
    task.recovered ? "recovered" : undefined,
    task.isError && task.state !== "failed" ? "error reported" : undefined,
    task.outputPath,
  ].filter(Boolean).join(" · ");
  const output = outputPreview(task.output ?? task.outputTail ?? "").replace(/^\n+|\s+$/g, "");
  return (
    <View style={{ paddingLeft: 34, paddingRight: 12, paddingBottom: 10, gap: 6 }}>
      {output ? (
        <ScrollView nestedScrollEnabled style={{ maxHeight: layout.compact ? 260 : 380, borderRadius: 4,
          backgroundColor: colors.surface0, borderWidth: 1, borderColor: dividerColor(colors) }}
          contentContainerStyle={{ paddingHorizontal: 10, paddingVertical: 8 }}>
          <Text selectable style={{ color: colors.foreground, fontFamily: mono, fontSize: CODE_FONT_SIZE, lineHeight: CODE_LINE_HEIGHT }}>{output}</Text>
        </ScrollView>
      ) : null}
      <Text selectable style={{ color: secondaryColor(colors), fontFamily: mono, fontSize: 11, lineHeight: 16 }}>{footer}</Text>
    </View>
  );
}

export function TaskTable({ tasks, colors, layout, showId }: {
  tasks: readonly TaskSummary[]; colors: Colors; layout: Layout; showId?: boolean;
}) {
  const divider = dividerColor(colors);
  return (
    <Card colors={colors}>
      {tasks.map((task, index) => (
        <View key={task.id} style={index > 0 ? { borderTopWidth: 1, borderTopColor: divider } : undefined}>
          <TaskLine task={task} colors={colors} layout={layout} showId={showId} />
        </View>
      ))}
    </Card>
  );
}
