# Popup fits within Chrome's 600px cap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Rossum extension popup fit within Chrome's 600px cap so it never outer-scrolls — even with the "Document locked by …" reviewing-lock banner visible — scrolling only when the content genuinely cannot fit.

**Architecture:** CSS-only. Turn the popup's `#app` render root into a height-capped flex column; pin the accent bar / header / lock banner / footer; make the MDH provenance panel the sole internal scroll region, sized to match the toggles column (its card taken out of flow so tall content scrolls internally instead of inflating the popup).

**Tech Stack:** Static `popup.css` (no build transpilation of CSS — `build.js` copies it verbatim into `dist/`). Preact popup renders into `#app` (`src/popup/popup.jsx`). Layout verified with the `agent-browser` CLI against a synthetic harness (jsdom cannot do layout, so there is no Vitest unit test for pixel heights).

**Spec:** `docs/superpowers/specs/2026-07-17-popup-fit-within-cap-design.md`

> **Revision v2 (2026-07-17):** dogfood showed the Experimental easter-egg is
> commonly unlocked, so `toggles + chrome ≈ 628px` > Chrome's 600px cap; the
> v1 last-resort `#app { overflow-y: auto }` scrolled the whole popup and pushed
> the footer/version off-screen. Final design pins header + banner + footer and
> scrolls only the settings area — `#app { overflow: hidden }`,
> `#mainContent`/`.content-row` become `flex: 1 1 auto; min-height: 0`, and
> `.content-col-toggles` gains `overflow-y: auto`. See the spec's "Approach"
> (Revision v2) for the authoritative final CSS; Step 3 below shows the v1
> deltas — apply the v2 values from the spec.

## Global Constraints

- **CSS-only change.** No storage keys, no JS, no behavior changes, no new browser features (standard flexbox + absolute positioning; no `:has()`). — from spec.
- **Rebuild `dist/` after the change** (`npm run build`) and tell the user to reload the extension — the loaded extension runs `dist/`, tests run `src/`. — repo convention.
- **One commit for the whole run**; commit only when the user asks. No branches/worktrees. No `Co-Authored-By: Claude` trailer. — owner preferences.
- **Dogfood on an internal org only.** Never a customer org; never surface customer names or data. — owner constraint.
- **Chrome popup cap = 600px** (hardcoded). Target: popup content height ≤ 600px in all cases except the genuinely-too-tall combo (Experimental unlocked + lock banner), which degrades to a clean outer scroll. — from spec.

---

### Task 1: Height-capped flex shell + MDH-panel scroll region

**Files:**
- Modify: `src/popup/popup.css` (regions: `body`/`.content-row`/`.content-col-mdh`/`.content-col-toggles` block ~lines 44–110; `body.popup-wide .mdh-card` ~line 104; `.mdh-body` ~line 666)
- Verify (scratchpad, not committed): a harness HTML that links the real `src/popup/popup.css`, driven by `agent-browser`.

**Interfaces:**
- Consumes: the existing popup DOM shape — `body > #app > (.accent-bar, header.header, #mainContent, footer.footer)`; and in the Rossum wide layout `#mainContent > (.content-row > (.content-col-mdh > section.mdh-card > (.section-title, .mdh-filter, .mdh-body)), .content-col-toggles), .reviewing-lock-banner`. Do not change any JSX.
- Produces: a popup whose measured content height is ≤ 600px (no outer scroll) in every scenario except Experimental-unlocked + banner, where it outer-scrolls cleanly with no element overlap.

- [ ] **Step 1: Write the verification harness (the "failing test")**

Create `<scratchpad>/popup-verify.html` that links the REAL stylesheet (no override styles) and renders a representative Rossum wide popup with a tall MDH panel and the lock banner. Use only synthetic/placeholder text (no customer data).

