// Autonomous, bounded, dynamic-fix_plan implement loop for Architect deliverables
// (ghuntley "one thing per loop"). Pure: transport injected (planOne / implementTaskOne /
// checkTaskOne / checkDeliverable); state streams via onEvent(id, patch). Sequential
// across deliverables (org writes must not race). No network/DOM. See
// docs/superpowers/specs/2026-07-14-architect-implement-loop-design.md.

/** One unit of work in the fix_plan. `origin` says whether it was planned, discovered or remediation. */
export type ImplementTask = {
  id: string;
  text: string;
  acceptance: string;
  status: 'pending' | 'doing' | 'done' | 'failed';
  attempts: number;
  origin: 'plan' | 'discovered' | 'remediation';
};

/** Everything the loop needs injected — it does no network or DOM work itself. */
export type ImplementDeps = {
  planOne: (d: any) => Promise<any>;
  implementTaskOne: (d: any, task: ImplementTask, ctx: any) => Promise<any>;
  checkTaskOne: (d: any, task: ImplementTask) => Promise<any>;
  checkDeliverable: (d: any) => Promise<any>;
  /** Streams state per deliverable. The glue PERSISTS what it receives. */
  onEvent?: (id: string, patch: Record<string, any>) => void;
  maxAttemptsPerTask?: number;
  maxPlanTasks?: number;
  maxTotalTasks?: number;
  maxTotalWrites?: number;
  maxRollupRounds?: number;
  signal?: AbortSignal | null;
};

