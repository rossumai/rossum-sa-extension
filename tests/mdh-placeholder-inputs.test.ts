// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import PlaceholderInputs, { parseAnnotationId } from '../src/mdh/components/PlaceholderInputs.jsx';

function renderInputs(props: any) {
  const container = document.createElement('div');
  render(h(PlaceholderInputs, props), container);
  return { container };
}

describe('parseAnnotationId', () => {
  it('accepts a bare numeric ID', () => {
    expect(parseAnnotationId('17213336')).toBe('17213336');
  });

  it('extracts the ID from a Rossum UI URL with /document/<id>', () => {
    expect(parseAnnotationId('https://example.rossum.app/document/17213336')).toBe('17213336');
  });

  it('extracts the ID from a Rossum API URL with /annotations/<id>', () => {
    expect(parseAnnotationId('https://elis.rossum.com/api/v1/annotations/17213336')).toBe('17213336');
  });

  it('extracts the ID from an /annotations/<id>/content URL', () => {
    expect(parseAnnotationId('https://elis.rossum.com/api/v1/annotations/17213336/content')).toBe('17213336');
  });

  it('handles trailing query strings on /document/ URLs', () => {
    expect(parseAnnotationId('https://example.rossum.app/document/17213336?email=foo')).toBe('17213336');
  });

  it('handles deep-link query strings (datapointPath)', () => {
    expect(
      parseAnnotationId('https://example.rossum.app/document/17213336?datapointPath=7795699250,7795699273'),
    ).toBe('17213336');
  });

  it('returns null for unrecognized input', () => {
    expect(parseAnnotationId('not a url or id')).toBeNull();
    expect(parseAnnotationId('https://example.com/some/path')).toBeNull();
    expect(parseAnnotationId('')).toBeNull();
  });
});

describe('PlaceholderInputs Auto label — value-based guess', () => {
  it('marks the Auto option with "?" when no field type resolved', () => {
    const { container } = renderInputs({
      names: ['cust'], values: { cust: '21199417' }, types: {},
      resolvedTypeFor: () => ({ type: undefined, autoType: undefined }),
    });
    const autoOpt = container.querySelector('.placeholder-type-select option[value="auto"]');
    expect(autoOpt!.textContent).toBe('Auto (Number?)');
  });

  it('does NOT mark with "?" when a field type resolved', () => {
    const { container } = renderInputs({
      names: ['cust'], values: { cust: '21199417' }, types: {},
      resolvedTypeFor: () => ({ type: 'string', autoType: 'string' }),
    });
    const autoOpt = container.querySelector('.placeholder-type-select option[value="auto"]');
    expect(autoOpt!.textContent).toBe('Auto (String)');
  });
});
