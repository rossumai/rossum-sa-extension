// src/training/track.js
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
// step.anchor → { hrefIncludes } only. Hrefs are a verified contract; CSS
//               classes are not. No anchor ⇒ no arrow, never a blocked step.

export const TRACK = {
  id: 'partner-foundations',
  version: 1,
  title: 'Partner foundations',
  missions: [
    {
      id: 'm1',
      title: 'Orientation',
      blurb: 'Find your way around: where documents live, and what a queue and an annotation are.',
      steps: [
        { id: 'm1.s1', kind: 'visit', target: { type: 'organization' },
          anchor: { hrefIncludes: '/documents' },
          hint: 'Open the all-documents dashboard.',
          teach: 'The dashboard is every document in the organization, across all queues. Start here when you have no idea where a document ended up.' },
        { id: 'm1.s2', kind: 'visit', target: { type: 'queue', detail: true },
          anchor: { hrefIncludes: '/queues/' },
          hint: 'Open any queue.',
          teach: 'A **queue** is where documents land and where almost all configuration hangs: the schema, the extensions that run, the automation settings.' },
        { id: 'm1.s3', kind: 'visit', target: { type: 'annotation', detail: true },
          hint: 'Open any document from that queue.',
          teach: 'The document you opened is an **annotation** — the extracted data plus its position on the page. The id in the URL is the annotation id, not the document id.' },
        { id: 'm1.s4', kind: 'self',
          hint: "Find a field's schema_id using the extension's overlay.",
          teach: 'Turn on **Schema ID overlays** in this extension\'s popup, then look at a field on the annotation screen. Every field has a `schema_id` — the name you use everywhere in configuration.' },
      ],
    },
    {
      id: 'm2',
      title: 'Queues & schema',
      blurb: 'The schema is the contract between the document and everything downstream.',
      steps: [
        // detail:false is load-bearing — the queue Fields tab resolves to a
        // schema descriptor with NO id, while Field Manager's detail route
        // carries one. Without it this step would also tick on m2.s3's page.
        { id: 'm2.s1', kind: 'visit', target: { type: 'schema', detail: false },
          hint: "Open a queue's Fields tab.",
          teach: 'The **Fields** tab edits that queue\'s schema: sections, fields, and their `schema_id`s.' },
        { id: 'm2.s2', kind: 'api', check: 'schemaFieldAdded',
          hint: 'Add a field to that schema.',
          teach: 'Add any field. We confirm it by reading the schema and comparing the field **count** against a snapshot taken when this mission started — so a schema that already had the field does not count.' },
        { id: 'm2.s3', kind: 'visit', target: { type: 'schema', detail: true },
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
      blurb: 'Extensions are how an implementation gets its behaviour.',
      steps: [
        { id: 'm3.s1', kind: 'visit', target: { type: 'hook', detail: false },
          anchor: { hrefIncludes: '/extensions/my-extensions' },
          hint: 'Open the Extensions list.',
          teach: 'Every extension in the organization, whether it is a serverless function or a webhook.' },
        { id: 'm3.s2', kind: 'visit', target: { type: 'hook', detail: true },
          hint: 'Open any extension and read its trigger events.',
          teach: 'The **events** decide when the extension runs — on upload, on validation, on export. Getting the event wrong is the most common reason an extension "does nothing".' },
        { id: 'm3.s3', kind: 'api', check: 'hookAttachedToQueue',
          hint: 'Attach an extension to a queue.',
          teach: 'An extension only runs on the queues it is attached to. We confirm a **new** extension-to-queue link appeared since this mission started.' },
        { id: 'm3.s4', kind: 'self',
          hint: 'Find that extension\'s execution log.',
          teach: 'The log shows each run and its output. Log access depends on your role, so this step is yours to confirm.' },
        { id: 'm3.s5', kind: 'visit', target: { type: 'queue', detail: true },
          hint: 'Go back to the queue you attached it to.',
          teach: 'Close the loop: the queue is where you verify the extension is listed.' },
      ],
    },
    {
      id: 'm4',
      title: 'Automation & rules',
      blurb: 'What makes a document skip human review — and what stops it.',
      steps: [
        { id: 'm4.s1', kind: 'visit', target: { type: 'engine', detail: true },
          hint: 'Open an AI engine.',
          teach: 'The **engine** does the extraction. A queue is bound to either a generic or a dedicated engine.' },
        { id: 'm4.s2', kind: 'api', check: 'ruleCreated',
          hint: 'Create a rule.',
          teach: 'A **rule** fires on a condition and takes actions — raising a message, blocking automation. We confirm a rule id exists that did not when this mission started.' },
        { id: 'm4.s3', kind: 'api', check: 'thresholdChanged',
          hint: "Change a queue's score threshold.",
          teach: 'The **score threshold** decides how confident extraction must be before a field passes without review. We confirm the value moved on a queue that already existed.' },
        { id: 'm4.s4', kind: 'self',
          hint: 'Confirm a document.',
          teach: 'Confirming pushes the annotation to the next stage. Whether you can depends on your role and on there being a document to confirm.' },
      ],
    },
    {
      id: 'm5',
      title: 'Master data',
      blurb: 'Matching extracted values against the customer\'s own data.',
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
