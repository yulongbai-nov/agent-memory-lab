/** Validate query rows before projecting them to a read-only graph view. */
type Citation = {
  id: string;
  revision: string;
  source: { harness: string; instance: string; session: string };
};
type Row = {
  id: string;
  kind: string;
  text: string;
  time: string;
  citation: Citation;
  label: string;
  revises: string[];
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid graph row");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value)
    throw new Error("Invalid graph value");
  return value;
}
function citation(value: unknown): Citation {
  const c = object(value),
    s = object(c.source);
  return {
    id: string(c.id),
    revision: string(c.revision),
    source: {
      harness: string(s.harness),
      instance: string(s.instance),
      session: string(s.session),
    },
  };
}
export function graphWikiView(
  input: unknown,
  current: unknown,
  filtered: unknown = input,
): {
  rows: Row[];
  edges: { from: string; to: string }[];
  truncated: boolean;
  missingSources: number;
} {
  if (!Array.isArray(input)) throw new Error("Invalid timeline");
  const rows: Row[] = [];
  let missingSources = 0;
  for (const raw of input as unknown[]) {
    const r = object(raw);
    if (typeof r.review_id !== "string" || !r.review_id) continue;
    const refs = Array.isArray(r.revises)
      ? r.revises
      : typeof r.revises === "string" && r.revises
        ? [r.revises]
        : [];
    if (!refs.every((v: unknown) => typeof v === "string" && v.length > 0))
      throw new Error("Invalid revisions");
    const c = object(r.citation);
    if (!c.source) {
      missingSources++;
      continue;
    }
    rows.push({
      id: r.review_id,
      kind: string(r.kind),
      text: typeof r.text === "string" ? r.text : "",
      time: typeof r.time === "string" ? r.time : "",
      citation: citation(r.citation),
      label:
        r.kind === "todo"
          ? r.task_state && typeof object(r.task_state).label === "string"
            ? "任务 · " + object(r.task_state).label
            : "任务 · 状态未知"
          : typeof r.label === "string"
            ? r.label
            : "",
      revises: refs as string[],
    });
    if (Array.isArray(r.annotations)) {
      for (const rawNote of r.annotations as unknown[]) {
        const note = object(rawNote);
        if (note.kind !== "correction" || !note.evidence) continue;
        rows.push({
          id: string(note.id),
          kind: "correction",
          text: typeof note.text === "string" ? note.text : "",
          time: "",
          citation: citation(note.evidence),
          label: "纠正",
          revises: [r.review_id],
        });
      }
    }
  }
  if (!Array.isArray(current)) throw new Error("Invalid current decisions");
  const heads = (current as unknown[])
    .map(object)
    .filter((c) => c.label === "已确定" && typeof c.review_id === "string");
  const byId = new Map(rows.map((r) => [r.id, r]));
  const confirmed = new Set(
    rows.filter((r) => r.label === "已确定").map((r) => r.id),
  );
  for (const head of heads) {
    let node = byId.get(head.review_id as string);
    const visited = new Set<string>();
    while (
      node &&
      node.kind === "change" &&
      confirmed.has(node.id) &&
      !visited.has(node.id)
    ) {
      visited.add(node.id);
      const prior: Row | undefined =
        node.revises.length === 1 ? byId.get(node.revises[0] || "") : undefined;
      if (!prior || !confirmed.has(prior.id)) break;
      prior.label = "已替代";
      node = prior;
    }
  }
  if (!Array.isArray(filtered)) throw new Error("Invalid filtered timeline");
  const selected = new Set(
    (filtered as unknown[])
      .map(object)
      .map((r) => r.review_id)
      .filter((id): id is string => typeof id === "string"),
  );
  const selectedRows = rows.filter(
    (r) =>
      selected.has(r.id) ||
      (r.kind === "correction" && r.revises.some((id) => selected.has(id))),
  );
  const truncated = selectedRows.length > 100;
  const visible = selectedRows.slice(0, 100);
  const ids = new Set(visible.map((r) => r.id));
  const edges = visible.flatMap((r) =>
    r.revises.filter((id) => ids.has(id)).map((id) => ({ from: r.id, to: id })),
  );
  return { rows: visible, edges, truncated, missingSources };
}
