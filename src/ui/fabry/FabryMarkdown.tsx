import { h } from 'preact';
import { parseMarkdown } from './markdown.js';
import { highlightCode } from './highlight.js';
import MermaidBlock from './MermaidBlock.jsx';
import styles from './FabryMarkdown.module.css';

// The block/span tree comes from parseMarkdown, which is untyped by design (it is a parser
// over arbitrary agent text) — so the node shapes are `any` and the discriminant is `type`.
type Span = any;
type Block = any;

// Block tree → vnodes. All text lands as text nodes (never innerHTML).
function Spans({ spans }: { spans: Span[] }) {
  return spans.map((s: Span, i: number) => {
    if (s.type === 'code')
      return (
        <code key={i} class={styles.icode}>
          {s.text}
        </code>
      );
    if (s.type === 'strong') return <strong key={i}>{s.text}</strong>;
    if (s.type === 'em') return <em key={i}>{s.text}</em>;
    if (s.type === 'link')
      return (
        <a key={i} href={s.href} target="_blank" rel="noopener noreferrer">
          {s.text}
        </a>
      );
    return s.text;
  });
}

function CodeBlock({ lang, text }: { lang?: string; text: string }) {
  const tokens = highlightCode(text, lang);
  return (
    <div class={styles.codewrap}>
      {lang ? <span class={styles.lang}>{lang}</span> : null}
      <pre class={styles.code}>
        <code>
          {tokens.map((t, i: number) =>
            t.type === 'plain' ? (
              t.text
            ) : (
              <span key={i} class={styles['hl-' + t.type]}>
                {t.text}
              </span>
            ),
          )}
        </code>
      </pre>
    </div>
  );
}

function BlockView({ b, streaming }: { b: Block; streaming?: boolean }) {
  if (b.type === 'heading')
    return h('h' + Math.min(b.level + 2, 6), { class: styles.h }, h(Spans, { spans: b.spans }));
  if (b.type === 'code') {
    // Mermaid fences render as diagrams — but only once the stream is done
    // (a half-received diagram would fail-render on every delta).
    if (b.lang === 'mermaid' && !streaming) return <MermaidBlock code={b.text} />;
    return <CodeBlock lang={b.lang} text={b.text} />;
  }
  if (b.type === 'ul')
    return (
      <ul>
        {b.items.map((it: Span[], i: number) => (
          <li key={i}>
            <Spans spans={it} />
          </li>
        ))}
      </ul>
    );
  if (b.type === 'ol')
    return (
      <ol>
        {b.items.map((it: Span[], i: number) => (
          <li key={i}>
            <Spans spans={it} />
          </li>
        ))}
      </ol>
    );
  if (b.type === 'blockquote')
    return (
      <blockquote class={styles.quote}>
        <Spans spans={b.spans} />
      </blockquote>
    );
  if (b.type === 'hr') return <hr class={styles.hr} />;
  if (b.type === 'table') {
    return (
      <div class={styles.tablewrap}>
        <table class={styles.table}>
          <thead>
            <tr>
              {b.header.map((c: Span[], i: number) => (
                <th key={i}>
                  <Spans spans={c} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {b.rows.map((r: Span[][], i: number) => (
              <tr key={i}>
                {r.map((c: Span[], j: number) => (
                  <td key={j}>
                    <Spans spans={c} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <p>
      <Spans spans={b.spans} />
    </p>
  );
}

export default function FabryMarkdown({
  text,
  streaming,
}: {
  text?: string | null;
  streaming?: boolean;
}) {
  return (
    <div class={styles.md}>
      {parseMarkdown(text).map((b, i) => (
        <BlockView key={i} b={b} streaming={streaming} />
      ))}
      {streaming ? <span class={styles.caret} /> : null}
    </div>
  );
}
