export function quickMatch(rec, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  const c = rec?.content || {};
  const hay = [
    rec.action, rec.object_type, rec.username,
    rec.object_id, rec.organization_id, rec.timestamp,
    c.method, c.path, c.request_id, c.status_code,
  ].map((v) => (v == null ? '' : String(v).toLowerCase())).join(' ');
  return hay.includes(needle);
}
