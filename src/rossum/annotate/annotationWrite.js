// src/rossum/annotate/annotationWrite.js
// Same-origin annotation write/validate primitives. I/O via injected `post`
// (postRossumApi) so the loop is unit-testable. Writes content ONLY.
export function startAnnotation(id, { post }) { return post(`/api/v1/annotations/${id}/start`, {}); }
export function applyContentOperations(id, operations, { post }) {
  return post(`/api/v1/annotations/${id}/content/operations`, { operations }).then((r) => (r && r.content) || []);
}
export function validateContent(id, { post }) { return post(`/api/v1/annotations/${id}/content/validate`, {}); }
export function cancelAnnotation(id, { post }) { return post(`/api/v1/annotations/${id}/cancel`, {}); }
export function parseValidateMessages(res) {
  return ((res && res.messages) || []).map((m) => ({
    type: m.type, content: m.content, datapointId: m.id ?? null, schemaId: m.schema_id ?? null,
  }));
}
