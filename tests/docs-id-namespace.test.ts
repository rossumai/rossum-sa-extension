// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { prefixFor, namespaceSection, resolveInPage } from '../src/docs/idNamespace.js';

function page() {
  const root = document.createElement('div');
  root.innerHTML = `
    <section data-deliverable="d1" data-slug="data-model">
      <h1 id="data-model">Data model</h1><h2 id="21-entities">2.1 Entities</h2>
      <p><a href="#21-entities">jump</a> <a href="#2.1">forgiving</a></p>
    </section>
    <section data-deliverable="d2" data-slug="intake">
      <h1 id="intake">Intake</h1><h2 id="21-entities">2.1 Entities</h2>
    </section>`;
  for (const s of root.querySelectorAll('section')) namespaceSection(s, prefixFor(s.dataset.slug));
  return root;
}

describe('namespaceSection', () => {
  it('prefixes ids so two deliverables can hold the same heading', () => {
    expect([...page().querySelectorAll('[id]')].map((e) => e.id)).toEqual([
      'data-model--data-model',
      'data-model--21-entities',
      'intake--intake',
      'intake--21-entities',
    ]);
  });

  it('leaves authored hrefs untouched, so the text stays round-trippable', () => {
    expect([...page().querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      '#21-entities',
      '#2.1',
    ]);
  });

  it('reports the mapping it applied', () => {
    const s = document.createElement('section');
    s.innerHTML = '<h2 id="scope">Scope</h2>';
    expect(namespaceSection(s, 'x--').get('scope')).toBe('x--scope');
  });

  it('is idempotent — adopting twice must not double-prefix', () => {
    const s = document.createElement('section');
    s.innerHTML = '<h2 id="scope">Scope</h2>';
    namespaceSection(s, 'x--');
    namespaceSection(s, 'x--');
    expect(s.querySelector('[id]')!.id).toBe('x--scope');
  });

  it('tolerates junk', () => {
    expect(namespaceSection(null, 'x--').size).toBe(0);
    expect(namespaceSection(document.createElement('div'), '').size).toBe(0);
  });
});

describe('resolveInPage', () => {
  it('resolves within the reader current section FIRST when ids collide', () => {
    expect(
      resolveInPage(page(), '21-entities', 'intake--')!.closest('section')!.dataset.deliverable,
    ).toBe('d2');
    expect(
      resolveInPage(page(), '21-entities', 'data-model--')!.closest('section')!.dataset.deliverable,
    ).toBe('d1');
  });

  it('falls back to document order when the current section has no such heading', () => {
    expect(resolveInPage(page(), 'data-model', 'intake--')!.id).toBe('data-model--data-model');
  });

  it('stays forgiving about the form the author wrote', () => {
    expect(resolveInPage(page(), '2.1', 'data-model--')!.id).toBe('data-model--21-entities');
    expect(resolveInPage(page(), '2.1 Entities', 'data-model--')!.id).toBe(
      'data-model--21-entities',
    );
  });

  it('returns null rather than guessing', () => {
    expect(resolveInPage(page(), 'nothing-like-this', 'data-model--')).toBe(null);
    expect(resolveInPage(null, 'x')).toBe(null);
    expect(resolveInPage(page(), '')).toBe(null);
  });
});
