/**
 * Minimal, dependency-free XML helpers for the simulator. We operate on the raw
 * string (find/replace specific elements) rather than parse+reserialize, so the
 * original formatting, namespaces and payload are preserved exactly.
 */

/** Matches an element `<tag>value</tag>`, tolerating an optional ns prefix. */
function tagRe(tag: string): RegExp {
  return new RegExp(`<((?:[\\w.-]+:)?${tag})>([\\s\\S]*?)</\\1>`, 'i');
}

export function getTag(xml: string, tag: string): string | undefined {
  const m = xml.match(tagRe(tag));
  return m ? m[2]!.trim() : undefined;
}

/** Replace the value of `<tag>` (first occurrence). No-op if the tag is absent. */
export function setTag(xml: string, tag: string, value: string): string {
  return xml.replace(tagRe(tag), (_full, t: string) => `<${t}>${value}</${t}>`);
}

export function messageType(xml: string): string {
  return (getTag(xml, 'messageType') ?? '').toUpperCase();
}

/**
 * Split a blob that may contain several concatenated XML documents into
 * individual message strings. Splits on the root element's closing tag.
 */
export function splitMessages(blob: string): string[] {
  const trimmed = blob.trim();
  if (!trimmed) return [];
  // First real element name (skip <?xml ...?> and comments).
  const rootMatch = trimmed.replace(/<\?[\s\S]*?\?>/g, '').match(/<([A-Za-z_][\w.:-]*)[\s>]/);
  if (!rootMatch) return [trimmed]; // not XML — treat as one message
  const root = rootMatch[1]!;
  const close = `</${root}>`;
  if (!trimmed.includes(close)) return [trimmed];
  return trimmed
    .split(close)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => p + close);
}

/**
 * Produce a new id by incrementing the last run of digits by `n`. Preserves the
 * surrounding format and zero-padding. Falls back to `${id}-${n}` if no digits.
 * `bumpId(id, 0)` returns the id unchanged.
 */
export function bumpId(id: string, n: number): string {
  if (n === 0) return id;
  const m = id.match(/\d+(?!.*\d)/s);
  if (!m || m.index === undefined) return `${id}-${n}`;
  const digits = m[0];
  const next = (BigInt(digits) + BigInt(n)).toString();
  const padded = next.length < digits.length ? next.padStart(digits.length, '0') : next;
  return id.slice(0, m.index) + padded + id.slice(m.index + digits.length);
}
