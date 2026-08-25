// Hand-rolled syntax highlighting for Fabry markdown code fences. Pure:
// highlightCode(code, lang) → Token[] where Token = {type, text}; the renderer
// turns tokens into <span> vnodes, so output stays XSS-inert by construction
// (same stance as markdown.js — never HTML strings). Deliberately a subset:
// comments / strings / numbers / keywords / literals / decorators cover the
// languages the agent actually emits (python, json, js, bash, sql, yaml-ish);
// anything unknown falls through as one plain token.

/** One highlighted run. `type` becomes a `.hl-*` class on a vnode span. */
export type Token = { type: string; text: string };

type LangConfig = {
  comment?: RegExp;
  string?: RegExp;
  decorator?: RegExp;
  keywords: Set<string>;
  literals: Set<string>;
  /** JSON object keys ("key":) get their own colour. */
  jsonKeys?: boolean;
  caseInsensitiveKeywords?: boolean;
};

const LANGS: Record<string, LangConfig> = {
  python: {
    comment: /#[^\n]*/y,
    string: /("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')/y,
    decorator: /@[A-Za-z_][\w.]*/y,
    keywords: new Set([
      'def',
      'class',
      'return',
      'if',
      'elif',
      'else',
      'for',
      'while',
      'import',
      'from',
      'as',
      'try',
      'except',
      'finally',
      'with',
      'lambda',
      'and',
      'or',
      'not',
      'in',
      'is',
      'raise',
      'pass',
      'yield',
      'async',
      'await',
      'global',
      'nonlocal',
      'del',
      'assert',
      'break',
      'continue',
    ]),
    literals: new Set(['None', 'True', 'False', 'self']),
  },
  json: {
    string: /"(?:\\.|[^"\\\n])*"/y,
    keywords: new Set(),
    literals: new Set(['true', 'false', 'null']),
    jsonKeys: true,
  },
  javascript: {
    comment: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/y,
    string: /(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')/y,
    keywords: new Set([
      'const',
      'let',
      'var',
      'function',
      'return',
      'if',
      'else',
      'for',
      'while',
      'class',
      'extends',
      'new',
      'import',
      'from',
      'export',
      'default',
      'try',
      'catch',
      'finally',
      'throw',
      'async',
      'await',
      'typeof',
      'instanceof',
      'in',
      'of',
      'switch',
      'case',
      'break',
      'continue',
      'delete',
      'void',
      'yield',
    ]),
    literals: new Set(['true', 'false', 'null', 'undefined', 'this']),
  },
  bash: {
    comment: /#[^\n]*/y,
    string: /("(?:\\.|[^"\\])*"|'[^']*')/y,
    keywords: new Set([
      'if',
      'then',
      'else',
      'elif',
      'fi',
      'for',
      'in',
      'do',
      'done',
      'while',
      'case',
      'esac',
      'function',
      'export',
      'local',
      'return',
      'echo',
      'cd',
      'set',
    ]),
    literals: new Set(),
  },
  sql: {
    comment: /(--[^\n]*|\/\*[\s\S]*?\*\/)/y,
    string: /'(?:''|[^'\n])*'/y,
    keywords: new Set([
      'select',
      'from',
      'where',
      'and',
      'or',
      'not',
      'insert',
      'into',
      'values',
      'update',
      'set',
      'delete',
      'join',
      'left',
      'right',
      'inner',
      'outer',
      'on',
      'group',
      'by',
      'order',
      'having',
      'limit',
      'offset',
      'as',
      'distinct',
      'count',
      'sum',
      'avg',
      'min',
      'max',
      'create',
      'table',
      'index',
    ]),
    literals: new Set(['null', 'true', 'false']),
    caseInsensitiveKeywords: true,
  },
};
LANGS.py = LANGS.python;
LANGS.js = LANGS.javascript;
LANGS.typescript = LANGS.javascript;
LANGS.ts = LANGS.javascript;
LANGS.sh = LANGS.bash;
LANGS.shell = LANGS.bash;

const NUMBER = /\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const WORD = /[A-Za-z_$][\w$]*/y;

export function highlightCode(code: unknown, lang: unknown): Token[] {
  const src = String(code ?? '');
  const cfg = LANGS[String(lang || '').toLowerCase()];
  if (!cfg || !src) return [{ type: 'plain', text: src }];

  const tokens: Token[] = [];
  let plain = '';
  const flush = () => {
    if (plain) {
      tokens.push({ type: 'plain', text: plain });
      plain = '';
    }
  };
  const tryMatch = (re: RegExp | undefined, i: number): string | null => {
    if (!re) return null;
    re.lastIndex = i;
    const m = re.exec(src);
    return m ? m[0] : null;
  };

  let i = 0;
  while (i < src.length) {
    let m: string | null;
    if ((m = tryMatch(cfg.comment, i))) {
      flush();
      tokens.push({ type: 'com', text: m });
      i += m.length;
      continue;
    }
    if ((m = tryMatch(cfg.string, i))) {
      flush();
      // JSON object keys ("key":) read better in a distinct color than values.
      let type = 'str';
      if (cfg.jsonKeys && /^\s*:/.test(src.slice(i + m.length))) type = 'key';
      tokens.push({ type, text: m });
      i += m.length;
      continue;
    }
    if ((m = tryMatch(cfg.decorator, i))) {
      flush();
      tokens.push({ type: 'dec', text: m });
      i += m.length;
      continue;
    }
    if ((m = tryMatch(NUMBER, i))) {
      flush();
      tokens.push({ type: 'num', text: m });
      i += m.length;
      continue;
    }
    if ((m = tryMatch(WORD, i))) {
      const w = cfg.caseInsensitiveKeywords ? m.toLowerCase() : m;
      if (cfg.keywords.has(w)) {
        flush();
        tokens.push({ type: 'kw', text: m });
      } else if (cfg.literals.has(w)) {
        flush();
        tokens.push({ type: 'lit', text: m });
      } else plain += m;
      i += m.length;
      continue;
    }
    plain += src[i];
    i += 1;
  }
  flush();
  return tokens;
}
