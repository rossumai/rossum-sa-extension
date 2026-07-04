// Mirrors Python's re.escape() — the exact behavior of MDH's server-side `re`
// value filter (verified live against /svc/master-data-hub/api/v1/match on
// 2026-07-04 by echoing substituted placeholders back through a $literal
// probe). Python escapes `()[]{}?*+-|^$\.&~#` plus space/tab/LF/CR/VT/FF — a
// superset of the JS regex specials. The extra characters are not cosmetic:
// under whitespace-insensitive matching (e.g. $regex with $options "x") an
// unescaped space silently drops out of the pattern and the query returns
// nothing, so a weaker escape diverges from what the real service matches.
// Shared by the pipeline-editor substituter (mdh/hooks/usePipeline.js) and the
// provenance replay engine (popup/mdh-provenance.js) so the two can't drift.
export const PY_RE_SPECIALS_RE = /[()[\]{}?*+\-|^$\\.&~# \t\n\r\v\f]/g;

export function reEscape(value) {
  return String(value).replace(PY_RE_SPECIALS_RE, '\\$&');
}
