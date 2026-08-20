// src/training/track.ts
// DATA ONLY — no logic lives here, and no data lives in steps.js. Editing the
// syllabus must never require touching evaluation.
//
// step.kind:
//   'visit' → target: { type, detail? } matched via detectResource()
//   'api'   → check: a CHECKS id in steps.js, passing on a delta vs the
//             mission-start baseline
//   'self'  → the trainee attests; printed on the receipt as self-attested
// step.hint   → ONE plain-text line, rendered with textContent in the card
// step.teach  → markdown, rendered in the Academy
// step.anchor → { cy?, hrefIncludes? } only — either or both. `cy` matches a
//               `data-cy` attribute (Rossum's durable hook for non-link
//               controls); `hrefIncludes` matches a real `a[href]` substring.
//               Both are verified contracts; CSS classes are not, and are
//               never matched on. No anchor ⇒ no tether, never a blocked step.
//
// EVERY `cy` value below was READ OFF THE LIVE SCREEN it belongs to (2026-08-14,
// elis) — never inferred from a sibling. That distinction is load-bearing: the
// values do NOT follow one scheme. Queue-settings tabs are
// `queue-settings-header-tab-<name>` but the Automation-section tabs are
// `tab-automation.<camelCase>` (a dot, escaped by `cssEscape` — live-checked,
// not assumed); the Extensions list uses `extensions-*` while Field Manager
// uses `fm-*`. Guessing the next one from the last one WILL produce a selector
// that silently never resolves, which reads as "the tether is broken" rather
// than as a typo. Re-harvest, don't extrapolate.
//
// The anchor points at the control that PERFORMS the step, not at a wayfinding
// hop — the hint line already names the destination — except where the step IS
// the navigation (m1.s1, m3.s1), where they are the same control.

/** How a step is verified. `self` is the only kind the Academy may mark. */
export type StepKind = 'visit' | 'api' | 'self';

/** Where the tether points. `cy` matches a data-cy attribute, `hrefIncludes` a real a[href]. */
export type StepAnchor = { cy?: string; hrefIncludes?: string };

export type TrackStep = {
  id: string;
  kind: StepKind;
  /** ONE plain-text line, rendered with textContent in the quest card. */
  hint: string;
  /** Markdown, rendered in the Academy. */
  teach?: string;
  /** `visit` steps: matched via detectResource(). */
  /** `detail: true` means "any detail page of this type"; a string matches that one. */
  target?: { type: string; detail?: string | boolean };
  /** `api` steps: a CHECKS id in steps.js. */
  check?: string;
  anchor?: StepAnchor;
};

export type Mission = { id: string; title: string; blurb: string; steps: TrackStep[] };

export type Track = { id: string; version: number; title: string; missions: Mission[] };

