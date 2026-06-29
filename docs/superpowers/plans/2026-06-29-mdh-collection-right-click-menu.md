# MDH Collection Right-Click Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Right-clicking a collection in the MDH sidebar opens the existing actions menu (Open in new tab / Copy name / Rename / Drop) anchored at the cursor, with the browser's default menu suppressed.

**Architecture:** Add an `onContextMenu` handler to the collection row that `preventDefault()`s the native menu and opens the existing `.collection-action-menu` at the cursor by setting `menuPos`/`menuOpenFor`. Generalize `menuPos` to anchor by `left` (right-click, opens down-right from cursor) or `right` (kebab, unchanged). Reuses the existing menu markup, the `openCollectionTab` wiring, and the close-on-outside-click/scroll effect.

**Tech Stack:** Preact + @preact/signals, vitest (jsdom).

## Global Constraints

- **No git commits during this run** (user standing preference): stay on `master`, no branches. End with a verification checkpoint (targeted test + full suite), NOT a commit. Do NOT run `git commit`/`git add`.
- **Additive only:** no change to the auth model, manifest, permissions, or storage keys. Plain click, Cmd/Ctrl-click, middle-click, and the kebab button stay unchanged — this only adds the right-button trigger and a more general `menuPos` shape.
- **Full actions menu on right-click** (Open in new tab / Copy name / Rename / Drop), reusing the existing menu — NOT a right-click-only menu.
- **No viewport edge-flip** for the cursor-positioned menu — keep parity with the existing kebab menu (documented non-goal).
- **Test env:** the sidebar test is jsdom (`// @vitest-environment jsdom`), renders via `render(h(Sidebar, null), root)`, mocks `api.js` and the `openCollectionTab` module. Run one file: `npx vitest run tests/<file>`; full suite: `npm test`.

---

### Task 1: Right-click context menu on collection rows

**Files:**
- Modify: `src/mdh/components/Sidebar.jsx` (row `onContextMenu`; menu `style` left/right generalization)
- Modify: `tests/mdh-sidebar-open-tab.test.js` (append right-click cases + kebab regression)
- Modify: `CLAUDE.md` (extend the sidebar open-in-new-tab note)

**Interfaces:**
- Consumes: existing `Sidebar.jsx` state `menuOpenFor`/`setMenuOpenFor`, `menuPos`/`setMenuPos`, the `.collection-action-menu` markup, and `openCollectionTab` (already imported). No new exports.
- Produces: nothing new. Behavior: a `contextmenu` event on a collection row opens the actions menu at the cursor and suppresses the default menu.

- [ ] **Step 1: Write the failing test**

