// Starter prompts for the new-chat greeting. Curated to investigations the
// agent's server-side toolset demonstrably handles well (workspaces/queues,
// hooks + hook logs, rules, schemas, annotation search, Data Storage reads).
// Deliberately NO audit-log prompts — the agent has no audit-log tool
// (spike-verified), so such a starter would fail its very first users.
// `label`/`desc` are what the card shows; `prompt` is what gets sent.
/** `label`/`desc` are what the card shows; `prompt` is what gets sent. */
export type Starter = { label: string; desc: string; prompt: string };

export const STARTERS: Starter[] = [
  {
    label: 'Map this organization',
    desc: 'Workspaces, queues, and what each is for',
    prompt:
      'Give me an overview of this organization: list the workspaces and queues, and explain what each queue is set up to do.',
  },
  {
    label: 'Check extension health',
    desc: 'Find failing hooks and recent errors',
    prompt:
      'List the extensions in this organization and check their recent logs for failures or errors. Summarize anything that needs attention.',
  },
  {
    label: 'Find documents needing attention',
    desc: 'Stuck, postponed, or failed annotations',
    prompt:
      'Find documents that need attention — stuck in review, postponed, or failed — and explain what is blocking each of them.',
  },
  {
    label: "Review a queue's setup",
    desc: 'Schema, automation, rules, extensions',
    prompt:
      'Pick the busiest queue in this organization and explain its full setup: schema fields, automation settings, business rules, and connected extensions.',
  },
];
