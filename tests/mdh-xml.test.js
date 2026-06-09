// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { parseXml, elementToValue, detectRecords } from '../src/mdh/xml.js';

const dom = (s) => new DOMParser().parseFromString(s, 'application/xml');

describe('detectRecords', () => {
  it('auto-detects the dominant repeating element', () => {
    const d = dom(`<Invoices><Invoice><a>1</a></Invoice><Invoice><a>2</a></Invoice></Invoices>`);
    const { records, candidates } = detectRecords(d);
    expect(records.length).toBe(2);
    expect(candidates.some((c) => /Invoice/.test(c.label))).toBe(true);
  });
  it('falls back to root children when nothing repeats', () => {
    const d = dom(`<root><only><x>1</x></only></root>`);
    expect(detectRecords(d).records.length).toBe(1);
  });
  it('does not offer a duplicate top-level candidate when records ARE the root children', () => {
    const d = dom(`<Invoices><Invoice><a>1</a></Invoice><Invoice><a>2</a></Invoice></Invoices>`);
    const { candidates } = detectRecords(d);
    // Only one sensible record element (<Invoice>); no redundant "root children" twin.
    expect(candidates).toHaveLength(1);
    expect(candidates[0].label).toMatch(/Invoice/);
  });
  it('offers a distinct top-level option only when it differs from the repeated group', () => {
    const d = dom(`<root><a><x>1</x></a><b><y>2</y></b><a><x>3</x></a></root>`);
    const { candidates } = detectRecords(d);
    expect(candidates.length).toBe(2);                         // <a> group (×2) AND all top-level (×3)
    const top = candidates.find((c) => /top-level/i.test(c.label));
    expect(top).toBeTruthy();
    expect(detectRecords(d, top.key).records.length).toBe(3);  // switching actually changes the records
  });
});

describe('elementToValue', () => {
  it('maps attributes (@_), child elements, repeated→array, and text', () => {
    const el = dom(`<r id="A1"><Vendor>ACME</Vendor><Tag>x</Tag><Tag>y</Tag></r>`).documentElement;
    expect(elementToValue(el)).toEqual({ '@_id': 'A1', Vendor: 'ACME', Tag: ['x', 'y'] });
  });
  it('returns a scalar for a pure-text leaf, null for empty, and #text for mixed', () => {
    expect(elementToValue(dom(`<a>hi</a>`).documentElement)).toBe('hi');
    expect(elementToValue(dom(`<a/>`).documentElement)).toBeNull();
    expect(elementToValue(dom(`<a x="1">txt</a>`).documentElement)).toEqual({ '@_x': '1', '#text': 'txt' });
  });
  it('strips namespace prefixes; infers types only when asked', () => {
    expect(elementToValue(dom(`<ns:a xmlns:ns="u"><ns:b>5</ns:b></ns:a>`).documentElement)).toEqual({ b: '5' });
    expect(elementToValue(dom(`<a><n>5</n><ok>true</ok></a>`).documentElement, { inferTypes: true })).toEqual({ n: 5, ok: true });
  });
});

describe('parseXml', () => {
  const XML = `<Invoices>
    <Invoice id="A1"><Vendor>ACME</Vendor><Total>120.50</Total></Invoice>
    <Invoice id="A2"><Vendor>Globex</Vendor><Total>87</Total></Invoice>
  </Invoices>`;
  it('produces one doc per repeating element with the parseCsv shape', () => {
    const r = parseXml(XML);
    expect(r.error).toBeNull();
    expect(r.docs).toEqual([
      { '@_id': 'A1', Vendor: 'ACME', Total: '120.50' },
      { '@_id': 'A2', Vendor: 'Globex', Total: '87' },
    ]);
    expect(r.columns).toEqual(['@_id', 'Vendor', 'Total']);
    expect(r.recordCandidates.length).toBeGreaterThan(0);
  });
  it('accepts an ArrayBuffer and honors a recordKey override + inferTypes', () => {
    const buf = new TextEncoder().encode(XML).buffer;
    const r = parseXml(buf, { inferTypes: true });
    expect(r.docs[0].Total).toBe(120.5);
  });
  it('returns a structured error for malformed XML (no throw)', () => {
    const r = parseXml('<a><b></a>');
    expect(r.error).toBeTruthy();
    expect(r.docs).toEqual([]);
  });
});

import { toXmlName, escapeXml, valueToXml, docToXml } from '../src/mdh/xml.js';
import { buildXmlSerializer } from '../src/mdh/downloadCollection.js';

describe('XML export helpers', () => {
  it('toXmlName keeps _id, sanitizes invalid names', () => {
    expect(toXmlName('_id')).toBe('_id');
    expect(toXmlName('$oid')).toBe('_oid');
    expect(toXmlName('2024')).toBe('_2024');
    expect(toXmlName('a b:c')).toBe('a_b_c');
    expect(toXmlName('xmlData')).toBe('_xmlData');
    expect(toXmlName('')).toBe('_');
  });
  it('escapeXml escapes & < >', () => {
    expect(escapeXml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });
  it('valueToXml: null→empty, array→repeated, object→nested, primitive→text', () => {
    expect(valueToXml('x', null)).toBe('<x/>');
    expect(valueToXml('x', [1, 2])).toBe('<x>1</x><x>2</x>');
    expect(valueToXml('x', { a: 'v' })).toBe('<x><a>v</a></x>');
    expect(valueToXml('x', 'a&b')).toBe('<x>a&amp;b</x>');
  });
  it('docToXml wraps a doc; sanitizes the record name', () => {
    expect(docToXml({ Vendor: 'ACME', _id: 1 }, 'record')).toBe('<record><Vendor>ACME</Vendor><_id>1</_id></record>');
  });
});

describe('buildXmlSerializer', () => {
  it('produces a streaming, well-formed XML document', () => {
    const s = buildXmlSerializer({ rootName: 'records', recordName: 'record' });
    expect(s.ext).toBe('xml');
    expect(s.preamble()).toContain('<?xml');
    expect(s.preamble()).toContain('<records>');
    expect(s.item({ a: 1 })).toContain('<record><a>1</a></record>');
    expect(s.postamble()).toContain('</records>');
  });
  it('sanitizes a custom root name', () => {
    expect(buildXmlSerializer({ rootName: '2x' }).preamble()).toContain('<_2x>');
  });
});
