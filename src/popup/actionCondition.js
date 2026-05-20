// Python-subset expression evaluator for MDH `action_condition`.
//
// MDH's action_condition is a Python-like expression that gets text-substituted
// with annotation values (e.g. `"'{supplier_invoice_any_wd}' != 'True'"`).
// Real hook examples use only literal comparisons and boolean combinators, so
// the subset supported here is:
//   - literals: string ('…' or "…"), int, float, True, False, None
//   - lists: [a, b, c]
//   - unary: - (numeric only), not
//   - boolean: and, or
//   - comparisons (left-assoc): ==, !=, <, <=, >, >=, in, not in
//   - parentheses
//
// Anything else (function calls, attribute access, arithmetic beyond unary
// minus, dict literals, identifiers other than True/False/None) is a parse
// error and returns { result: null, error } so the caller can show a warning
// rather than silently treat the cfg as gated.

// ── Tokenizer ──────────────────────────────────────

function isDigit(c) { return c >= '0' && c <= '9'; }
function isIdentStart(c) { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_'; }
function isIdentCont(c) { return isIdentStart(c) || isDigit(c); }

function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== quote) {
        if (input[j] === '\\' && j + 1 < input.length) {
          const nx = input[j + 1];
          if (nx === 'n') value += '\n';
          else if (nx === 't') value += '\t';
          else if (nx === 'r') value += '\r';
          else value += nx;
          j += 2;
        } else {
          value += input[j];
          j++;
        }
      }
      if (j >= input.length) throw new Error(`unterminated string starting at column ${i + 1}`);
      tokens.push({ type: 'STRING', value });
      i = j + 1;
      continue;
    }

    if (isDigit(c)) {
      let j = i + 1;
      while (j < input.length && isDigit(input[j])) j++;
      if (input[j] === '.' && isDigit(input[j + 1])) {
        j++;
        while (j < input.length && isDigit(input[j])) j++;
      }
      tokens.push({ type: 'NUMBER', value: Number(input.slice(i, j)) });
      i = j;
      continue;
    }

    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < input.length && isIdentCont(input[j])) j++;
      tokens.push({ type: 'IDENT', value: input.slice(i, j) });
      i = j;
      continue;
    }

    if (c === '=' && input[i + 1] === '=') { tokens.push({ type: 'OP', value: '==' }); i += 2; continue; }
    if (c === '!' && input[i + 1] === '=') { tokens.push({ type: 'OP', value: '!=' }); i += 2; continue; }
    if (c === '<' && input[i + 1] === '=') { tokens.push({ type: 'OP', value: '<=' }); i += 2; continue; }
    if (c === '>' && input[i + 1] === '=') { tokens.push({ type: 'OP', value: '>=' }); i += 2; continue; }
    if (c === '<') { tokens.push({ type: 'OP', value: '<' }); i++; continue; }
    if (c === '>') { tokens.push({ type: 'OP', value: '>' }); i++; continue; }
    if (c === '-') { tokens.push({ type: 'OP', value: '-' }); i++; continue; }
    if (c === '(') { tokens.push({ type: 'LPAREN' }); i++; continue; }
    if (c === ')') { tokens.push({ type: 'RPAREN' }); i++; continue; }
    if (c === '[') { tokens.push({ type: 'LBRACKET' }); i++; continue; }
    if (c === ']') { tokens.push({ type: 'RBRACKET' }); i++; continue; }
    if (c === ',') { tokens.push({ type: 'COMMA' }); i++; continue; }

    throw new Error(`unexpected character ${JSON.stringify(c)} at column ${i + 1}`);
  }
  return tokens;
}

