// Separate esbuild entry: bundles beautiful-mermaid's SVG renderer into
// dist/console/mermaid.js, script-injected on demand by src/ui/fabry/
// mermaidLoader.js (first mermaid fence in a Fabry chat). The package ships
// one flat pre-bundled module (~1.5MB, no tree-shakable subpaths), so keeping
// it out of console.js keeps every other Console open lean.
import { renderMermaidSVG } from 'beautiful-mermaid';

window.__fabryMermaidSvg = renderMermaidSVG;