export const TRACK: Track = {
  id: 'partner-foundations',
  version: 1,
  title: 'Partner foundations',
  missions: [
    {
      id: 'm1',
      title: 'Orientation',
      blurb: 'Navigate documents, queues and annotations with confidence',
      steps: [
        { id: 'm1.s1', kind: 'visit', target: { type: 'organization' },
          anchor: { cy: 'all-documents-sidebar', hrefIncludes: '/documents' },
          hint: 'Open the all-documents dashboard.',
          teach: 'The dashboard is every document in the organization, across all queues. Start here when you have no idea where a document ended up.' },
        // `sidebar-queue` first: the href fallback matches the queue's SETTINGS
        // gear (`/queues/<id>/settings/basic`, the only `/queues/` link on the
        // dashboard), which is a different destination than the step asks for.
        { id: 'm1.s2', kind: 'visit', target: { type: 'queue', detail: true },
          anchor: { cy: 'sidebar-queue', hrefIncludes: '/queues/' },
          hint: 'Open any queue.',
          teach: 'A **queue** is where documents land and where almost all configuration hangs: the schema, the extensions that run, the automation settings.' },
        // `file-name`, not `document-row`: the row is a horizontally scrollable
        // element ~4263px wide, so a tether to it can only point at whatever
        // its clipped middle happens to be — a column boundary. The file name
        // is the thing a trainee actually clicks, and it is a small rect.
        { id: 'm1.s3', kind: 'visit', target: { type: 'annotation', detail: true },
          anchor: { cy: 'file-name' },
          hint: 'Open any document from that queue.',
          teach: 'The document you opened is an **annotation** — the extracted data plus its position on the page. The id in the URL is the annotation id, not the document id.' },
        { id: 'm1.s4', kind: 'self',
          anchor: { cy: 'annotation-sidebar-datapoint' },
          hint: "Find a field's schema_id using the extension's overlay.",
          teach: 'Turn on **Schema ID overlays** in this extension\'s popup, then look at a field on the annotation screen. Every field has a `schema_id` — the name you use everywhere in configuration.' },
      ],
    },
    {
      id: 'm2',
      title: 'Queues & schema',
      blurb: 'Shape what a queue captures, and know where every field lives',
      steps: [
        // detail:false is load-bearing — the queue Fields tab resolves to a
        // schema descriptor with NO id, while Field Manager's detail route
        // carries one. Without it this step would also tick on m2.s3's page.
        { id: 'm2.s1', kind: 'visit', target: { type: 'schema', detail: false },
          anchor: { cy: 'queue-settings-header-tab-fields' },
          hint: "Open a queue's Fields tab.",
          teach: 'The **Fields** tab edits that queue\'s schema: sections, fields, and their `schema_id`s.' },
        { id: 'm2.s2', kind: 'api', check: 'schemaFieldAdded',
          anchor: { cy: 'add-field-button' },
          hint: 'Add a field to that schema.',
          teach: 'Add any field. We confirm it by reading the schema and comparing the field **count** against a snapshot taken when this mission started — so a schema that already had the field does not count.' },
        // Field Manager renders 1481 elements but only four distinct data-cy
        // values, none per-field — so the anchor is the link INTO it, and the
        // step goes unanchored once you are already there.
        { id: 'm2.s3', kind: 'visit', target: { type: 'schema', detail: true },
          anchor: { hrefIncludes: '/settings/field-manager' },
          hint: 'Open the same field in Field Manager.',
          teach: 'Field Manager is the org-wide view of fields, as opposed to the per-queue Fields tab.' },
        { id: 'm2.s4', kind: 'self',
          hint: 'Find a formula field and read its formula.',
          teach: 'A **formula field** computes its value from other fields. Formulas are the first tool to reach for before writing an extension.' },
      ],
    },
    {
      id: 'm3',
      title: 'Extensions',
      blurb: 'Attach an extension and read back exactly what it changed',
      steps: [
        { id: 'm3.s1', kind: 'visit', target: { type: 'hook', detail: false },
          anchor: { cy: 'extensions-navtab', hrefIncludes: '/extensions/my-extensions' },
          hint: 'Open the Extensions list.',
          teach: 'Every extension in the organization, whether it is a serverless function or a webhook.' },
        { id: 'm3.s2', kind: 'visit', target: { type: 'hook', detail: true },
          anchor: { cy: 'extensions-table-row' },
          hint: 'Open any extension and read its trigger events.',
          teach: 'The **events** decide when the extension runs — on upload, on validation, on export. Getting the event wrong is the most common reason an extension "does nothing".' },
        { id: 'm3.s3', kind: 'api', check: 'hookAttachedToQueue',
          anchor: { cy: 'queue-multi-select' },
          hint: 'Attach an extension to a queue.',
          teach: 'An extension only runs on the queues it is attached to. We confirm a **new** extension-to-queue link appeared since this mission started.' },
        { id: 'm3.s4', kind: 'self',
          anchor: { cy: 'extensions-activities-button' },
          hint: 'Find that extension\'s execution log.',
          teach: 'The log shows each run and its output. Log access depends on your role, so this step is yours to confirm.' },
        { id: 'm3.s5', kind: 'visit', target: { type: 'queue', detail: true },
          anchor: { hrefIncludes: '/queues/' },
          hint: 'Go back to the queue you attached it to.',
          teach: 'Close the loop: the queue is where you verify the extension is listed.' },
      ],
    },
    {
      id: 'm4',
      title: 'Automation & rules',
      blurb: 'Tune a confidence threshold and write a rule that fires',
      steps: [
        { id: 'm4.s1', kind: 'visit', target: { type: 'engine', detail: true },
          anchor: { cy: 'tab-automation.aiEngines' },
          hint: 'Open an AI engine.',
          teach: 'The **engine** does the extraction. A queue is bound to either a generic or a dedicated engine.' },
        { id: 'm4.s2', kind: 'api', check: 'ruleCreated',
          anchor: { cy: 'add-rule-button' },
          hint: 'Create a rule.',
          teach: 'A **rule** fires on a condition and takes actions — raising a message, blocking automation. We confirm a rule id exists that did not when this mission started.' },
        { id: 'm4.s3', kind: 'api', check: 'thresholdChanged',
          anchor: { cy: 'automation-level-confident' },
          hint: "Change a queue's score threshold.",
          teach: 'The **score threshold** decides how confident extraction must be before a field passes without review. We confirm the value moved on a queue that already existed.' },
        { id: 'm4.s4', kind: 'self',
          anchor: { cy: 'confirm-annotation-btn' },
          hint: 'Confirm a document.',
          teach: 'Confirming pushes the annotation to the next stage. Whether you can depends on your role and on there being a document to confirm.' },
      ],
    },
    {
      id: 'm5',
      title: 'Master data',
      blurb: 'Match extracted values against your own reference data',
      steps: [
        { id: 'm5.s1', kind: 'self',
          hint: "Open Dataset Management from this extension's popup.",
          teach: 'Dataset Management browses **Data Storage** collections — the master data an implementation matches against.' },
        { id: 'm5.s2', kind: 'api', check: 'collectionAdded',
          hint: 'Create a collection.',
          teach: 'We confirm the collection **count** grew. Collection names are never recorded — only how many there are.' },
        { id: 'm5.s3', kind: 'self',
          hint: 'Run a query against your collection.',
          teach: 'Queries are MongoDB aggregation pipelines. This is exactly how a matching extension looks data up at runtime.' },
      ],
    },
  ],
};
