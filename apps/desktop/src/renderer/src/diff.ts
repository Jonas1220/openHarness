export type DiffLine = { type: 'same' | 'add' | 'del'; text: string };

/**
 * Line diff via longest common subsequence. Good enough for reviewing agent edits;
 * very large files fall back to "everything removed / everything added".
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // Trim common prefix/suffix first: edits are usually small and local.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const head = a.slice(0, start).map((text) => ({ type: 'same' as const, text }));
  const tail = a.slice(endA).map((text) => ({ type: 'same' as const, text }));

  if (midA.length * midB.length > 4_000_000) {
    return [...head, ...midA.map((text) => ({ type: 'del' as const, text })), ...midB.map((text) => ({ type: 'add' as const, text })), ...tail];
  }
  const n = midA.length;
  const m = midB.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = midA[i] === midB[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const mid: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      mid.push({ type: 'same', text: midA[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) mid.push({ type: 'del', text: midA[i++]! });
    else mid.push({ type: 'add', text: midB[j++]! });
  }
  while (i < n) mid.push({ type: 'del', text: midA[i++]! });
  while (j < m) mid.push({ type: 'add', text: midB[j++]! });
  return [...head, ...mid, ...tail];
}

/** Collapse long runs of unchanged lines, keeping `context` lines around each change. */
export function hunks(lines: DiffLine[], context = 3): (DiffLine | { type: 'gap'; count: number })[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.type !== 'same') for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: (DiffLine | { type: 'gap'; count: number })[] = [];
  let gap = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (gap) out.push({ type: 'gap', count: gap });
      gap = 0;
      out.push(l);
    } else gap++;
  });
  if (gap) out.push({ type: 'gap', count: gap });
  return out;
}
