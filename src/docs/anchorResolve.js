// Resolving a link fragment to a heading — forgivingly.
//
// The generated id for "### 2.1 Entities" is `21-entities`: markdown-it-anchor lowercases and
// strips punctuation, so the dot disappears. A human writing a cross-reference writes what they
// see — `[§2.1](data-model.md#2.1)` — and that fragment matches nothing, which is why such a
// link previewed and navigated to nowhere while a hand-copied `#21-entities` worked.
//
// So a fragment is resolved in order of how much it proves:
//   1. exact id            — unambiguous, always wins
//   2. normalized equality — `#2-1-entities`, `#2.1 Entities`, `#21Entities`
//   3. section-number prefix — `#2.1` for "2.1 Entities", but only when the heading's next
//      character is not a digit, so `#2.1` never silently resolves to "2.10 Something".
// Pure: takes a list of { id, text } and returns an id.

export function normalizeAnchor(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// headings: [{ id, text }] in document order. Returns an id, or null.
export function resolveHeadingId(headings, fragment) {
  const list = Array.isArray(headings) ? headings.filter((h) => h && h.id) : [];
  if (!list.length) return null;
  let frag = String(fragment ?? '');
  try { frag = decodeURIComponent(frag); } catch { /* keep the raw form */ }
  frag = frag.replace(/^#/, '').trim();
  if (!frag) return null;

  const exact = list.find((h) => h.id === frag);
  if (exact) return exact.id;

  const target = normalizeAnchor(frag);
  if (!target) return null;

  const equal = list.find((h) => normalizeAnchor(h.id) === target || normalizeAnchor(h.text) === target);
  if (equal) return equal.id;

  // A leading section number only: "2.1" → "21". Require the heading to continue with something
  // that is not a digit, or "2.1" would also match "2.10".
  const prefixed = list.find((h) => {
    const norm = normalizeAnchor(h.text);
    if (!norm.startsWith(target) || norm === target) return false;
    return !/[0-9]/.test(norm.charAt(target.length));
  });
  return prefixed ? prefixed.id : null;
}

// DOM flavour: read the headings out of a rendered document and resolve against them.
export function resolveHeadingElement(root, fragment) {
  if (!root || !root.querySelectorAll) return null;
  const nodes = [...root.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]')];
  const id = resolveHeadingId(nodes.map((n) => ({ id: n.id, text: n.textContent || '' })), fragment);
  return id ? nodes.find((n) => n.id === id) || null : null;
}
