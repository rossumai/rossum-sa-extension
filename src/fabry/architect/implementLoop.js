// Autonomous, bounded, dynamic-fix_plan implement loop for Architect deliverables
// (ghuntley "one thing per loop"). Pure: transport injected (planOne / implementTaskOne /
// checkTaskOne / checkDeliverable); state streams via onEvent(id, patch). Sequential
// across deliverables (org writes must not race). No network/DOM. See
// docs/superpowers/specs/2026-07-14-architect-implement-loop-design.md.

export async function runImplement(deliverables, {
  planOne, implementTaskOne, checkTaskOne, checkDeliverable, onEvent = () => {},
  maxAttemptsPerTask = 5, maxPlanTasks = 12, maxTotalTasks = 20, maxTotalWrites = 50, maxRollupRounds = 3,
  signal,
} = {}) {
  let totalWrites = 0;
  let seq = 0;
  const aborted = () => signal && signal.aborted;
  const mkTask = (t, origin) => ({ id: 'k' + (++seq), text: t.text, acceptance: t.acceptance || '', status: 'pending', attempts: 0, origin });
  const dup = (tasks, text) => tasks.some((t) => t.text.trim().toLowerCase() === String(text).trim().toLowerCase());

  for (const d of deliverables) {
    if (aborted()) return;
    if (totalWrites >= maxTotalWrites) { onEvent(d.id, { status: 'blocked', error: 'Write budget reached.', done: true }); continue; }

    onEvent(d.id, { status: 'planning' });
    let planned; let planError = null;
    try { planned = await planOne(d); } catch (err) { planError = err?.message || String(err); planned = null; }
    if (aborted()) return;
    if (planError != null) { onEvent(d.id, { status: 'failed', error: `Planning failed: ${planError}`, done: true }); continue; }
    if (planned == null) return; // null WITHOUT an error = the abort-signalling convention
    let tasks = (planned.length ? planned : [{ text: d.text, acceptance: '' }]).slice(0, maxPlanTasks).map((t) => mkTask(t, 'plan'));
    onEvent(d.id, { status: 'running', tasks: tasks.slice() });

    let status = 'failed';
    let rounds = 0;
    for (;;) {
      // ---- task loop ----
      let task;
      while ((task = tasks.find((t) => t.status === 'pending'))) {
        if (aborted()) return;
        if (totalWrites >= maxTotalWrites) { status = 'blocked'; break; }
        task.status = 'doing'; onEvent(d.id, { tasks: tasks.slice() });
        const journal = [];
        for (let attempt = 1; attempt <= maxAttemptsPerTask; attempt++) {
          if (aborted()) return;
          task.attempts = attempt;
          const doneTasks = tasks.filter((t) => t.status === 'done').map((t) => t.text);
          let impl;
          try { impl = await implementTaskOne(d, task, { attempt, journal, doneTasks }); }
          catch (err) { impl = { writes: [], summary: `Task attempt failed: ${err?.message || err}`, discovered: [] }; }
          if (aborted()) return;
          if (impl == null) return;
          totalWrites += (impl.writes ? impl.writes.length : 0);
          onEvent(d.id, { writes: impl.writes || [] });
          for (const disc of (impl.discovered || [])) {
            if (tasks.length >= maxTotalTasks) { onEvent(d.id, { note: `Task cap (${maxTotalTasks}) reached — dropped discovered task: ${disc.text}` }); break; }
            if (disc.text && !dup(tasks, disc.text)) tasks.push(mkTask(disc, 'discovered'));
          }
          onEvent(d.id, { tasks: tasks.slice() });
          let v, checkErrored = false;
          try { v = await checkTaskOne(d, task); }
          catch (err) { v = { verdict: 'uncertain', evidence: `Check could not complete: ${err?.message || err}`, chatId: null }; checkErrored = true; }
          if (aborted()) return;
          if (v == null) return;
          if (v.verdict === 'pass') { task.status = 'done'; break; }
          if (checkErrored) { task.status = 'failed'; break; }
          journal.push({ attempt, summary: impl.summary || '', verdict: v.verdict, learnings: v.evidence || '' });
          if (totalWrites >= maxTotalWrites) break;
        }
        if (task.status === 'doing') task.status = 'failed';
        onEvent(d.id, { tasks: tasks.slice() });
      }
      // ---- roll-up ----
      if (aborted()) return;
      if (status === 'blocked' || totalWrites >= maxTotalWrites) { status = 'blocked'; break; }
      let rollup; let rollupErrored = false;
      try { rollup = await checkDeliverable(d); }
      catch (err) { rollup = { verdict: 'uncertain', evidence: `Roll-up check could not complete: ${err?.message || err}`, chatId: null }; rollupErrored = true; }
      if (aborted()) return;
      if (rollup == null) return;
      // verdictErrored lets the glue persist a real roll-up verdict but NOT a
      // transport-errored one (preserve last-known-good, as the standalone check does).
      onEvent(d.id, { verdict: rollup, verdictErrored: rollupErrored });
      if (rollup.verdict === 'pass') { status = 'passing'; break; }
      if (rollupErrored) { status = 'uncertain'; break; } // transient gate error → do NOT spend a remediation round / more writes
      rounds += 1;
      if (rounds >= maxRollupRounds) { status = 'failed'; break; }
      let remedy;
      try { remedy = await planOne(d); } catch { remedy = []; }
      if (aborted()) return;
      if (remedy == null) return; // null resolve = abort convention
      const fresh = remedy.filter((t) => t.text && !dup(tasks, t.text));
      if (!fresh.length) { status = 'failed'; break; }
      for (const t of fresh) {
        if (tasks.length >= maxTotalTasks) { onEvent(d.id, { note: `Task cap (${maxTotalTasks}) reached — dropped remediation task: ${t.text}` }); break; }
        tasks.push(mkTask(t, 'remediation'));
      }
      onEvent(d.id, { tasks: tasks.slice() });
    }
    onEvent(d.id, { status, done: true, tasks: tasks.slice() });
  }
}