```html
<!DOCTYPE html><html><head><meta charset="utf-8">
<link href="popup.css" rel="stylesheet"></head>
<body class="popup-wide"><div id="app">
  <div class="accent-bar"></div>
  <header class="header"><div class="brand-badge">SA</div><span class="brand-name">Rossum SA</span>
    <div class="header-actions"><button class="mdh-btn"><span>Master Data Hub</span></button>
    <button class="console-btn"><span>Rossum Console</span></button></div></header>
  <div id="mainContent">
    <div class="content-row">
      <div class="content-col content-col-mdh"><section class="card mdh-card">
        <h3 class="section-title"><span>MDH on this screen <span class="beta-badge">beta</span></span></h3>
        <input type="search" class="mdh-filter" placeholder="Filter by target schema ID">
        <div class="mdh-body" id="mdhBody"></div></section></div>
      <div class="content-col content-col-toggles">
        <section class="card"><h3 class="section-title">Rossum</h3>
          <div class="toggle-group" id="g1"><span class="group-label">Overlays</span></div>
          <div class="toggle-group" id="g2"><span class="group-label">Behavior</span></div>
          <div class="toggle-group toggle-group--cols-2" id="g3"><span class="group-label">Developer</span></div></section>
        <div class="card-row"><section class="card"><h3 class="section-title">NetSuite</h3><div id="ns"></div></section>
          <section class="card"><h3 class="section-title">Coupa <span class="beta-badge">beta</span></h3><div id="cp"></div></section></div>
      </div>
    </div>
    <div class="reviewing-lock-banner" id="banner"><div class="rlb-row">
      <span class="rlb-icon"><svg width="13" height="14" viewBox="0 0 12 13" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="1.5" y="5.5" width="9" height="6.2" rx="1.4"/><path d="M3.6 5.2V4a2.4 2.4 0 0 1 4.8 0v1.2"/></svg></span>
      <div class="rlb-text"><span class="rlb-title">Document locked by Alex Reviewer</span><span class="rlb-sub">Read-only while they review</span></div>
      <button class="rlb-release">Unlock</button></div></div>
  </div>
  <footer class="footer"><span class="version">abc1234</span><a class="footer-link" href="#">Support &amp; feedback</a></footer>
</div></div>
<script>
const T=(l,h,b)=>`<label class="toggle"><input type="checkbox"><span class="toggle-track"></span><span class="toggle-label">${l}${b?' <span class="beta-badge">beta</span>':''}<span class="toggle-hint">${h}</span></span></label>`;
g1.innerHTML+=T('Schema IDs','Overlay schema_id on annotation fields')+T('Resource IDs','Overlay IDs on queues, hooks, extensions, users');
g2.innerHTML+=T('Expand formulas','Auto-open formula source code')+T('Expand reasoning','Auto-open reasoning field options')+T('Sidebar scroll lock','Keep annotation sidebar scroll position');
g3.innerHTML+=T('Dev features','devFeaturesEnabled')+T('Dev debug','devDebugEnabled');
ns.innerHTML=T('Field names','Show field IDs on form labels'); cp.innerHTML=T('Field names','Show API names on form labels');
let h=''; for(let i=1;i<=6;i++) h+=`<div class="mdh-hook"><a class="mdh-hook-name">Matching hook ${i}</a><div class="mdh-cfg"><div class="mdh-cfg-name">config target field</div><div class="mdh-cfg-head"><span class="mdh-q-target">target_field_${i}</span><span class="mdh-q-arrow">→</span><span class="mdh-q-dataset">some_dataset_${i}</span></div><ul class="mdh-query-list"><li class="mdh-q"><span class="mdh-q-num">1</span><span class="mdh-q-name">query one</span><span class="mdh-q-status mdh-q-status--winner">✓</span></li></ul></div></div>`;
mdhBody.innerHTML=h;
window.__m=()=>{const app=document.getElementById('app');const q=s=>document.querySelector(s);const tog=q('.content-col-toggles').getBoundingClientRect(),ban=q('#banner').getBoundingClientRect(),foot=q('.footer').getBoundingClientRect(),body=q('.mdh-body');
return JSON.stringify({contentH:app.scrollHeight,appH:Math.round(app.getBoundingClientRect().height),outerScrollPx:Math.max(0,app.scrollHeight-app.clientHeight),mdhScrolls:body.scrollHeight>body.clientHeight+1,togBannerOverlap:Math.max(0,Math.round(tog.bottom-ban.top)),banFootOverlap:Math.max(0,Math.round(ban.bottom-foot.top))});};
</script></body></html>
```