// ── Parser ─────────────────────────────────────────

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek(offset = 0) { return this.tokens[this.pos + offset]; }
  next() { return this.tokens[this.pos++]; }
  expect(type) {
    const t = this.next();
    if (!t || t.type !== type) {
      throw new Error(`expected ${type}, got ${t ? t.type : 'end of expression'}`);
    }
    return t;
  }

  parse() {
    const node = this.parseOr();
    if (this.peek()) throw new Error('trailing tokens');
    return node;
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.peek()?.type === 'IDENT' && this.peek().value === 'or') {
      this.next();
      const right = this.parseAnd();
      left = { type: 'or', left, right };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseNot();
    while (this.peek()?.type === 'IDENT' && this.peek().value === 'and') {
      this.next();
      const right = this.parseNot();
      left = { type: 'and', left, right };
    }
    return left;
  }

  parseNot() {
    const t = this.peek();
    // `not` followed by `in` belongs to the comparison level, not the unary level.
    if (t?.type === 'IDENT' && t.value === 'not' && !(this.peek(1)?.type === 'IDENT' && this.peek(1).value === 'in')) {
      this.next();
      return { type: 'not', child: this.parseNot() };
    }
    return this.parseComparison();
  }

  parseComparison() {
    let left = this.parsePrimary();
    while (true) {
      const t = this.peek();
      if (!t) break;
      let op = null;
      if (t.type === 'OP' && ['==', '!=', '<', '<=', '>', '>='].includes(t.value)) {
        op = t.value;
        this.next();
      } else if (t.type === 'IDENT' && t.value === 'in') {
        op = 'in';
        this.next();
      } else if (t.type === 'IDENT' && t.value === 'not' && this.peek(1)?.type === 'IDENT' && this.peek(1).value === 'in') {
        op = 'not in';
        this.next();
        this.next();
      } else {
        break;
      }
      const right = this.parsePrimary();
      left = { type: 'cmp', op, left, right };
    }
    return left;
  }

  parsePrimary() {
    const t = this.next();
    if (!t) throw new Error('unexpected end of expression');
    if (t.type === 'STRING') return { type: 'literal', value: t.value };
    if (t.type === 'NUMBER') return { type: 'literal', value: t.value };
    if (t.type === 'OP' && t.value === '-') {
      const child = this.parsePrimary();
      return { type: 'neg', child };
    }
    if (t.type === 'IDENT') {
      if (t.value === 'True') return { type: 'literal', value: true };
      if (t.value === 'False') return { type: 'literal', value: false };
      if (t.value === 'None') return { type: 'literal', value: null };
      throw new Error(`unknown identifier '${t.value}' — only True, False, None are recognized`);
    }
    if (t.type === 'LPAREN') {
      const node = this.parseOr();
      this.expect('RPAREN');
      return node;
    }
    if (t.type === 'LBRACKET') {
      const items = [];
      if (this.peek()?.type !== 'RBRACKET') {
        items.push(this.parseOr());
        while (this.peek()?.type === 'COMMA') {
          this.next();
          items.push(this.parseOr());
        }
      }
      this.expect('RBRACKET');
      return { type: 'list', items };
    }
    throw new Error(`unexpected token ${t.type}${t.value != null ? ` '${t.value}'` : ''}`);
  }
}

// ── Evaluator ──────────────────────────────────────

// Python-style truthiness: None / False / 0 / '' / [] are falsy.
function truthy(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

// Python equality: True == 1, False == 0, otherwise strict identity.
// Strings and numbers don't cross-compare equal ('1' != 1).
function pyEq(a, b) {
  if (typeof a === 'boolean' && typeof b === 'number') return Number(a) === b;
  if (typeof a === 'number' && typeof b === 'boolean') return a === Number(b);
  return a === b;
}

function pyLt(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a < b;
  if (typeof a === 'string' && typeof b === 'string') return a < b;
  throw new Error(`cannot compare ${typeof a} and ${typeof b}`);
}

function evalNode(node) {
  switch (node.type) {
    case 'literal': return node.value;
    case 'list': return node.items.map(evalNode);
    case 'neg': {
      const v = evalNode(node.child);
      if (typeof v !== 'number') throw new Error(`unary - requires a number, got ${typeof v}`);
      return -v;
    }
    case 'not': return !truthy(evalNode(node.child));
    case 'and': {
      const l = evalNode(node.left);
      return truthy(l) ? evalNode(node.right) : l;
    }
    case 'or': {
      const l = evalNode(node.left);
      return truthy(l) ? l : evalNode(node.right);
    }
    case 'cmp': {
      const l = evalNode(node.left);
      const r = evalNode(node.right);
      switch (node.op) {
        case '==': return pyEq(l, r);
        case '!=': return !pyEq(l, r);
        case '<': return pyLt(l, r);
        case '<=': return pyLt(l, r) || pyEq(l, r);
        case '>': return pyLt(r, l);
        case '>=': return pyLt(r, l) || pyEq(l, r);
        case 'in': {
          if (typeof r === 'string') return r.includes(String(l));
          if (Array.isArray(r)) return r.some((x) => pyEq(x, l));
          throw new Error(`'in' requires a string or list on the right`);
        }
        case 'not in': {
          if (typeof r === 'string') return !r.includes(String(l));
          if (Array.isArray(r)) return !r.some((x) => pyEq(x, l));
          throw new Error(`'not in' requires a string or list on the right`);
        }
        default: throw new Error(`unknown operator '${node.op}'`);
      }
    }
    default: throw new Error(`unknown node type '${node.type}'`);
  }
}

// ── Public API ─────────────────────────────────────

// Evaluates an already-substituted expression string.
// Returns `{ result: boolean | null, error: string | null }` — result is null
// iff there was a parse/eval error. Result is the Python-truthy coercion of
// the expression value, so e.g. `'True'` (string literal) → true.
export function evalCondition(expr) {
  if (typeof expr !== 'string') {
    return { result: null, error: 'condition is not a string' };
  }
  const trimmed = expr.trim();
  if (trimmed === '') return { result: true, error: null };
  try {
    const tokens = tokenize(trimmed);
    if (tokens.length === 0) return { result: true, error: null };
    const ast = new Parser(tokens).parse();
    const value = evalNode(ast);
    return { result: truthy(value), error: null };
  } catch (e) {
    return { result: null, error: e?.message || String(e) };
  }
}

// Exported for tests only.
export const __testing = { tokenize, parse: (s) => new Parser(tokenize(s)).parse(), evalNode };
