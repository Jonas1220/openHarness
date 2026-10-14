/** Parse simple `key: value` YAML frontmatter, as used by commands and SKILL.md files. */
export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) data[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, '').trim();
  }
  return { data, body: text.slice(m[0].length) };
}
