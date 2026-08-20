// highlight.js, curated (spec 2026-08-17-localpages-port-architect, D4).
//
// localpages imports the whole of `highlight.js` (1,080,512 B bundled, ~190
// grammars) and relies on `highlightAuto` for its source-file viewer. This port
// has no filesystem source viewer (D2/D5) so nothing calls `highlightAuto`, and
// the owner chose a curated set: 61,596 B for core + the 11 grammars below.
//
// The divergence this buys is precise and one-directional: a fence tagged with a
// language NOT in this list renders as escaped plain code where localpages would
// colour it (render.js's `highlight()` returns '' when `getLanguage` misses, which
// is markdown-it's "no highlighter" signal). Adding a grammar is a one-line change.
//
// `markdown` is NOT optional: localpages' own state-labels test asserts that a
// ```markdown fence splits a <state-label> example across nested spans, which only
// happens when that grammar is registered.
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import ini from 'highlight.js/lib/languages/ini';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

// `ini` is highlight.js's own grammar id for TOML, and `xml` covers HTML — both
// match localpages' EXT_TO_LANG mapping.
export const GRAMMARS = { bash, css, diff, ini, javascript, json, markdown, python, sql, xml, yaml };

for (const [name, grammar] of Object.entries(GRAMMARS)) hljs.registerLanguage(name, grammar);

export default hljs;