- [ ] **Step 2: Run the harness against the CURRENT css — confirm it FAILS (overflows)**

```bash
cp src/popup/popup.css <scratchpad>/popup.css
agent-browser open "file://<scratchpad>/popup-verify.html"
agent-browser eval "window.__m()"
```
Expected: `contentH` ≈ **693** (> 600) — the current outer-scroll bug reproduced. (The `#app` in this harness has no cap yet, so `contentH` = natural height.)

- [ ] **Step 3: Apply the CSS changes to `src/popup/popup.css`**

3a. In the `body` rule, keep `width: 380px` etc. Immediately AFTER the `body.popup-wide { width: 760px; }` rule, add the flex-shell block:

```css
/* ── popup shell: height-capped flex column (never outer-scroll under Chrome's
   600px cap; the MDH panel scrolls internally instead) ── */
html, body { height: auto; }
#app {
  display: flex;
  flex-direction: column;
  max-height: 600px;      /* Chrome popup cap; also the definite height that
                             makes the MDH region a flex scroll area */
  overflow-y: auto;       /* last-resort outer scroll (content genuinely too tall) */
}
.accent-bar, .header, .footer { flex: 0 0 auto; }
#app > #mainContent { flex: 0 0 auto; min-height: 0; display: flex; flex-direction: column; }
#mainContent > .content-row { flex: 0 0 auto; }
#mainContent > .reviewing-lock-banner { flex: 0 0 auto; }
```

3b. Change the `.content-col-mdh` base rule from:

```css
.content-col-mdh {
  flex: 1;
  display: none;
  max-height: 540px;
  overflow-y: auto;
  scrollbar-width: thin;
}
```
to:
```css
.content-col-mdh {
  flex: 1;
  display: none;
  position: relative;   /* positioning context for the out-of-flow card */
  overflow: hidden;
}
```

3c. Change `body.popup-wide .content-col-mdh` from:
```css
body.popup-wide .content-col-mdh {
  display: flex;
  flex-direction: column;
}
```
to:
```css
body.popup-wide .content-col-mdh {
  display: block;
}
```

3d. Move the scrollbar rules from `.content-col-mdh` to `.mdh-body`. Replace:
```css
.content-col-mdh::-webkit-scrollbar { width: 8px; }
.content-col-mdh::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
.content-col-mdh::-webkit-scrollbar-thumb:hover { background: var(--text-hint); }
```
with:
```css
.mdh-body::-webkit-scrollbar { width: 8px; }
.mdh-body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
.mdh-body::-webkit-scrollbar-thumb:hover { background: var(--text-hint); }
```

3e. Change `body.popup-wide .mdh-card` from:
```css
body.popup-wide .mdh-card {
  margin: 10px 0 0 14px;
  flex: 1;
  display: flex;
  flex-direction: column;
}
```
to (out of flow, filling the column minus the original margin):
```css
body.popup-wide .mdh-card {
  position: absolute;
  inset: 10px 0 0 14px;   /* was margin: 10px 0 0 14px */
  margin: 0;
  display: flex;
  flex-direction: column;
}
```

3f. In the `.mdh-body` rule, add `overflow-y: auto; scrollbar-width: thin;`. From:
```css
.mdh-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
```
to:
```css
.mdh-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: thin;
}
```

