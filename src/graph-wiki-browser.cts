/* Browser view for the existing scoped query endpoints. */
type Citation = {
  id: string;
  revision: string;
  source: { harness: string; instance: string; session: string };
};
type ViewRow = {
  id: string;
  kind: string;
  text: string;
  time: string;
  label: string;
  citation: Citation;
};
type View = {
  rows: ViewRow[];
  edges: { from: string; to: string }[];
  truncated: boolean;
  missingSources: number;
};
type Graph = {
  destroy(): void;
  on(
    event: string,
    selector: string,
    handler: (event: { target: { id(): string } }) => void,
  ): void;
};
type Timeline = {
  destroy(): void;
  on(event: string, handler: (props: { items: string[] }) => void): void;
};
declare const cytoscape: (options: object) => Graph;
declare const vis: {
  Timeline: new (
    element: HTMLElement,
    data: unknown,
    options: object,
  ) => Timeline;
  DataSet: new (items: object[]) => unknown;
};
function element(selector: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error("Missing view element");
  return el;
}
async function request(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<unknown>;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid view response");
  return value as Record<string, unknown>;
}
function field(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid view response");
  return value;
}
function parseView(value: unknown): View {
  const v = record(value);
  if (
    !Array.isArray(v.rows) ||
    !Array.isArray(v.edges) ||
    typeof v.truncated !== "boolean" ||
    typeof v.missingSources !== "number"
  )
    throw new Error("Invalid view response");
  const rows = (v.rows as unknown[]).map((raw) => {
    const r = record(raw),
      c = record(r.citation),
      s = record(c.source);
    return {
      id: field(r.id),
      kind: field(r.kind),
      text: field(r.text),
      time: field(r.time),
      label: field(r.label),
      citation: {
        id: field(c.id),
        revision: field(c.revision),
        source: {
          harness: field(s.harness),
          instance: field(s.instance),
          session: field(s.session),
        },
      },
    };
  });
  return {
    rows,
    edges: (v.edges as unknown[]).map((raw) => {
      const e = record(raw);
      return { from: field(e.from), to: field(e.to) };
    }),
    truncated: v.truncated,
    missingSources: v.missingSources as number,
  };
}
let graph: Graph | undefined, timeline: Timeline | undefined;
function clearGraph(): void {
  graph?.destroy();
  timeline?.destroy();
  graph = undefined;
  timeline = undefined;
  element("#graph-coverage").textContent = "";
}
async function showGraph(
  params: string,
  openEvidence: (citation: Citation) => Promise<void>,
  onError: (error: unknown) => void,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const view = parseView(await request("/api/graph?" + params));
  if (!isCurrent()) return;
  const byId = new Map(view.rows.map((row) => [row.id, row]));
  graph?.destroy();
  timeline?.destroy();
  element("#graph-coverage").textContent =
    (view.missingSources
      ? `有 ${view.missingSources} 条记录缺少完整来源，未显示。`
      : "") +
    (view.truncated
      ? "仅显示前 100 条审核记录，结果已截断。"
      : "显示此筛选范围内的审核记录。");
  const colors: Record<string, string> = {
    已确定: "#277852",
    待决定: "#ac6a00",
    待核实: "#9d4a44",
    已替代: "#697785",
    已取消: "#773f64",
    未完任务: "#346ba0",
    已完成任务: "#56866a",
  };
  graph = cytoscape({
    container: element("#graph"),
    elements: [
      ...view.rows.map((r) => ({
        data: {
          id: r.id,
          label: [r.label, r.text || r.kind].filter(Boolean).join(" · "),
          color: colors[r.label] || "#697785",
        },
      })),
      ...view.edges.map((e, i) => ({
        data: { id: "edge-" + i, source: e.from, target: e.to },
      })),
    ],
    style: [
      {
        selector: "node",
        style: {
          label: "data(label)",
          "text-wrap": "wrap",
          "text-max-width": "120px",
          "background-color": "data(color)",
          color: "#17283c",
        },
      },
      {
        selector: "edge",
        style: {
          "curve-style": "bezier",
          "target-arrow-shape": "triangle",
          "line-color": "#8595a4",
          "target-arrow-color": "#8595a4",
        },
      },
    ],
    layout: { name: "grid" },
  });
  graph.on("tap", "node", (event) => {
    const row = byId.get(event.target.id());
    if (row) void openEvidence(row.citation).catch(onError);
  });
  const classes: Record<string, string> = {
    已确定: "status-confirmed",
    待决定: "status-proposed",
    待核实: "status-uncertain",
    已替代: "status-superseded",
    已取消: "status-cancelled",
    未完任务: "status-task",
    已完成任务: "status-completed",
  };
  const items = view.rows
    .filter((r) => r.time && Number.isFinite(Date.parse(r.time)))
    .map((r) => {
      const content = document.createElement("span");
      content.textContent = [r.label, r.text || r.kind]
        .filter(Boolean)
        .join(" · ");
      return {
        id: r.id,
        content,
        start: r.time,
        className: classes[r.label] || "status-unknown",
      };
    });
  timeline = new vis.Timeline(
    element("#visual-timeline"),
    new vis.DataSet(items),
    { height: "220px" },
  );
  timeline.on("select", (props) => {
    const row = byId.get(props.items[0] || "");
    if (row) void openEvidence(row.citation).catch(onError);
  });
}
function exactCitation(value: unknown): Citation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const c = value as Record<string, unknown>;
  if (!c.source || typeof c.source !== "object" || Array.isArray(c.source))
    return;
  const source = c.source as Record<string, unknown>;
  if (
    ![c.id, c.revision, source.harness, source.instance, source.session].every(
      (part) => typeof part === "string" && part.trim(),
    )
  )
    return;
  return {
    id: c.id as string,
    revision: c.revision as string,
    source: {
      harness: source.harness as string,
      instance: source.instance as string,
      session: source.session as string,
    },
  };
}
const taskStateLabels = new Map([
  ["unmarked", "未标记结束"],
  ["open", "未完成"],
  ["paused", "已暂停"],
  ["completed", "已完成"],
  ["cancelled", "已取消"],
  ["conflict", "状态冲突"],
]);
function appendReviewedDetails(
  container: HTMLElement,
  row: unknown,
  openEvidence: (citation: Citation) => Promise<void>,
  onError: (error: unknown) => void,
): void {
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const text = (value: unknown): string =>
    typeof value === "string" ? value : "";
  const addDetail = (value: string, label?: string, citation?: Citation) => {
    const p = document.createElement("p");
    p.textContent = value;
    if (citation && label) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.onclick = () => void openEvidence(citation).catch(onError);
      p.append(" ", button);
    }
    container.append(p);
  };
  const entry = object(row);
  if (!entry) return;
  if (Array.isArray(entry.annotations)) {
    for (const raw of entry.annotations as unknown[]) {
      const note = object(raw);
      if (!note) continue;
      if (note.kind === "correction") {
        const citation = exactCitation(note.evidence);
        const unavailable = citation
          ? ""
          : note.evidence == null
            ? "未附来源证据"
            : "来源引用不完整";
        addDetail(
          ["纠正", text(note.text), unavailable].filter(Boolean).join(" · "),
          "查看纠正证据",
          citation,
        );
      } else if (note.kind === "annotation")
        addDetail(`批注 · ${text(note.text)}`);
    }
  }
  if (entry.kind !== "todo") return;
  const task = object(entry.task_state);
  if (!task) return;
  addDetail(
    `任务状态 · ${text(task.label) || taskStateLabels.get(text(task.state)) || "未知"}`,
  );
  if (!Array.isArray(task.heads)) return;
  for (const raw of task.heads as unknown[]) {
    const head = object(raw);
    if (!head) continue;
    const kind = head.evidenceKind;
    const label =
      kind === "source"
        ? "来源证据"
        : kind === "operator"
          ? "操作员声明"
          : "证据类型未知";
    const citation =
      kind === "source" ? exactCitation(head.evidence) : undefined;
    const unavailable =
      kind === "source" && !citation
        ? head.evidence == null
          ? "未附来源证据"
          : "来源引用不完整"
        : "";
    addDetail(
      [
        taskStateLabels.get(text(head.state)) || "状态未知",
        text(head.text),
        label,
        unavailable,
      ]
        .filter(Boolean)
        .join(" · "),
      "查看状态证据",
      citation,
    );
  }
}
let overviewGeneration = 0;
async function projectOverview(
  openEvidence: (citation: Citation) => Promise<void>,
  onError: (error: unknown) => void,
): Promise<void> {
  const generation = ++overviewGeneration;
  const [rawDecisions, rawTasks] = await Promise.all([
    request("/api/current"),
    request("/api/tasks"),
  ]);
  if (generation !== overviewGeneration) return;
  if (!Array.isArray(rawDecisions)) throw new Error("Invalid decisions");
  const tasks = record(rawTasks).tasks;
  if (!Array.isArray(tasks)) throw new Error("Invalid tasks");
  const d = element("#project-decisions"),
    t = element("#project-tasks");
  d.replaceChildren();
  t.replaceChildren();
  for (const raw of rawDecisions as unknown[]) {
    const row = record(raw),
      p = document.createElement("p");
    p.textContent = [row.topic, row.label, row.text || row.reason]
      .filter((v) => typeof v === "string")
      .join(" · ");
    d.append(p);
    const citation = exactCitation(row.effectiveCitation || row.citation);
    if (citation) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "查看决定证据";
      button.setAttribute(
        "aria-label",
        `查看决定证据：${String(row.topic || row.text || "当前决定")}`,
      );
      button.onclick = () => void openEvidence(citation).catch(onError);
      d.append(button);
    }
  }
  for (const raw of tasks as unknown[]) {
    const row = record(raw),
      p = document.createElement("p");
    p.textContent = [
      row.text,
      typeof row.label === "string"
        ? `状态：${row.label}`
        : `状态：${String(row.state || "未知")}`,
      typeof row.next_step === "string" && row.next_step
        ? `下一步：${row.next_step}`
        : "下一步：未提供",
    ]
      .filter((v) => typeof v === "string")
      .join(" · ");
    t.append(p);
    const citation = exactCitation(row.target);
    if (citation) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "查看任务证据";
      button.setAttribute(
        "aria-label",
        `查看任务证据：${String(row.text || "未完任务")}`,
      );
      button.onclick = () => void openEvidence(citation).catch(onError);
      t.append(button);
    }
  }
}
function setup(
  onError: (error: unknown) => void,
  openEvidence: (citation: Citation) => Promise<void>,
): void {
  for (const [id, label] of [
    ["project-entry", "项目工作页"],
    ["topic-entry", "知识主题页"],
  ] as const)
    element("#" + id).onclick = () => {
      const project = id === "project-entry";
      element("#entry-label").textContent = label;
      element("#project-overview").hidden = !project;
      element("#topic-intro").hidden = project;
      if (project) void projectOverview(openEvidence, onError).catch(onError);
      else element("#search input").focus();
    };
  void projectOverview(openEvidence, onError).catch(onError);
}
(
  globalThis as typeof globalThis & {
    graphWiki: {
      setup: typeof setup;
      showGraph: typeof showGraph;
      clearGraph: typeof clearGraph;
      appendReviewedDetails: typeof appendReviewedDetails;
    };
  }
).graphWiki = { setup, showGraph, clearGraph, appendReviewedDetails };
