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
async function showGraph(
  params: string,
  openEvidence: (citation: Citation) => Promise<void>,
  onError: (error: unknown) => void,
): Promise<void> {
  const view = parseView(await request("/api/graph?" + params));
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
async function projectOverview(): Promise<void> {
  const [rawDecisions, rawTasks] = await Promise.all([
    request("/api/current"),
    request("/api/tasks"),
  ]);
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
  }
  for (const raw of tasks as unknown[]) {
    const row = record(raw),
      p = document.createElement("p");
    p.textContent = ["未完任务", row.text, row.state]
      .filter((v) => typeof v === "string")
      .join(" · ");
    t.append(p);
  }
}
function setup(onError: (error: unknown) => void): void {
  for (const [id, label] of [
    ["project-entry", "项目工作页"],
    ["topic-entry", "知识主题页"],
  ] as const)
    element("#" + id).onclick = () => {
      const project = id === "project-entry";
      element("#entry-label").textContent = label;
      element("#project-overview").hidden = !project;
      element("#topic-intro").hidden = project;
      if (project) void projectOverview().catch(onError);
      else element("#search input").focus();
    };
  void projectOverview().catch(onError);
}
(
  globalThis as typeof globalThis & {
    graphWiki: { setup: typeof setup; showGraph: typeof showGraph };
  }
).graphWiki = { setup, showGraph };