- [ ] **Step 4: Re-run the harness against the EDITED css — confirm it PASSES**

Add `#app { max-height: 600px }` is already in the edited CSS, so re-copy and re-measure. To exercise the scenarios, drive the harness with tweaks via `agent-browser eval` (toggle `#banner` display, add an Experimental group, vary hook count).

```bash
cp src/popup/popup.css <scratchpad>/popup.css
agent-browser open "file://<scratchpad>/popup-verify.html"
agent-browser eval "window.__m()"
```
Expected (tall MDH + banner): `contentH` ≤ **~558**, `outerScrollPx` = **0**, `mdhScrolls` = **true**, `togBannerOverlap` = **0**, `banFootOverlap` = **0**.

Then verify the edge case by adding an Experimental toggle group (toggles ≈ 477px) and re-measuring:
```bash
agent-browser eval "(()=>{const c=document.querySelector('.content-col-toggles > .card');const d=document.getElementById('g3');const e=document.createElement('div');e.className='toggle-group';e.innerHTML='<span class=\"group-label\">Experimental</span><label class=\"toggle\"><input type=\"checkbox\"><span class=\"toggle-track\"></span><span class=\"toggle-label\">Annotate for me <span class=\"beta-badge\">beta</span><span class=\"toggle-hint\">Fabry applies value/box corrections to the open document (writes; undoable)</span></span></label>';c.insertBefore(e,d);return window.__m();})()"
```
Expected: `appH` = **600**, `outerScrollPx` ≈ **28** (clean), `togBannerOverlap` = **0**, `banFootOverlap` = **0**. Close the browser: `agent-browser close --all`.

- [ ] **Step 5: Run the unit suite (must stay green)**

```bash
npm test
```
Expected: PASS (popup tests are logic-only — `popup-reviewing-lock*`, `popup-tab-readers`, `popup-cache`, etc.; a CSS change does not affect them).

- [ ] **Step 6: Rebuild the extension**

```bash
npm run build
```
Expected: clean build; `dist/popup/popup.css` reflects the edit (`grep -c 'max-height: 600px' dist/popup/popup.css` → ≥ 1).

- [ ] **Step 7: Dogfood the real extension (internal org only)**

Load `dist/` in Chrome (see `reference_extension_dogfood_agent_browser` recipe: `--profile "Profile 1" --extension dist`), open a Rossum **internal** org, open an annotation so the MDH panel populates, open the popup, and confirm: no outer popup scrollbar, the MDH list scrolls internally, and header/toggles/footer stay put. (The no-banner tall-MDH case alone reproduces the pre-fix >600px overflow, so the two-user lock state is not required to confirm the fit.) Do not capture or surface any customer data.

- [ ] **Step 8: Commit (only on the user's go-ahead; one commit for the run)**

```bash
git add src/popup/popup.css docs/superpowers/specs/2026-07-17-popup-fit-within-cap-design.md docs/superpowers/plans/2026-07-17-popup-fit-within-cap.md
git commit -m "fix: keep the popup within Chrome's 600px cap (MDH panel scrolls internally)"
```

## Self-Review

- **Spec coverage:** flex-shell (3a) ✓; MDH-as-scroll-region (3b–3f) ✓; pinned header/banner/footer (3a) ✓; scrollbar relocation (3d) ✓; measured outcomes reproduced (Steps 4) ✓; unit suite + build + dogfood (Steps 5–7) ✓; backward-compat (CSS-only, narrow layout untouched — no rule added targets the narrow popup) ✓.
- **Placeholder scan:** none — every step has exact CSS and commands.
- **Type/selector consistency:** selectors used (`#app`, `#mainContent`, `.content-row`, `.content-col-mdh`, `.content-col-toggles`, `.mdh-card`, `.mdh-body`, `.reviewing-lock-banner`) all match the existing JSX in `App.jsx` / `MdhProvenancePanel.jsx`.
