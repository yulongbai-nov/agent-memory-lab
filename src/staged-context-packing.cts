type Source = {
  ref: string;
  text: string;
  excerpt?: { startUtf16: number; endUtf16: number };
};

type PackingGap = "missing-required-evidence" | "required-evidence-over-budget";

const excerptBytes = 320;
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const words = (text: string) =>
  text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

function excerpt<T extends Source>(source: T, query: string): T | undefined {
  const needle = new Set(words(query).filter((word) => word.length > 2));
  let best: { text: string; startUtf16: number; score: number } | undefined;
  for (const part of source.text.matchAll(/[^.!?。！？\n]+[.!?。！？]?/gu)) {
    const text = part[0];
    if (bytes(text) > excerptBytes) continue;
    const score = new Set(words(text).filter((word) => needle.has(word))).size;
    if (score > (best?.score ?? 0))
      best = { text, startUtf16: part.index, score };
  }
  return (
    best && {
      ...source,
      text: best.text,
      excerpt: {
        startUtf16: best.startUtf16,
        endUtf16: best.startUtf16 + best.text.length,
      },
    }
  );
}

export function packStaged<T extends Source, Context>(input: {
  ranked: readonly T[];
  requiredRefs: readonly string[];
  question: string;
  limits: { topK: number; contextBytes: number };
  render: (sources: T[]) => Context;
}): { context: Context; gap: PackingGap | null } {
  const { ranked, requiredRefs, question, limits, render } = input;
  const byRef = new Map(ranked.map((source) => [source.ref, source]));
  if (byRef.size !== ranked.length)
    throw new Error("Duplicate ranked reference");
  const required = new Set(requiredRefs);
  const selected: T[] = [];
  const fits = (rows: T[]) =>
    rows.length <= limits.topK &&
    bytes(JSON.stringify(render(rows))) <= limits.contextBytes;
  for (const ref of required) {
    const source = byRef.get(ref);
    if (!source)
      return { context: render([]), gap: "missing-required-evidence" };
    selected.push(source);
  }
  if (!fits(selected))
    return { context: render([]), gap: "required-evidence-over-budget" };
  if (required.size) return { context: render(selected), gap: null };
  // Reviewed evidence is atomic. Optional context can start with excerpts.
  for (const source of byRef.values()) {
    if (selected.length === limits.topK) break;
    const preview = excerpt(source, question);
    const detail =
      preview && bytes(preview.text) < bytes(source.text) ? preview : source;
    if (fits([...selected, detail])) selected.push(detail);
  }
  for (const [index, source] of selected.entries()) {
    if (!source.excerpt) continue;
    const full = byRef.get(source.ref);
    if (!full) throw new Error("Missing ranked source");
    const expanded = [...selected];
    expanded[index] = full;
    if (fits(expanded)) selected[index] = full;
  }
  return { context: render(selected), gap: null };
}
