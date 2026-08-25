// Custom, dependency-free XML reader/writer using ONLY native Web APIs — DOMParser
// to parse and a string builder to serialize. CSP-clean (no eval/new Function, no
// Worker), zero dependencies. Import maps a repeating "record" element to one
// document each, producing the same { docs, columns, warnings, error } shape as
// csv.js/xlsx.js so the existing import tail is reused.
import { inferValue } from './csv.js';
import { getEjsonType, formatEjsonValue } from './displayValue.js';

const local = (name: string) => {
  const i = name.indexOf(':');
  return i >= 0 ? name.slice(i + 1) : name;
};
const childElements = (el: Element) => [...el.children];

function parseDoc(str: string): Document {
  const doc = new DOMParser().parseFromString(str, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error((err.textContent || 'Malformed XML').trim().split('\n')[0]);
  return doc;
}

// Find the element whose direct children most repeat a single tag; those repeated
// children are the records. Returns { records, candidates, selectedKey }.
type Group = { key: string; tag: string; count: number; els: Element[] };

export function detectRecords(doc: Document, recordKey?: string | null) {
  const root = doc.documentElement;
  const groupsAt: Group[] = []; // { key, tag, count, els }
  const visit = (el: Element, path: string) => {
    const byTag = new Map<string, Element[]>();
    for (const c of childElements(el)) {
      const t = local(c.tagName);
      if (!byTag.has(t)) byTag.set(t, []);
      byTag.get(t)!.push(c);
    }
    for (const [tag, els] of byTag) {
      if (els.length >= 2) groupsAt.push({ key: `${path}/${tag}`, tag, count: els.length, els });
    }
    for (const c of childElements(el))
      visit(c, path ? `${path}/${local(c.tagName)}` : local(c.tagName));
  };
  visit(root, '');

  // "Top-level elements" fallback — each direct child of the root becomes a record.
  // Only meaningful when it isn't already identical to a detected repeated group
  // (e.g. <root><rec/><rec/></root>, where the <rec> group already covers it);
  // otherwise it would be a redundant twin that resolves to the same records.
  const rootChildren = childElements(root);
  const sameEls = (a: Element[], b: Element[]) =>
    a.length === b.length && a.every((x, i) => x === b[i]);
  const all: Group[] = [...groupsAt];
  if (rootChildren.length && !groupsAt.some((g) => sameEls(g.els, rootChildren))) {
    all.push({
      key: '(top-level)',
      tag: 'Top-level elements',
      count: rootChildren.length,
      els: rootChildren,
    });
  }

  let chosen: Partial<Group> | null | undefined = recordKey
    ? all.find((c) => c.key === recordKey)
    : null;
  if (!chosen) chosen = groupsAt.slice().sort((a, b) => b.count - a.count)[0];
  if (!chosen)
    chosen =
      all[0] ||
      (rootChildren.length
        ? { key: '(top-level)', els: rootChildren }
        : { key: '(document)', els: [root] });

  return {
    records: chosen.els as Element[],
    candidates: all.map((c) => ({ key: c.key, label: `${c.tag} (×${c.count})`, count: c.count })),
    selectedKey: chosen.key as string,
  };
}

function directText(el: Element) {
  let s = '';
  for (const n of el.childNodes) if (n.nodeType === 3 || n.nodeType === 4) s += n.nodeValue;
  return s;
}

// Element → JS value. Attributes → @_name; child elements grouped by local name
// (repeated → array); pure-text leaf → scalar (null when empty); mixed → #text.
export function elementToValue(
  el: Element,
  { inferTypes = false, warnings }: { inferTypes?: boolean; warnings?: string[] } = {},
): any {
  const coerce = (s: string) => (inferTypes ? inferValue(s) : s);
  const obj: Record<string, any> = {};
  let structured = false;

  for (const attr of el.attributes || []) {
    if (attr.name === 'xmlns' || attr.name.startsWith('xmlns:')) continue;
    obj[`@_${local(attr.name)}`] = coerce(attr.value);
    structured = true;
  }

  const byTag = new Map<string, { els: Element[]; raw: Set<string> }>();
  for (const c of childElements(el)) {
    const t = local(c.tagName);
    if (!byTag.has(t)) byTag.set(t, { els: [], raw: new Set() });
    const g = byTag.get(t)!;
    g.els.push(c);
    g.raw.add(c.tagName);
    structured = true;
  }
  for (const [tag, g] of byTag) {
    if (warnings && g.raw.size > 1)
      warnings.push(
        `Elements ${[...g.raw].join(', ')} merged into "${tag}" after stripping namespace prefixes.`,
      );
    const vals = g.els.map((c) => elementToValue(c, { inferTypes, warnings }));
    obj[tag] = g.els.length > 1 ? vals : vals[0];
  }

  const text = directText(el).trim();
  if (!structured) return text === '' ? null : coerce(text);
  if (text !== '') obj['#text'] = coerce(text);
  return obj;
}

export function toDocs(records: Element[], { inferTypes = false }: { inferTypes?: boolean } = {}) {
  const warnings: string[] = [];
  let wrapped = 0;
  const docs = records.map((el) => {
    let v = elementToValue(el, { inferTypes, warnings });
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      v = { '#text': v };
      wrapped++;
    }
    return v;
  });
  if (wrapped)
    warnings.push(`${wrapped} record(s) had no fields; their text was stored under "#text".`);
  const columns: string[] = [];
  for (const d of docs) for (const k of Object.keys(d)) if (!columns.includes(k)) columns.push(k);
  return { docs, columns, warnings: [...new Set(warnings)] };
}

