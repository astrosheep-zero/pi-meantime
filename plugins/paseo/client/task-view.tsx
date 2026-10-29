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
 * Status glyph: semantic marks instead of one anonymous dot. Solid static dot
 * for a live process, hollow ring when parked (waiting/queued/cancel
 * requested) with steady ink. Check and cross for terminal outcomes. Fixed slot
 * keeps every row's command edge aligned.
 */
export function TaskGlyph({ task, colors, muted = false }: {
  task: Pick<TaskSummary, "state">; colors: Colors; muted?: boolean;
}) {
  const parked = task.state === "waiting" || task.state === "queued" || task.state === "cancel_requested";
  const slot = { width: 12, height: CODE_LINE_HEIGHT, alignItems: "center" as const, justifyContent: "center" as const };
  const mark = (glyph: string, color: string) => (
    <View style={slot}><Text style={{ fontSize: 10, lineHeight: CODE_LINE_HEIGHT, color }}>{glyph}</Text></View>
  );
  if (task.state === "completed") return mark("✓", muted ? secondaryColor(colors) : doneColor(colors));
  if (task.state === "failed") return mark("✕", muted ? secondaryColor(colors) : stateColor(task.state, colors));
  if (task.state === "cancelled") return mark("✕", secondaryColor(colors));
  // Parked states fall through to the ring below; anything else we cannot read
  // stays an honest question mark rather than a fabricated status.
  if (!isActiveTask(task) && !parked) return mark("?", frameColor(colors));
  const accent = stateColor(task.state, colors);
  const dot = { width: 6, height: 6, borderRadius: 3, borderWidth: parked ? 1.5 : 0,
    borderColor: accent, backgroundColor: parked ? "transparent" : accent };
  return <View style={slot}><View style={dot} /></View>;
}

/** Collapsed, the header is one line. Expanded, the drawer carries the whole
 * invocation, with wrapping enabled so no full command is lost to ellipsis. */
export function TaskCommand({ task, colors, layout, open = false }: {
  task: TaskSummary; colors: Colors; layout: Layout; open?: boolean;
}) {
  const raw = task.command?.trim() || undefined;
  const command = raw === undefined || open ? raw : raw.replace(/\s+/g, " ");
  // Env assignments belong with the command word; only arguments stay muted.
  const head = command === undefined ? undefined : /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*\S+/.exec(command)?.[0];
  const tail = command === undefined ? "" : command.slice(head?.length ?? 0);
  const muted = secondaryColor(colors);
  return (
    <Text selectable={open} numberOfLines={open ? undefined : 1} style={{ minWidth: 0, color: colors.foreground,
      fontFamily: monoFont(layout.platform), fontSize: CODE_FONT_SIZE, lineHeight: CODE_LINE_HEIGHT }}>
      {command ? <>{open ? <Text style={{ color: muted }}>$ </Text> : null}{head}<Text style={{ color: muted }}>{tail}</Text></>
        : <Text style={{ color: muted }}>{task.tool ?? task.id}</Text>}
    </Text>
  );
}

/**
 * Command first; status and elapsed are trailing facts. Task ids are shown only
 * where the user can act on them (the board), not as timeline decoration.
 * Details expand in place under the row — a press never covers the timeline.
 * Notes sit in the command column so they share its left edge without an
 * indent constant.
 * The glyph and the trailing status controls are pinned to the first 18px
 * text line, so a progress note or an unfolded multi-line command grows the row
 * downward instead of dragging the status mark to the vertical middle.
 */
