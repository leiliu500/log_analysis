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

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Ensure a message's root element is closed (appends `</root>` if missing). */
function closeRoot(msg: string): string {
  const m = msg.replace(/<\?[\s\S]*?\?>/, '').match(/<((?:[\w.-]+:)?[A-Za-z_][\w.-]*)[\s>]/);
  if (!m) return msg;
  const close = `</${m[1]}>`;
  return msg.includes(close) ? msg : `${msg}\n${close}`;
}

/**
 * Split a blob that may contain several concatenated XML documents into
 * individual message strings.
 *
 * Splits on each root *opening* tag (matched by LOCAL name so differing
 * namespace prefixes — ns2: vs NS1: — are handled) rather than the closing tag,
 * because pasted samples are often truncated at `</payload>` with no root close.
 * Any `<?xml?>` prologue is folded into its message, and unclosed roots are
 * closed so the emitted logs are well-formed.
 */
export function splitMessages(blob: string): string[] {
  const trimmed = blob.trim();
  if (!trimmed) return [];
  // Root LOCAL name from the first opening tag (skip any <?xml?> prologue).
  const first = trimmed.replace(/<\?[\s\S]*?\?>/, '').match(/<(?:[\w.-]+:)?([A-Za-z_][\w.-]*)[\s>]/);
  if (!first) return [trimmed]; // not XML — treat as one message
  const local = escapeRe(first[1]!);
  const boundary = new RegExp(`(?=<(?:[\\w.-]+:)?${local}[\\s>])`, 'g');
  const parts = trimmed
    .split(boundary)
    // A message's <?xml?> prologue trails the previous chunk after the split;
    // drop it (declarations are optional for our log payloads).
    .map((p) => p.replace(/<\?xml[^>]*\?>\s*$/i, '').trim())
    .filter((p) => p.length > 0);
  return (parts.length ? parts : [trimmed]).map(closeRoot);
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