export function parseXml(
  input: string | ArrayBuffer | Uint8Array,
  { recordKey, inferTypes = false }: { recordKey?: string | null; inferTypes?: boolean } = {},
) {
  try {
    const str = typeof input === 'string' ? input : new TextDecoder('utf-8').decode(input);
    const doc = parseDoc(str);
    const { records, candidates, selectedKey } = detectRecords(doc, recordKey);
    const { docs, columns, warnings } = toDocs(records, { inferTypes });
    return {
      docs,
      columns,
      warnings,
      error: null,
      recordCandidates: candidates,
      recordKey: selectedKey,
    };
  } catch (err) {
    return {
      docs: [],
      columns: [],
      warnings: [],
      error: { message: (err as Error).message },
      recordCandidates: [],
      recordKey: null,
    };
  }
}

// --- export (object → XML) -------------------------------------------------
const XML_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
export function escapeXml(s: unknown) {
  return String(s).replace(/[&<>]/g, (c) => XML_ESC[c]);
}

// Map any JSON key to a valid XML element Name (W3C XML 1.0). '_id' stays as-is.
export function toXmlName(key: unknown): string {
  let s = String(key).replace(/[^A-Za-z0-9_.\-]/g, '_'); // disallowed chars → _
  if (s === '') s = '_';
  if (!/^[A-Za-z_]/.test(s)) s = '_' + s; // must start with a letter or _
  if (/^xml/i.test(s)) s = '_' + s; // reserved 'xml' prefix
  return s;
}

// null/undefined -> <name/>; array -> repeated <name>; EJSON wrapper -> its scalar
// text (a nested <_oid> could never come back — toXmlName strips the '$');
// object -> nested; primitive -> text.
export function valueToXml(name: string, value: unknown): string {
  const tag = toXmlName(name);
  if (value === null || value === undefined) return `<${tag}/>`;
  if (Array.isArray(value)) return value.map((v) => valueToXml(name, v)).join('');
  if (typeof value === 'object') {
    const ejson = getEjsonType(value);
    if (ejson) return `<${tag}>${escapeXml(formatEjsonValue(value, ejson))}</${tag}>`;
    return `<${tag}>${Object.entries(value)
      .map(([k, v]) => valueToXml(k, v))
      .join('')}</${tag}>`;
  }
  return `<${tag}>${escapeXml(value)}</${tag}>`;
}

export function docToXml(doc: Record<string, unknown>, recordName = 'record') {
  const tag = toXmlName(recordName);
  return `<${tag}>${Object.entries(doc)
    .map(([k, v]) => valueToXml(k, v))
    .join('')}</${tag}>`;
}
