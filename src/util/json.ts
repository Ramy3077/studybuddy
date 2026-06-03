/**
 * Parse JSON that an LLM may have wrapped in prose or ```json fences.
 * Extracts the first balanced {...} or [...] block and parses it.
 */
export function parseJsonLoose<T = unknown>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : raw;
  const trimmed = candidate.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // Find first { or [ and matching close.
    const start = trimmed.search(/[{[]/);
    if (start === -1) throw new Error('No JSON object/array found in model output');
    const open = trimmed[start]!;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i]!;
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          return JSON.parse(trimmed.slice(start, i + 1)) as T;
        }
      }
    }
    throw new Error('Unbalanced JSON in model output');
  }
}