export function TaskLine({ task, colors, layout, showId, muted: quiet = false, defaultOpen = false, last = true }: {
  task: TaskSummary; colors: Colors; layout: Layout; showId?: boolean; muted?: boolean; defaultOpen?: boolean; last?: boolean;
}) {
  const mono = monoFont(layout.platform);
  const muted = secondaryColor(colors);
  const meta = { fontSize: 12, lineHeight: 16, color: muted };
  const elapsed = formatElapsed(task);
  const extraStatus = task.exitCode !== undefined && task.exitCode !== 0 ? `exit ${task.exitCode}`
    : ["running", "started", "waiting", "queued", "completed"].includes(task.state) ? ""
    : stateText(task.state);
  const [open, setOpen] = useState(defaultOpen);
  const notes = [task.progress, task.outputPath,
    task.cancelRequested && task.state !== "cancel_requested" ? "cancel requested" : undefined,
    task.recovered ? "recovered" : undefined,
    task.isError && task.state !== "failed" ? "error reported" : undefined].filter(Boolean);
  const trailing = (
    <View style={{ height: CODE_LINE_HEIGHT, flexDirection: "row", alignItems: "center", gap: 8 }}>
      {showId ? (
        <Text accessibilityLabel={task.id} selectable style={{ ...meta, fontFamily: mono, fontSize: 11, opacity: 0.7 }} numberOfLines={1}>
          {task.id.replace(/^mt_/, "").slice(0, 4)}
        </Text>
      ) : null}
      {elapsed ? <Text style={{ ...meta, fontVariant: ["tabular-nums"], letterSpacing: 0.2 }} numberOfLines={1}>{elapsed}</Text> : null}
      {extraStatus ? <Text accessibilityLabel={taskStateLabel(task)} style={{ ...meta, letterSpacing: 0.2 }} numberOfLines={1}>
        {extraStatus}
      </Text> : null}
      <Icon name={open ? "ChevronUp" : "ChevronDown"} size={15} color={muted} />
    </View>
  );
  return (
    <View>
      <Pressable onPress={() => setOpen(prev => !prev)} accessibilityRole="button" accessibilityLabel={taskStateLabel(task)}
        style={state => {
          const hovered = (state as { hovered?: boolean }).hovered;
          return { backgroundColor: hovered ? mixColor(colors.surface1, colors.surface0, 0.25) : "transparent",
            opacity: state.pressed ? 0.85 : 1 };
        }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10,
          paddingHorizontal: 12, paddingVertical: 9 }}>
          <TaskGlyph task={task} colors={colors} muted={quiet} />
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <TaskCommand task={task} colors={colors} layout={layout} />
            {notes.map((note, index) => (
              <Text key={index} numberOfLines={1} style={{ ...meta, fontFamily: mono, fontSize: 11 }}>{note}</Text>
            ))}
          </View>
          {trailing}
        </View>
      </Pressable>
      {open ? <TaskDetailInline task={task} colors={colors} layout={layout} last={last} /> : null}
    </View>
  );
}

/** Recessed full-width drawer separated from the header by a 1px hairline:
 * the complete command, output and metadata share the full card width and
 * scroll together. Always repeating the command avoids fragile, platform-
 * dependent guesses about whether the collapsed line was ellipsized. */
export function TaskDetailInline({ task, colors, layout, last = true }: {
  task: TaskSummary; colors: Colors; layout: Layout; last?: boolean;
}) {
  const mono = monoFont(layout.platform);
  const divider = dividerColor(colors);
  const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour12: false });
  const meta = [
    task.id,
    task.createdAt !== undefined && task.endedAt !== undefined
      ? `${clock(task.createdAt)} → ${clock(task.endedAt)}`
      : task.createdAt !== undefined ? `started ${clock(task.createdAt)}` : undefined,
    task.notification === "observed" || task.notification === "delivered" ? task.notification : undefined,
    task.recovered ? "recovered" : undefined,
    task.isError && task.state !== "failed" ? "error reported" : undefined,
  ].filter(Boolean).join(" · ");
  const cmd = task.command?.trim();
  const output = outputPreview(task.output ?? task.outputTail ?? "").replace(/^\n+|\s+$/g, "");
  const drawer = { backgroundColor: colors.surface0,
    borderTopWidth: 1, borderTopColor: divider,
    borderBottomLeftRadius: last ? 3 : 0, borderBottomRightRadius: last ? 3 : 0,
    maxHeight: layout.compact ? 280 : 400 };
  return <ScrollView style={drawer} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 10, gap: 8 }}
    nestedScrollEnabled>
    {cmd !== undefined ? <TaskCommand task={task} colors={colors} layout={layout} open /> : null}
    {output ? <Text selectable style={{ color: colors.foreground, fontFamily: mono, fontSize: CODE_FONT_SIZE, lineHeight: CODE_LINE_HEIGHT }}>{output}</Text> : null}
    {meta ? <Text selectable style={{ color: secondaryColor(colors), fontFamily: mono, fontSize: 11, lineHeight: 16 }}>{meta}</Text> : null}
    {task.outputPath ? (
      <Text selectable style={{ color: secondaryColor(colors), fontFamily: mono, fontSize: 11, lineHeight: 16 }}>
        Output file: {task.outputPath}
      </Text>
    ) : null}
  </ScrollView>;
}

export function TaskTable({ tasks, colors, layout, showId }: {
  tasks: readonly TaskSummary[]; colors: Colors; layout: Layout; showId?: boolean;
}) {
  const divider = dividerColor(colors);
  return (
    <Card colors={colors}>
      {tasks.map((task, index) => (
        <View key={task.id} style={index > 0
          ? { borderTopWidth: 1, borderTopColor: divider } : undefined}>
          <TaskLine task={task} colors={colors} layout={layout} showId={showId}
            last={index === tasks.length - 1} />
        </View>
      ))}
    </Card>
  );
}