Open `tests/mdh-sidebar-open-tab.test.js` and confirm its existing helpers: a `mount()` that renders `Sidebar` into a detached div and awaits a tick, and a `rowFor(root, name)` that returns the `.collection-item` whose `.collection-item-name` text is `name` (used by the existing open-tab cases). Append this `describe` block at the end of the file (reuse the file's existing `mount`/`rowFor`/`tick` helpers and `beforeEach`; if a helper has a different name in the file, use that name):

```js
describe('Sidebar right-click context menu', () => {
  it('opens the actions menu at the cursor and suppresses the native menu', async () => {
    const root = await mount();
    const evt = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 80 });
    rowFor(root, 'vendors').dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    await tick();
    const menu = root.querySelector('.collection-action-menu');
    expect(menu).not.toBeNull();
    const item = Array.from(menu.querySelectorAll('.toolbar-menu-item'))
      .find((b) => b.textContent.includes('Open in new tab'));
    expect(item).toBeTruthy();
  });

  it('right-click "Open in new tab" opens a new tab for that collection', async () => {
    const root = await mount();
    rowFor(root, 'items').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 40 }));
    await tick();
    const item = Array.from(root.querySelectorAll('.collection-action-menu .toolbar-menu-item'))
      .find((b) => b.textContent.includes('Open in new tab'));
    item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(openCollectionTab).toHaveBeenCalledWith('items');
  });

  it('the kebab button still opens the menu (regression)', async () => {
    const root = await mount();
    rowFor(root, 'vendors').querySelector('.collection-action-menu-btn')
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await tick();
    expect(root.querySelector('.collection-action-menu')).not.toBeNull();
  });
});
```

If the file lacks a `tick` helper, add `const tick = () => new Promise((r) => setTimeout(r, 0));` near the top (the file already awaits a tick inside `mount`, so an equivalent exists — reuse it).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mdh-sidebar-open-tab.test.js`
Expected: FAIL — the "opens the actions menu at the cursor" case fails because the row has no `onContextMenu` handler yet, so `evt.defaultPrevented` is `false` and no `.collection-action-menu` is rendered after the right-click.

- [ ] **Step 3: Add the `onContextMenu` handler to the row**

In `src/mdh/components/Sidebar.jsx`, in the `cols.map((name) => ( … ))` block, the row `<div>` currently has `onClick`, `onAuxClick`, and `onMouseDown`. Add `onContextMenu` immediately after the `onMouseDown` line:

```jsx
            onContextMenu={(e) => {
              e.preventDefault();
              setMenuPos({ top: e.clientY, left: e.clientX });
              setMenuOpenFor(name);
            }}
```

- [ ] **Step 4: Generalize the menu position style (left OR right)**

In the same file, the menu is rendered inside `{menuOpenFor && menuPos && ( … )}`. Replace this exact line:

```jsx
          style={`position:fixed;top:${menuPos.top}px;right:${menuPos.right}px`}
```

with:

```jsx
          style={`position:fixed;top:${menuPos.top}px;` + (menuPos.left != null ? `left:${menuPos.left}px` : `right:${menuPos.right}px`)}
```

The kebab path (`toggleMenu`) still sets `{ top, right }` (no `left`), so it keeps using `right` — unchanged. The right-click path sets `{ top, left }`, so it uses `left`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/mdh-sidebar-open-tab.test.js`
Expected: PASS (the new 3 cases plus the existing open-tab cases).

- [ ] **Step 6: Add the CLAUDE.md note**

In `CLAUDE.md`, find the sentence added for the open-in-new-tab feature in the "### Dataset Management (MDH)" section (it begins "The MDH sidebar can also open a collection in a new Console tab (kebab \"Open in new tab\", or Cmd/Ctrl/middle-click a collection)…"). Extend its parenthetical so it reads: "(kebab \"Open in new tab\", right-click the collection for the same actions menu at the cursor, or Cmd/Ctrl/middle-click a collection)". Keep the rest of the sentence intact.

- [ ] **Step 7: Verify build + full suite (no commit)**

Run: `npm run build`
Expected: build succeeds.

Run: `npm test`
Expected: full suite green (the existing `tests/mdh-sidebar-drop.test.js` and `tests/mdh-sidebar-open-tab.test.js` all pass).

- [ ] **Step 8: Manual browser verification (record the result)**

Per `CLAUDE.md` Browser Automation. Right-click a collection in the MDH sidebar → the actions menu appears at the cursor with "Open in new tab" at top; the browser's default context menu does NOT appear; clicking "Open in new tab" opens the collection in a new tab; the kebab `⋮` button still works. Note the outcome (deferred to the controller if no authenticated session is available).

---

## Self-Review

**Spec coverage:**
- Right-click opens the existing actions menu at the cursor → Task 1 Steps 3-4. ✓
- `preventDefault` suppresses the native menu → Step 3 + test asserts `defaultPrevented`. ✓
- `menuPos` left/right generalization, kebab unchanged → Step 4 + kebab regression test. ✓
- Full actions menu (not open-only) → reuses existing menu; "Open in new tab" item asserted. ✓
- Additive / no auth-manifest-storage change → Global Constraints; only adds a handler + style generalization. ✓
- a11y note (kebab remains keyboard route) → no keyboard path added, consistent with spec. ✓
- Docs → Step 6. ✓
- No viewport edge-flip → Global Constraints (parity with existing menu). ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to" — every code step shows complete code. ✓

**Type/name consistency:** `menuPos` shape `{top, left}` (right-click) vs `{top, right}` (kebab) is consistent between Step 3 (sets `left`), Step 4 (reads `left`/`right`), and the unchanged `toggleMenu`. The style ternary `menuPos.left != null` correctly distinguishes the two shapes. Test reuses the existing `mount`/`rowFor` helpers and the already-mocked `openCollectionTab`. ✓
