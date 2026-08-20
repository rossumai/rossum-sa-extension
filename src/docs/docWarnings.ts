// Document diagnostics, and the one place that knows section states are NOT written in
// the document (owner, 2026-08-17: "make it part of the Fabry's Architect, not inside the markdown"),
// and since 2026-08-19 there is no manual state at all — a deliverable's status is its check verdict.
//
// localpages' `<state-label>` plugin is no longer in the pipeline, so the element would
// otherwise do NOTHING AT ALL in a deliverable: markdown-it passes the unknown tag
// through, the sanitizer unwraps it, and a browser renders it as nothing. That is the
// exact failure this whole convention was designed against — upstream's own words: "a
// browser renders an unrecognised custom element as nothing at all, so a typo would
// otherwise produce a blank space and no clue."
//
// Upstream guards typos in a label's ATTRIBUTES (unknown state, paired form, not after a
// heading) but never in its TAG NAME, which is how `<section-state …/>` came to vanish
// silently. So this reports both: the element that used to work, and the near-misses
// someone reaching for it would actually type.

// Normalized names that mean "this person was reaching for a state label". Compared with
// every non-letter stripped, so `state_label`, `state-label` and `StateLabel` all match.
const NEAR_MISSES = new Set([
  'statelabel', 'labelstate', 'statelabels',
  'sectionstate', 'statesection', 'sectionstatelabel', 'sectionstatus',
  'state', 'status',
]);

// The Architect's manual state was dropped on 2026-08-19, so there is no longer anywhere to "set" a
// state — status comes from the check verdict alone. The diagnostic still earns its place: markdown-it
// passes an unknown tag through, the sanitizer unwraps it, and a browser draws an unrecognised custom
// element as EMPTY SPACE, so without this the text simply disappears.
const WHERE = 'this element is not supported here — a deliverable\u2019s status comes from its check verdict';
// Bare `<state>`/`<status>` are on the list too. They may well be prose placeholders
// rather than attempted labels, but either way the element renders as NOTHING, so saying
// so beats silence — and the message covers both readings.

// markdown-it's own types are not a declared dependency here, so its plugin/token/state
// objects are `any` at this boundary.
const normalize = (tag: unknown) => String(tag || '').toLowerCase().replace(/[^a-z]/g, '');

// The tag name at the start of an HTML fragment, or ''.
export function leadingTagName(html: unknown): string | null {
  const m = String(html || '').trim().match(/^<\/?\s*([a-zA-Z][\w:-]*)/);
  return m ? m[1] : '';
}

export function isStateLabelish(tag: unknown): boolean {
  return NEAR_MISSES.has(normalize(tag));
}

function esc(s: unknown): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Rendered INTO the page, not only collected — same reasoning as upstream's error badge,
// and it reuses upstream's own `.state-label.state-error` styling (dashed red pill) so
// there is no new CSS and it reads as the same class of problem.
function notice(tag: string): string {
  return `<span class="state-label state-error" data-state="error">`
    + `<span class="state-label-text">${esc(`<${tag}> renders as nothing — ${WHERE}`)}</span>`
    + '</span>';
}

const lineOf = (token: any) => (token && token.map ? token.map[0] + 1 : 0);

// Collected warnings ride the same `env` key the ported code used, so the reporter below
// is a drop-in for upstream's reportStateLabelWarnings — DocView and the exporter call
// one function and get every document diagnostic.
export function reportDocWarnings(env: any, file: unknown, emit: (msg: string) => void = console.warn): number {
  const warnings = env && env.stateLabelWarnings;
  if (!warnings || !warnings.length) return 0;
  for (const w of warnings) emit(`${file}:${w.line} ${w.message}`);
  return warnings.length;
}

// markdown-it plugin. Detection runs on the TOKEN STREAM, which is what keeps a fenced
// ```markdown example of the syntax from being flagged — a fence is a `fence` token,
// never an html_block (upstream's insight, and its own test depends on it).
export default function docWarnings(md: any): void {
  md.core.ruler.push('doc_warnings', (state: any) => {
    const env = state.env || {};
    const warn = (line: number, message: string) => {
      (env.stateLabelWarnings || (env.stateLabelWarnings = [])).push({ line, message });
    };

    for (const token of state.tokens) {
      if (token.type === 'html_block') {
        const tag = leadingTagName(token.content);
        if (!isStateLabelish(tag)) continue;
        warn(lineOf(token), `<${tag}> renders as nothing — ${WHERE}`);
        token.content = notice(tag as string) + '\n';
        continue;
      }
      if (token.type !== 'inline' || !token.children) continue;
      for (const child of token.children) {
        if (child.type !== 'html_inline') continue;
        const tag = leadingTagName(child.content);
        if (!isStateLabelish(tag)) continue;
        // A closing partner leaves no trace of its own.
        if (/^<\//.test(child.content.trim())) { child.content = ''; continue; }
        warn(lineOf(token), `<${tag}> renders as nothing — ${WHERE}`);
        child.content = notice(tag as string);
      }
    }
  });
}
