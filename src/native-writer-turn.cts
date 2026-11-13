import { createHash } from "node:crypto";

type ObjectRecord = Record<string, unknown>;
type NativeRow = { version: string; coordinate: number; raw: unknown };
const object = (value: unknown): ObjectRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectRecord)
    : undefined;
const own = (row: ObjectRecord, key: string) => Object.hasOwn(row, key);
const hasText = (value: unknown): value is string =>
  typeof value === "string" && Boolean(value.trim());
const textPart = (parts: unknown, kind: string): boolean =>
  Array.isArray(parts) &&
  parts.some((part: unknown) => {
    const p = object(part);
    return (
      p?.type === kind && typeof p.text === "string" && Boolean(p.text.trim())
    );
  });
const turnKey = (id: string | number) =>
  "turn-v1:" +
  createHash("sha256").update(String(id)).digest("hex").slice(0, 32);
const dshContextEvents = new Set([
  "agent-preset/selected",
  "agent/inbox/spliced",
  "approval/asked",
  "approval/decided",
  "approval/policy",
  "step/start",
  "step/end",
  "assistant/chunk",
  "assistant/attempt",
  "command/done",
  "command/run",
  "compaction/end",
  "compaction/prune",
  "compaction/start",
  "compaction/summary",
  "feedback/record",
  "feedback/message-delete",
  "feedback/message-put",
  "goal/change",
  "hook/invoked",
  "hook/result",
  "llm/retry",
  "llm/retry-started",
  "permission/preset",
  "plan/mode",
  "tool/call",
  "tool/result",
  "tool/code-dispatch",
  "tool/code-dispatch-start",
  "tool/ptc-dispatch",
  "tool/ptc-dispatch-start",
  "todo/write",
  "request/header",
  "request/context",
  "sandbox/mode",
  "schedule/change",
  "session/title",
  "session/title-llm-request",
  "subagent/descriptor",
  "subagent/catalog",
  "subagent/model-selection-policy",
  "tool-workflow/agent-end",
  "tool-workflow/agent-start",
  "tool-workflow/run-end",
  "tool-workflow/run-start",
  "web/deepseek-search-llm-request",
  "deliverables/presented",
  "model/selection",
  "session-log-deepseek/delivery-accepted",
  "system/message",
  "developer/message",
  "team/member",
  "team/message/delivered",
  "team/message/queued",
  "team/task",
  "image/offload",
  "job/registered",
  "job/settled",
  "workspace/changes",
]);

