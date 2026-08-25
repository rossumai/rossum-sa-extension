// Pure word-level text diff (design system). Tokenizes each side into words and
// whitespace runs (so the text reconstructs exactly), runs an LCS over tokens, and
// returns a flat, coalesced list of { type: 'same' | 'add' | 'del', text } segments
// for inline rendering (removed struck, added highlighted). No DOM, no deps.

/** One inline segment: unchanged, added, or removed text. */
export type DiffSegment = { type: 'same' | 'add' | 'del'; text: string };

export function tokenize(s: unknown): string[] {
  return String(s ?? '').match(/\s+|\S+/g) || [];
}

// Deliverables are short, but guard the O(n·m) LCS against pathological inputs: above
// this token product, fall back to a coarse "delete all / add all" so we never blow up.
const MAX_PRODUCT = 4_000_000;

export function diffWords(a: unknown, b: unknown): DiffSegment[] {
  const A = tokenize(a);
  const B = tokenize(b);
  const n = A.length;
  const m = B.length;
  const out: DiffSegment[] = [];
  const push = (type: DiffSegment['type'], text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  if (n === 0 && m === 0) return out;
  if (n * m > MAX_PRODUCT) {
    push('del', A.join(''));
    push('add', B.join(''));
    return out;
  }
  // dp[i][j] = LCS length of A[i..] and B[j..]
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      push('same', A[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push('del', A[i]);
      i++;
    } else {
      push('add', B[j]);
      j++;
    }
  }
  while (i < n) {
    push('del', A[i]);
    i++;
  }
  while (j < m) {
    push('add', B[j]);
    j++;
  }
  return out;
}
