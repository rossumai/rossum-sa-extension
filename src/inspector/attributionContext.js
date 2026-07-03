// Assemble the read-only context the attribution agent reasons over. The agent has
// its OWN read-only Rossum tools (get/search over hooks incl. code, annotations, hook
// logs, rules — verified live), so we do NOT fetch code/logs/field values here. We pass
// the annotation + queue ids, the finding target, and a COMPACT candidate list
// (id/name/type/events) and let the agent fetch the details it needs.
const idFromUrl = (url) => { const m = String(url || '').match(/\/(\d+)\/?$/); return m ? m[1] : null; };

// Compact active-queue-hook list — identity only, no code fetch. From resolved.hooksById
// (populated at prefetch), else a cheap 403-tolerant listHooks. Never throws.
async function queueHookList(api, d) {
  let hooks = Object.values(d.resolved?.hooksById || {});
  if (hooks.length === 0 && d.annotation?.queue) {
    hooks = (await api.listHooks(idFromUrl(d.annotation.queue)).catch(() => [])) || [];
  }
  return hooks
    .filter((hk) => hk && hk.active !== false)
    .map((hk) => ({ id: hk.id, name: hk.name, type: hk.type, events: hk.events || [] }));
}

// Annotation reference the agent needs to fetch the rest with its tools.
function annotationRef(d) {
  const a = (d && d.annotation) || {};
  return { id: a.id, status: a.status, queueId: idFromUrl(a.queue) };
}

export async function gatherRejectContext({ api, store, reason = null }) {
  try {
    const d = store.data.value;
    const candidates = d ? await queueHookList(api, d) : [];
    return { annotation: annotationRef(d), target: { rejectedAt: d?.annotation?.rejected_at || null, reason }, candidates };
  } catch { return { annotation: {}, target: { rejectedAt: null, reason }, candidates: [] }; }
}

export async function gatherLabelContext({ api, store, labelId, labelName }) {
  try {
    const d = store.data.value;
    const candidates = d ? await queueHookList(api, d) : [];
    return { annotation: annotationRef(d), target: { id: labelId, name: labelName }, candidates };
  } catch { return { annotation: {}, target: { id: labelId, name: labelName }, candidates: [] }; }
}

export async function gatherMessageContext({ api, store, message }) {
  try {
    const d = store.data.value;
    const candidates = d ? await queueHookList(api, d) : [];
    return { annotation: annotationRef(d), target: message, candidates };
  } catch { return { annotation: {}, target: message, candidates: [] }; }
}

export async function gatherBlockerContext({ api, store, blocker }) {
  try {
    const d = store.data.value;
    const candidates = d ? await queueHookList(api, d) : [];
    return { annotation: annotationRef(d), target: blocker, candidates };
  } catch { return { annotation: {}, target: blocker, candidates: [] }; }
}

export async function gatherExportContext({ api, store, error = null }) {
  try {
    const d = store.data.value;
    const all = d ? await queueHookList(api, d) : [];
    const exp = all.filter((h) => (h.events || []).some((e) => String(e).startsWith('annotation_content.export')));
    return { annotation: annotationRef(d), target: { error }, candidates: exp.length ? exp : all };
  } catch { return { annotation: {}, target: { error }, candidates: [] }; }
}

export async function gatherFieldsContext({ api, store }) {
  try {
    const d = store.data.value;
    const candidates = d ? await queueHookList(api, d) : [];
    return { annotation: annotationRef(d), candidates };
  } catch { return { annotation: {}, candidates: [] }; }
}
