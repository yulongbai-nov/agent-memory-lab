"use strict";
// CLI-only, opt-in projection snippets. Original bytes are never opened here.
import { matchesTime } from "./query-time.cjs";
type Scope = { owner: string; project: string };
type Source = {
  harness: string;
  instance: string;
  session: string;
  [key: string]: unknown;
};
type Citation = { id: string; revision: string; source: Source };
type Original = { availability?: unknown };
type Item = {
  id: string;
  kind?: string;
  role?: string;
  text?: string;
  title?: string;
  time?: string;
  timestamp?: string;
  valid_time?: string;
  created_at?: string;
  metadata?: { topic?: unknown; next_step?: unknown; original?: Original };
  original?: Original;
};
type RecordRow = {
  scope: Scope;
  source: Source;
  versionId: string;
  item: Item;
};
type Annotation = {
  kind: string;
  topic?: string;
  text?: string;
  target?: Citation;
};
type Args = { keyword?: string; from?: string; to?: string };
type Topic = {
  topic: string;
  count: number;
  latest: string;
  citations: Citation[];
};
type Result = { topics: Topic[]; coverage: unknown };
type Archive = {
  listItems: (scope: Scope, filters: Args) => Promise<RecordRow[]>;
  listAnnotations: (scope: Scope) => Promise<Annotation[]>;
  getItem: (
    args: Scope & { id: string; revision: string; source?: Source },
  ) => Promise<RecordRow | null>;
};
type Entry = { row: RecordRow; direct: boolean };
type Group = { labels: Set<string>; entries: Entry[] };

const inScope = (r: RecordRow, s: Scope) =>
  r.scope?.owner === s.owner && r.scope?.project === s.project;
const validSource = (s: Source) =>
  s &&
  [s.harness, s.instance, s.session].every(
    (x) => typeof x === "string" && x.length > 0,
  );
const stamp = (i: Item) =>
  i.timestamp || i.time || i.valid_time || i.created_at || "";
const groupName = (r: RecordRow) =>
  String(
    r.item.metadata?.topic ||
      [r.source.harness, r.source.instance, r.source.session].join(" / "),
  );
const logicalKey = (r: RecordRow) =>
  JSON.stringify([
    r.source.harness,
    r.source.instance,
    r.source.session,
    r.item.id,
  ]);
