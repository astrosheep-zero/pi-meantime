import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { View } from "react-native";
import type { MeantimeCardData } from "../shared/tasks.js";
import { Card } from "./card.js";
import { completionResult } from "./rows.js";
import { TaskLine } from "./task-view.js";

/** Wait status belongs to this call; task status is a returned snapshot.
 * Same card, same task rows as every other meantime surface — the wait
 * outcome is just the row's status and one note line. */
export function WaitCard({ item, theme, layout }: PluginTimelineItemProps<MeantimeCardData>) {
  const { colors } = theme;
  return <View style={{ gap: 6, marginTop: 4 }}>{item.data.tasks.map(task => {
    const waiting = task.state === "waiting";
    const terminal = ["completed", "failed", "cancelled"].includes(task.state);
    const title = waiting ? "Waiting" : terminal ? "Finished waiting" : "Wait ended";
    // "Waiting" needs no footnote; notes only carry information the title can't.
    const note = waiting ? undefined : terminal ? completionResult(task)
      : task.state === "running" ? "Still running when wait ended"
      : task.state === "cancel_requested" ? "Cancellation requested"
      : "Status unavailable";
    return <Card key={task.id} colors={colors}>
      <TaskLine task={task} colors={colors} layout={layout} status={title} note={note} waitStatus={title} />
    </Card>;
  })}</View>;
}
