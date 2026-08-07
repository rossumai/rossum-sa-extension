// The single definition of "which annotation is this URL about".
//
// The fact being centralised: Rossum's dashboard shows an annotation at
// `/document/<id>` and — despite the path segment — <id> is the ANNOTATION id,
// not a document id (the segment is historical). `/annotation/<id>` and
// `/annotations/<id>` are the same route. The API spells it a third way,
// `/api/v1/annotations/<id>/…`. This was previously re-derived in six places
// with four different regexes that disagreed at the edges.
//
// TWO helpers, not one, because two genuinely different questions are asked:
//
//   • annotationIdFromPath — "is the dashboard on an annotation right now?"
//     Anchored, so only a real route answers. An API path must NOT match: the
//     DevTools panel maps dashboard routes, and the side panel follows them.
//
//   • annotationIdFromInput — "what did a human paste?" A bare id, a dashboard
//     URL, or an API URL are all fair game there.
//
// Collapsing those into one lenient regex would let an API URL masquerade as a
// dashboard route, so the split is deliberate.
//
// NOTE: src/popup/tab-readers.js keeps its own copy ON PURPOSE — its functions
// are serialized into the page by chrome.scripting.executeScript and so cannot
// close over an import. If this grammar changes, change that copy too.

const PATH_RE = /^\/(?:document|annotations?)\/(\d+)(?:[/?#]|$)/;
const API_RE = /\/api\/v\d+\/annotations\/(\d+)(?:[/?#]|$)/;

// Accepts a full URL or a bare path. A string that is neither (e.g. "document/5"
// from a careless paste) is treated as a path, which only ever loosens the
// paste case — every route caller passes a real pathname, which always starts
// with a slash.
function pathnameOf(urlOrPath) {
  const raw = String(urlOrPath ?? '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).pathname;
  } catch {
    // Not absolute — treat it as a path.
  }
  return raw.startsWith('/') ? raw : `/${raw}`;
}

export function annotationIdFromPath(urlOrPath) {
  const match = PATH_RE.exec(pathnameOf(urlOrPath));
  return match ? match[1] : null;
}

export function annotationIdFromInput(raw) {
  const text = String(raw ?? '').trim();
  if (/^\d+$/.test(text)) return text;
  const fromPath = annotationIdFromPath(text);
  if (fromPath) return fromPath;
  const api = API_RE.exec(text);
  return api ? api[1] : null;
}

// For consumers that need the pattern itself rather than a call — the DevTools
// route table matches a list of regexes and reads capture group 1.
export { PATH_RE as ANNOTATION_PATH_RE };
