/** "lmstudio::qwen3-8b" → "qwen3-8b · lmstudio"; Ollama names are shown as-is. */
export function modelLabel(ref: string): string {
  const i = ref.indexOf('::');
  return i < 0 ? ref : `${ref.slice(i + 2)} · ${ref.slice(0, i)}`;
}
