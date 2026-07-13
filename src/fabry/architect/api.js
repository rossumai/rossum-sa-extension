// Data Storage wrapper for the Architect system collection (v2: deliverables +
// persisted last-run results). Collection name is a single cosmetic constant —
// no code parses the `__` prefix (swappable). Docs keep kind:'requirement'.
import * as mdh from '../../mdh/api.js';

export const COLLECTION = '__mrfabry_architect';

export async function ensureCollection() {
  try { await mdh.createCollection(COLLECTION); }
  catch (err) { if (err?.status === 401) throw err; }
}

export async function loadDeliverables() {
  const res = await mdh.find(COLLECTION, { query: { kind: 'requirement' }, sort: { order: 1 }, limit: 1000 });
  const docs = (res && res.result) || [];
  const deliverables = docs.map((d) => ({ id: d._id, text: d.text || '', order: typeof d.order === 'number' ? d.order : 0 }));
  const results = {};
  for (const d of docs) {
    if (d.lastVerdict) {
      // Loaded from storage → always stale until re-run this session.
      results[d._id] = { verdict: d.lastVerdict, evidence: d.lastEvidence || '', chatId: d.lastChatId || null, ranAt: d.ranAt || null, stale: true };
    }
  }
  return { deliverables, results };
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
