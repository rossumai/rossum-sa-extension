# Galaxy: hide disabled hooks — design

**Date:** 2026-06-12
**Status:** Approved; implementing (spec-review gate waived by user — "implement it")

## Goal

Stop rendering disabled hooks (extensions) in the Galaxy 3D graph.

## Confirmed current behavior (grounded, not assumed)

- `src/galaxy/api.js:111` fetches `/api/v1/hooks/?page_size=100` with **no active filter** — all hooks fetched.
- `src/galaxy/graph.js:117-119` adds a node for **every** hook — no `active` check.
- `src/galaxy/graph.js:60` labels them `['Active', o.active ? 'Yes' : 'No']`.
- `tests/galaxy-graph.test.js` fixture includes hook 201 (`active: false`) and **asserts `hook:201` is present**.

So today disabled hooks ARE shown. The disabled signal is the hook's `active` boolean.

## Decisions (locked with user)

| Decision | Choice |
| --- | --- |
| Treatment | **Remove disabled hooks from the graph entirely** (no node, no edges, no detail). |
| `run_after` chains | **Bridge**: a disabled hook in a chain is replaced by its own predecessors, transitively (`A→B(disabled)→C` ⇒ `A→C`). |
| Layer | All logic in `buildGraph` (`src/galaxy/graph.js`). **`api.js` unchanged** — it must keep fetching disabled hooks because bridging needs their `run_after` data. |
| Disabled test | `hook.active === false` only. Missing/`true` `active` ⇒ kept (conservative; never hide on absent data). |
| Detail card | Keep the `['Active', …]` row (now always "Yes"). Minimal blast radius; useful if a "show disabled" mode is added later. |

## Algorithm (in `buildGraph`)

1. Build `hookById` from **all** raw hooks (incl. disabled), keyed by `String(hk.id ?? idFromUrl(hk.url))`. `isDisabledHook(id) = hookById.get(id)?.active === false`.
2. **Nodes:** add a hook node only when `hk.active !== false`.
3. **`run_after` edges**, for each *enabled* hook C with predecessor ids `directPreds`:
   - `directPreds` empty → root → anchor to C's queue(s) (unchanged).
   - else compute `effectivePreds` by walking through disabled predecessors transitively (cycle-guarded `visited` set): a disabled predecessor is replaced by its own resolved predecessors; enabled/unknown ids pass through.
     - Draw a `runAfter` edge from each effective predecessor that is a present (enabled) node.
     - **Queue-anchor fallback (bridge case only):** if no edge was drawn AND at least one direct predecessor was a disabled hook (bridging happened), anchor C to its queue(s) so it doesn't float.
     - If no edge was drawn and NO disabled hook was involved (predecessors merely missing/unknown), draw nothing — **preserves today's float behavior** for missing predecessors (backward compat).

## Backward compatibility

- `api.js`, engines, queues, workspaces, org, connectors: untouched.
- Enabled-hook behavior unchanged.
- Missing-predecessor float preserved (new queue-anchor scoped strictly to the bridged-disabled case).

## Tests (`tests/galaxy-graph.test.js`)

- Flip the main fixture's hook 201 to `active: true` so existing run_after assertions keep covering the enabled case unchanged.
- New `describe('buildGraph — disabled hooks')`:
  - disabled hook → no node;
  - `A→B(disabled)→C` ⇒ `A→C`, no B node;
  - two-disabled chain `A→B(dis)→C(dis)→D` ⇒ `A→D`;
  - disabled-root `B(dis,run_after:[])→C` ⇒ C anchors to its queue (no orphan);
  - mixed predecessors `[P(enabled), D(dis)→X]` ⇒ edges `P→C` and `X→C`;
  - regression: enabled hook with a MISSING (non-disabled) predecessor still floats (no queue anchor);
  - conservative: hook with `active` absent is still shown.

## Out of scope (YAGNI)

No Legend toggle, no `api.js`/fetch change, no detail-row removal, nothing for engines/queues/connectors.