const versionKey = (r: RecordRow) => JSON.stringify([r.item.id, r.versionId]);
const cite = (r: RecordRow): Citation => ({
  id: r.item.id,
  revision: r.versionId,
  source: r.source,
});
const availability = (r: RecordRow) => {
  const v = (r.item.metadata?.original || r.item.original)?.availability;
  return v === "source-only" || v === undefined
    ? "source-only"
    : v === "archived"
      ? "archived-recorded"
      : "unknown";
};
function matches(r: RecordRow, args: Args) {
  const time = stamp(r.item);
  if (!matchesTime(time, args)) return false;
  const q = String(args.keyword || "")
    .toLocaleLowerCase()
    .trim();
  return (
    !q ||
    [
      r.item.title,
      r.item.text,
      r.item.metadata?.topic,
      r.item.metadata?.next_step,
    ].some((v) => typeof v === "string" && v.toLocaleLowerCase().includes(q))
  );
}
function wellFormed(s: string) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(++i);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}
function excerpt(text: string, keyword: string) {
  // Keep the excerpt literal. If the archived projection still contains an
  // obvious sensitive pattern, omit it rather than rewriting the evidence.
  if (
    !wellFormed(text) ||
    /-----BEGIN [^-\r\n]*PRIVATE KEY-----|\b(?:sk|api|token|secret|key)[-_][A-Za-z0-9_-]{12,}\b|\bBearer\s+[A-Za-z0-9._~+/-]+|\b(?:password|passwd|token|api[_-]?key|secret|authorization|credential)\s*[:=]\s*[^\s,;]+|(?:\/Users\/|\/home\/|\/private\/|[A-Za-z]:\\Users\\)[^\s"']+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(
      text,
    )
  )
    return null;
  const chars = Array.from(text),
    q = keyword.toLocaleLowerCase().trim(),
    pos = q ? text.toLocaleLowerCase().indexOf(q) : 0;
  if (pos < 0) return null;
  let folded = 0,
    index = 0;
  while (index < chars.length && folded < pos) {
    const width = chars[index]!.toLocaleLowerCase().length;
    if (folded + width > pos) break;
    folded += width;
    index++;
  }
  let start = index,
    prior = 0;
  while (start > 0) {
    const n = Buffer.byteLength(chars[start - 1]!);
    if (prior + n > 60) break;
    prior += n;
    start--;
  }
  function window(from: number) {
    let end = from,
      size = 0;
    while (end < chars.length) {
      const n = Buffer.byteLength(chars[end]!);
      if (size + n > 240) break;
      size += n;
      end++;
    }
    return {
      text: chars.slice(from, end).join(""),
      truncated: from > 0 || end < chars.length,
    };
  }
  let out = window(start);
  if (q && !out.text.toLocaleLowerCase().includes(q)) {
    start = index;
    out = window(start);
    if (!out.text.toLocaleLowerCase().includes(q)) return null;
  }
  return out;
}
function add(
  groups: Map<string, Group>,
  name: string,
  label: string,
  row: RecordRow,
  direct: boolean,
) {
  const g = groups.get(name) || { labels: new Set<string>(), entries: [] };
  g.labels.add(label);
  g.entries.push({ row, direct });
  groups.set(name, g);
}
async function addFindPreviews(
  archive: Archive,
  scope: Scope,
  args: Args,
  base: Result,
) {
  const raw = await archive.listItems(scope, { ...args }),
    list = raw.filter(
      (r) => inScope(r, scope) && validSource(r.source) && matches(r, args),
    );
  const groups = new Map<string, Group>();
  for (const row of list)
    add(
      groups,
      groupName(row),
      row.item.metadata?.topic ? "命名话题" : "来源会话",
      row,
      true,
    );
  const native = new Map(list.map((row) => [versionKey(row), row])),
    q = String(args.keyword || "")
      .toLocaleLowerCase()
      .trim();
  for (const a of await archive.listAnnotations(scope)) {
    if (
      !a.target ||
      !a.topic ||
      !["decision", "change", "todo"].includes(a.kind)
    )
      continue;
    const key = JSON.stringify([a.target.id, a.target.revision]);
    let row = native.get(key);
    const direct = Boolean(row);
    if (
      !row &&
      q &&
      [a.topic, a.text].some(
        (v) => typeof v === "string" && v.toLocaleLowerCase().includes(q),
      )
    ) {
      const fetched = await archive.getItem({
        ...scope,
        id: a.target.id,
        revision: a.target.revision,
        ...(a.target.source ? { source: a.target.source } : {}),
      });
      if (
        fetched &&
        inScope(fetched, scope) &&
        validSource(fetched.source) &&
        fetched.item.id === a.target.id &&
        fetched.versionId === a.target.revision &&
        matches(fetched, {
          ...(args.from ? { from: args.from } : {}),
          ...(args.to ? { to: args.to } : {}),
        })
      )
        row = fetched;
    }
    if (row && (!direct || a.topic !== groupName(row)))
      add(groups, a.topic, "命名话题", row, direct);
  }
  return {
    ...base,
    topics: base.topics.map((topic) => {
      const group = groups.get(topic.topic),
        entries = group?.entries || [],
        unique = new Map<string, Entry[]>();
      for (const entry of entries) {
        const key = logicalKey(entry.row);
        if (!unique.has(key)) unique.set(key, []);
        unique.get(key)!.push(entry);
      }
      let previewRow: RecordRow | undefined,
        previewClip: ReturnType<typeof excerpt> = null;
      for (const entry of entries) {
        const r = entry.row;
        if (
          !entry.direct ||
          r.item.kind !== "message" ||
          !["user", "assistant"].includes(r.item.role || "") ||
          typeof r.item.text !== "string" ||
          !r.item.text ||
          (q && !r.item.text.toLocaleLowerCase().includes(q))
        )
          continue;
        const e = excerpt(r.item.text, q);
        if (e?.text) {
          previewRow = r;
          previewClip = e;
          break;
        }
      }
      if (previewRow) {
        const same = unique.get(logicalKey(previewRow)) || [];
        const preferred = same.find(
          (e) =>
            e.direct &&
            e.row.item.text === previewRow!.item.text &&
            availability(e.row) === "archived-recorded",
        );
        if (preferred) previewRow = preferred.row;
      }
      const keys = [...unique.keys()];
      if (previewRow) {
        const k = logicalKey(previewRow),
          at = keys.indexOf(k);
        if (at > 0) {
          keys.splice(at, 1);
          keys.unshift(k);
        }
      }
      const previewCitations = keys.slice(0, 3).map((key) => {
        const candidates = unique.get(key)!;
        let chosen = candidates[0]!.row;
        if (previewRow && key === logicalKey(previewRow)) chosen = previewRow;
        else {
          const preferred = candidates.find(
            (e) =>
              e.row.item.text === chosen.item.text &&
              availability(e.row) === "archived-recorded",
          );
          if (preferred) chosen = preferred.row;
        }
        return { ...cite(chosen), originalAvailability: availability(chosen) };
      });
      const preview =
        previewRow && previewClip
          ? {
              label: "归档消息",
              selection: q
                ? "关键词命中片段"
                : args.from || args.to
                  ? "时间范围内片段"
                  : "范围内片段",
              ...previewClip,
              citation: cite(previewRow),
              originalAvailability: availability(previewRow),
            }
          : null;
      return {
        ...topic,
        groupLabels: [...(group?.labels || [])].sort(),
        matchedItems: unique.size,
        previewCitations,
        preview,
      };
    }),
  };
}
module.exports = { addFindPreviews, excerpt };
