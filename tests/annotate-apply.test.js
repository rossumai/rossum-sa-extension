import { snapshotFields, buildReplaceOperations, buildRestoreOperations, buildAddOperations, buildRemoveOperations } from '../src/rossum/annotate/apply.js';
import { describe, it, expect } from 'vitest';

const fields = [
  { datapointId: 1, value: 'x', position: [0,0,1,1], page: 1 },
  { datapointId: 2, value: 'y', position: null, page: 2 },
];
describe('apply', () => {
  it('snapshots originals for the given ids', () => {
    expect(snapshotFields(fields, [1, 2])).toEqual({
      1: { value: 'x', position: [0,0,1,1], page: 1 },
      2: { value: 'y', position: null, page: 2 },
    });
  });
  it('builds replace ops; position/page only when newBox present', () => {
    const changes = [
      { datapointId: 1, newValue: 'X', newBox: [2,2,3,3], page: 1, valueChanged: true, boxChanged: true },
      { datapointId: 2, newValue: 'Y', newBox: null, page: 2, valueChanged: true, boxChanged: false },
    ];
    expect(buildReplaceOperations(changes)).toEqual([
      { op: 'replace', id: 1, value: { content: { value: 'X', position: [2,2,3,3], page: 1 } } },
      { op: 'replace', id: 2, value: { content: { value: 'Y' } } },
    ]);
  });
  it('builds restore ops from a snapshot', () => {
    expect(buildRestoreOperations({ 1: { value: 'x', position: [0,0,1,1], page: 1 }, 2: { value: 'y', position: null, page: 2 } })).toEqual([
      { op: 'replace', id: 1, value: { content: { value: 'x', position: [0,0,1,1], page: 1 } } },
      { op: 'replace', id: 2, value: { content: { value: 'y' } } },
    ]);
  });
  it('buildRestoreOperations ignores the reserved __addedRows key', () => {
    const ops = buildRestoreOperations({ 1: { value: 'x', position: null, page: 1 }, __addedRows: [99] });
    expect(ops).toEqual([{ op: 'replace', id: 1, value: { content: { value: 'x' } } }]);
  });
});

describe('add-row operations', () => {
  it('buildAddOperations maps table→mvId with value-only cells, skips unknown tables', () => {
    const addRows = [
      { table: 'tax_details', cells: [{ schemaId: 'tax_detail_base', value: '100' }, { schemaId: 'x', value: null }] },
      { table: 'unknown_table', cells: [{ schemaId: 'a', value: '1' }] },
    ];
    expect(buildAddOperations(addRows, { tax_details: 500 })).toEqual([
      { op: 'add', id: 500, value: [
        { schema_id: 'tax_detail_base', content: { value: '100' } },
        { schema_id: 'x', content: { value: null } },
      ] },
    ]);
  });
  it('buildRemoveOperations builds remove ops for added row ids', () => {
    expect(buildRemoveOperations([11, 12])).toEqual([{ op: 'remove', id: 11 }, { op: 'remove', id: 12 }]);
    expect(buildRemoveOperations([])).toEqual([]);
  });
});
