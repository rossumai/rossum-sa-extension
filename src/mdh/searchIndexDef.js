// Transform a listed Atlas Search index into a clean, create-ready definition.
//
// The /search_indexes/list endpoint returns each index in snake_case with the
// definition nested under `latest_definition`, alongside runtime fields
// (`type`, `status`, `queryable`). The Create Search Index modal — and
// api.createSearchIndex — instead expect a flat, camelCase object:
//   { indexName, mappings, analyzer?, analyzers?, searchAnalyzer?, synonyms? }
//
// This lifts the definition out of the wrapper, renames the one key that
// differs (`search_analyzer` -> `searchAnalyzer`), drops runtime fields, and
// omits null/absent optionals so a copied index pastes straight into Create.
// Only the six documented create fields are emitted; unknown keys are dropped
// because they are not part of the create contract.
export function toCreateSearchIndexDefinition(idx) {
  if (!idx || typeof idx !== 'object') return idx;
  const def = idx.latest_definition || {};
  const out = { indexName: idx.name };
  if (def.mappings != null) out.mappings = def.mappings;
  if (def.analyzer != null) out.analyzer = def.analyzer;
  if (def.analyzers != null) out.analyzers = def.analyzers;
  if (def.search_analyzer != null) out.searchAnalyzer = def.search_analyzer;
  if (def.synonyms != null) out.synonyms = def.synonyms;
  return out;
}