export function nativeWriterMembers(
  harness: string,
  turn: string,
  header: unknown,
  rows: readonly NativeRow[],
): string[] {
  if (
    rows.length < 4 ||
    !rows.every((row, index) => row.coordinate === rows[0]!.coordinate + index)
  )
    return [];
  const root = object(header);
  if (!root) return [];
  if (
    harness === "codex" &&
    (root.type !== "session_meta" || !hasText(object(root.payload)?.id))
  )
    return [];
  if (
    harness === "dsh" &&
    (root.type !== "session" ||
      ![0, 3, 4].some((version) => version === root.version) ||
      !hasText(root.id) ||
      root.isSeeded === true ||
      (root.version === 4 &&
        (!hasText(root.cwd) ||
          root.isSeeded !== false ||
          typeof root.createdAt !== "number" ||
          !Number.isSafeInteger(root.createdAt) ||
          typeof root.delegationDepth !== "number" ||
          !Number.isSafeInteger(root.delegationDepth) ||
          root.delegationDepth < 0)))
  )
    return [];
  const user = new Set<string>();
  const assistant = new Set<string>();
  let lastSeq: number | undefined;
  let codexStart = false;
  let codexContext = false;
  for (const [index, row] of rows.entries()) {
    const raw = object(row.raw);
    if (!raw) return [];
    if (harness === "codex") {
      const data = object(raw.payload);
      if (!data || typeof raw.timestamp !== "string") return [];
      const id = data.turn_id ?? data.turnId;
      const sameTurn = typeof id === "string" && turnKey(id) === turn;
      if (
        raw.type === "turn_context" ||
        (raw.type === "event_msg" && data.type === "task_started")
      ) {
        if (!sameTurn || assistant.size) return [];
        if (raw.type === "turn_context") {
          if (codexContext) return [];
          codexContext = true;
        } else {
          if (codexStart || index !== 0) return [];
          codexStart = true;
        }
        continue;
      }
      if (!codexStart && !codexContext) return [];
      if (
        raw.type === "session_meta" ||
        (raw.type === "event_msg" &&
          ["turn_aborted", "task_failed", "turn_failed"].includes(
            String(data.type),
          ))
      )
        return [];
      if (index === rows.length - 1) {
        if (
          raw.type !== "event_msg" ||
          data.type !== "task_complete" ||
          !sameTurn ||
          (own(data, "status") && data.status !== "completed") ||
          (own(data, "reason") && data.reason !== "completed")
        )
          return [];
        continue;
      }
      if (raw.type === "event_msg" && data.type === "task_complete") return [];
      if (raw.type !== "response_item" || data.type !== "message") continue;
      if (
        id !== undefined &&
        !sameTurn &&
        ["user", "assistant"].some((role) => role === data.role)
      )
        return [];
      if (data.role === "user") {
        if (
          (data.source === undefined || object(data.source)?.kind === "user") &&
          textPart(data.content, "input_text")
        )
          user.add(row.version);
      }
      if (
        data.role === "assistant" &&
        data.phase === "final_answer" &&
        textPart(data.content, "output_text")
      )
        assistant.add(row.version);
    } else if (harness === "dsh") {
      const data = object(raw.data);
      if (
        typeof raw.seq !== "number" ||
        !Number.isSafeInteger(raw.seq) ||
        raw.seq < 0 ||
        (lastSeq !== undefined && raw.seq !== lastSeq + 1) ||
        !data
      )
        return [];
      lastSeq = raw.seq;
      if (
        typeof raw.type !== "string" ||
        (own(raw, "ignorable") && raw.ignorable !== true)
      )
        return [];
      const id = data.turn;
      const sameTurn =
        typeof id === "number" &&
        Number.isSafeInteger(id) &&
        id > 0 &&
        turnKey(id) === turn;
      if (
        raw.type === "working-directory/change" ||
        raw.type === "session/end-seed" ||
        (own(data, "turn") && !sameTurn)
      )
        return [];
      if (index === 0) {
        if (raw.type !== "turn/start" || !sameTurn) return [];
      } else if (index === rows.length - 1) {
        if (
          raw.type !== "turn/end" ||
          !sameTurn ||
          object(data.reason)?.kind !== "completed"
        )
          return [];
      } else if (
        raw.type === "turn/start" ||
        raw.type === "turn/end" ||
        raw.type === "session"
      )
        return [];
      else if (
        raw.type === "user/message" &&
        data.role === "user" &&
        object(data.source)?.kind === "user" &&
        raw.surfaceOp === "append" &&
        textPart(data.content, "text")
      )
        user.add(row.version);
      else if (
        raw.type === "assistant/message" &&
        sameTurn &&
        raw.surfaceOp === "append"
      ) {
        if (data.interrupted === true) continue;
        const message = object(data.message);
        const origin = object(message?.source);
        if (
          message?.role === "assistant" &&
          origin?.kind === "model" &&
          typeof origin.provider === "string" &&
          origin.provider.trim() &&
          typeof origin.model === "string" &&
          origin.model.trim() &&
          textPart(message.content, "text")
        )
          assistant.add(row.version);
      } else if (
        raw.type !== "user/message" &&
        raw.type !== "assistant/message" &&
        !dshContextEvents.has(raw.type) &&
        raw.ignorable !== true
      )
        return [];
    } else return [];
  }
  // Multiple direct prompts or final replies without an authoritative order
  // are left for review. Mirrors and non-final messages do not count.
  return user.size === 1 && assistant.size === 1 ? [...user, ...assistant] : [];
}