export async function runImplement(deliverables: any[], {
  planOne, implementTaskOne, checkTaskOne, checkDeliverable, onEvent = () => {},
  maxAttemptsPerTask = 5, maxPlanTasks = 12, maxTotalTasks = 20, maxTotalWrites = 50, maxRollupRounds = 3,
  signal,
}: ImplementDeps = {} as ImplementDeps) {
  let totalWrites = 0;
  let seq = 0;
  const aborted = () => signal && signal.aborted;
  const mkTask = (t: any, origin: ImplementTask['origin']): ImplementTask => ({ id: 'k' + (++seq), text: t.text, acceptance: t.acceptance || '', status: 'pending', attempts: 0, origin });
  const dup = (tasks: ImplementTask[], text: unknown) => tasks.some((t) => t.text.trim().toLowerCase() === String(text).trim().toLowerCase());
  // Abort is signalled two ways by the injected transport: signal.aborted flips, and
  // an aborted turn resolves to `null`. Both funnel through a thrown sentinel so the
  // per-deliverable catch can emit a terminal `stopped` patch (which the glue PERSISTS)
  // instead of leaving the deliverable stuck at 'planning'/'running' with its write
  // audit unsaved. See findings actions.js:361 / actions.js:396.
  const ABORT = Symbol('abort');
  const ck = () => { if (aborted()) throw ABORT; };

  for (const d of deliverables) {
    if (aborted()) return; // between deliverables: prior ones already emitted their terminal — just stop
    if (totalWrites >= maxTotalWrites) { onEvent(d.id, { status: 'blocked', error: 'Write budget reached.', done: true }); continue; }

    let tasks: ImplementTask[] = [];
    const journal = []; // deliverable-level learnings journal (persisted, capped by the glue)
    try {
      onEvent(d.id, { status: 'planning' });
      let planned; let planError = null;
      try { planned = await planOne(d); } catch (err) { planError = (err as Error)?.message || String(err); planned = null; }
      ck();
      if (planError != null) { onEvent(d.id, { status: 'failed', error: `Planning failed: ${planError}`, done: true }); continue; }
      if (planned == null) throw ABORT; // null WITHOUT an error = the abort-signalling convention
      // An EMPTY plan means the agent judged the deliverable already satisfied
      // ("only include tasks that are NOT already satisfied"). Do NOT fabricate a
      // whole-deliverable WRITE task — go straight to the read-only roll-up, which
      // confirms it (pass) or triggers read-only remediation (fail). See finding
      // implementLoop.js:28.
      tasks = planned.slice(0, maxPlanTasks).map((t: any) => mkTask(t, 'plan'));
      onEvent(d.id, { status: 'running', tasks: tasks.slice() });

      let status = 'failed';
      let rounds = 0;
      for (;;) {
        // ---- task loop ----
        let task;
        while ((task = tasks.find((t) => t.status === 'pending'))) {
          ck();
          if (totalWrites >= maxTotalWrites) { status = 'blocked'; break; }
          task.status = 'doing'; onEvent(d.id, { tasks: tasks.slice() });
          const taskJournal = [];
          for (let attempt = 1; attempt <= maxAttemptsPerTask; attempt++) {
            ck();
            task.attempts = attempt;
            const doneTasks = tasks.filter((t) => t.status === 'done').map((t) => t.text);
            let impl;
            try { impl = await implementTaskOne(d, task, { attempt, journal: taskJournal, doneTasks }); }
            catch (err) { impl = { writes: (err && (err as any).writes) || [], summary: `Task attempt failed: ${(err as Error)?.message || err}`, discovered: [] }; }
            if (impl == null) throw ABORT;
            // Count + surface writes FIRST — BEFORE the abort check — so a write the
            // agent already executed in an interrupted/errored turn is still audited
            // and counted against the budget. Dropping it would defeat the write
            // audit exactly when it matters. See finding actions.js:322.
            totalWrites += (impl.writes ? impl.writes.length : 0);
            onEvent(d.id, { writes: impl.writes || [] });
            ck();
            for (const disc of (impl.discovered || [])) {
              if (tasks.length >= maxTotalTasks) { onEvent(d.id, { note: `Task cap (${maxTotalTasks}) reached — dropped discovered task: ${disc.text}` }); break; }
              if (disc.text && !dup(tasks, disc.text)) tasks.push(mkTask(disc, 'discovered'));
            }
            onEvent(d.id, { tasks: tasks.slice() });
            let v, checkErrored = false;
            try { v = await checkTaskOne(d, task); }
            catch (err) { v = { verdict: 'uncertain', evidence: `Check could not complete: ${(err as Error)?.message || err}`, chatId: null }; checkErrored = true; }
            if (v == null) throw ABORT;
            ck();
            if (v.verdict === 'pass') { task.status = 'done'; onEvent(d.id, { summary: impl.summary }); break; }
            if (checkErrored) { task.status = 'failed'; break; }
            const entry: Record<string, any> = { attempt, summary: impl.summary || '', verdict: v.verdict, learnings: v.evidence || '' };
            taskJournal.push(entry); journal.push(entry);
            if (totalWrites >= maxTotalWrites) break;
          }
          if (task.status === 'doing') task.status = 'failed';
          onEvent(d.id, { tasks: tasks.slice() });
        }
        // ---- roll-up ----
        ck();
        if (status === 'blocked' || totalWrites >= maxTotalWrites) { status = 'blocked'; break; }
        let rollup; let rollupErrored = false;
        try { rollup = await checkDeliverable(d); }
        catch (err) { rollup = { verdict: 'uncertain', evidence: `Roll-up check could not complete: ${(err as Error)?.message || err}`, chatId: null }; rollupErrored = true; }
        if (rollup == null) throw ABORT;
        ck();
        // verdictErrored lets the glue persist a real roll-up verdict but NOT a
        // transport-errored one (preserve last-known-good, as the standalone check does).
        onEvent(d.id, { verdict: rollup, verdictErrored: rollupErrored });
        if (rollup.verdict === 'pass') { status = 'passing'; break; }
        if (rollupErrored) { status = 'uncertain'; break; } // transient gate error → do NOT spend a remediation round / more writes
        rounds += 1;
        if (rounds >= maxRollupRounds) { status = 'failed'; break; }
        let remedy;
        try { remedy = await planOne(d); } catch { remedy = []; }
        if (remedy == null) throw ABORT; // null resolve = abort convention
        ck();
        const fresh = remedy.filter((t: any) => t.text && !dup(tasks, t.text));
        if (!fresh.length) { status = 'failed'; break; }
        for (const t of fresh) {
          if (tasks.length >= maxTotalTasks) { onEvent(d.id, { note: `Task cap (${maxTotalTasks}) reached — dropped remediation task: ${t.text}` }); break; }
          tasks.push(mkTask(t, 'remediation'));
        }
        onEvent(d.id, { tasks: tasks.slice() });
      }
      onEvent(d.id, { status, done: true, tasks: tasks.slice(), journal: journal.slice() });
    } catch (e) {
      if (e === ABORT) {
        // Emit a terminal `stopped` patch so the current deliverable freezes at an
        // honest terminal state AND its accumulated writes/tasks are persisted (the
        // done branch of the glue saves on any terminal), then stop the whole run.
        onEvent(d.id, { status: 'stopped', done: true, tasks: tasks.slice(), journal: journal.slice() });
        return;
      }
      throw e;
    }
  }
}
