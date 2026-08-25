// Placeholder variable grammar, shared by the substituter (hooks/usePipeline.js)
// and the field-mapping analysis (placeholderFields.js). A variable is a quoted
// "{name}" or "{name | modifier(arg)}". VAR_RE matches a WHOLE string; VAR_RE_G
// finds EMBEDDED occurrences inside a larger string. Kept in one module so the
// two consumers can't drift.
export const VAR_RE =
  /^\{\s*([a-zA-Z_]\w*)\s*(?:\|\s*([a-zA-Z_]+)(?:\s*\(\s*([^)]*?)\s*\))?\s*)?\}$/;
export const VAR_RE_G =
  /\{\s*([a-zA-Z_]\w*)\s*(?:\|\s*([a-zA-Z_]+)(?:\s*\(\s*([^)]*?)\s*\))?\s*)?\}/g;
