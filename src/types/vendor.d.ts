// Ambient declarations for the two runtime dependencies that ship no types.
//
// `three` dropped its bundled .d.ts in favour of the separate `@types/three`, and
// `d3-force-3d` has never had any. Both are declared `any` here rather than pulling
// `@types/three` in, deliberately: src/galaxy/scene.ts is 559 lines of hand-rolled
// WebGL whose correctness is established by looking at the rendered scene, not by a
// type-checker (jsdom has no WebGL, so there is no test to strengthen either). Typing
// it against three's real surface is its own project; until someone wants that, this
// keeps the file checkable for everything that is NOT three.
//
// Everything else in package.json ships its own types — see the Dependencies section
// of CLAUDE.md before adding an entry here.
declare module 'three' {
  const THREE: any;
  export = THREE;
}
declare module 'three/addons/controls/OrbitControls.js' {
  export const OrbitControls: any;
}
declare module 'd3-force-3d' {
  export const forceSimulation: any;
  export const forceManyBody: any;
  export const forceLink: any;
  export const forceCenter: any;
  export const forceX: any;
  export const forceY: any;
  export const forceZ: any;
}

// CSS Modules. esbuild turns `import css from './X.module.css'` into an object of
// generated class names; only components import these, so .js -> .ts never needed it.
// Values are strings and the key set is whatever the stylesheet declares, which is why
// this is an index signature rather than a per-file generated type: a build step that
// emitted exact keys would have to run before tsc, and the payoff (catching a typo'd
// class name) is already covered by tests/css-class-collision-boundary.test.js reading
// the BUILT stylesheet.
declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}
