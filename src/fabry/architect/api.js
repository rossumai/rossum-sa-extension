// Data Storage wrapper for the Architect system collection (v2: deliverables +
// persisted last-run results). Collection name is a single cosmetic constant —
// no code parses the `__` prefix (swappable). Docs keep kind:'requirement'.
import * as mdh from '../../mdh/api.js';

export const COLLECTION = '__mrfabry_architect';
export const JOURNAL_CAP = 10;

export async function ensureCollection() {
  try { await mdh.createCollection(COLLECTION); }
  catch (err) { if (err?.status === 401) throw err; }
}

export async function loadDeliverables() {
  const res = await mdh.find(COLLECTION, { query: { kind: 'requirement' }, sort: { order: 1 }, limit: 1000 });
  const docs = (res && res.result) || [];
  const deliverables = docs.map((d) => ({
    id: d._id, text: d.text || '', order: typeof d.order === 'number' ? d.order : 0,
    title: typeof d.title === 'string' ? d.title : '',
  }));
  const results = {};
  const implement = {};
  for (const d of docs) {
    if (d.lastVerdict) {
      results[d._id] = { verdict: d.lastVerdict, evidence: d.lastEvidence || '', chatId: d.lastChatId || null, ranAt: d.ranAt || null, stale: true };
    }
    if (d.implementStatus) {
      implement[d._id] = {
        status: d.implementStatus, attempt: d.attempts || 0,
        writes: Array.isArray(d.lastImplementWrites) ? d.lastImplementWrites : [],
        summary: d.lastImplementSummary || '', chatId: d.lastImplementChatId || null,
        journal: Array.isArray(d.implementJournal) ? d.implementJournal : [],
        tasks: Array.isArray(d.implementTasks) ? d.implementTasks : [],
        ranAt: d.implementRanAt || null, stale: true,
      };
    }
  }
  return { deliverables, results, implement };
}

export function addDeliverable({ id, text, order, createdAt }) {
  return mdh.insertOne(COLLECTION, { _id: id, kind: 'requirement', text, order, createdAt });
}
export function updateDeliverable(id, text, editedAt) {
  return mdh.updateOne(COLLECTION, { _id: id }, { $set: { text, editedAt } });
}
export function deleteDeliverable(id) {
  return mdh.deleteOne(COLLECTION, { _id: id });
}
export function saveResult(id, { verdict, evidence, chatId, ranAt }) {
  return mdh.updateOne(COLLECTION, { _id: id }, { $set: { lastVerdict: verdict, lastEvidence: evidence, lastChatId: chatId, ranAt } });
}
export function setOrder(id, order) {
  return mdh.updateOne(COLLECTION, { _id: id }, { $set: { order } });
}
export function saveTitle(id, title) {
  return mdh.updateOne(COLLECTION, { _id: id }, { $set: { title } });
}
export function saveImplementResult(id, { status, attempts, writes, summary, chatId, ranAt, journal, tasks }) {
  return mdh.updateOne(COLLECTION, { _id: id }, { $set: {
    implementStatus: status, attempts, lastImplementWrites: writes || [], lastImplementSummary: summary || '',
    lastImplementChatId: chatId || null, implementRanAt: ranAt, implementJournal: (journal || []).slice(-JOURNAL_CAP),
    implementTasks: Array.isArray(tasks) ? tasks : [],
  } });
}
