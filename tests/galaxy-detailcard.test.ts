// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { h, render } from 'preact';
import DetailCard from '../src/galaxy/components/DetailCard.jsx';
import * as store from '../src/galaxy/store.js';

beforeEach(() => {
  store.domain.value = 'https://acme.rossum.app';
  store.graph.value = {
    nodes: [
      { val: 1,
        id: 'queue:100', type: 'queue', rawId: '100', name: 'Invoices', color: '#29d4c5',
        detail: [['Status', 'importing'], ['Hooks', '2'], ['Schema', '42']],
      },
      { val: 1,
        id: 'workspace:10', type: 'workspace', rawId: '10', name: 'WS A', color: '#5b9bff',
        detail: [['Queues', '3'], ['Autopilot', 'On']],
      },
      { val: 1,
        id: 'hook:200', type: 'hook', rawId: '200', name: 'Validate', color: '#b48cff',
        detail: [['Type', 'webhook'], ['Active', 'Yes'], ['Events', 'annotation.created']],
      },
      { val: 1,
        id: 'engine:7', type: 'engine', rawId: '7', name: 'My Engine', color: '#9333ea',
        detail: [['Type', 'extractor'], ['Learning', 'On']],
      },
    ],
    links: [],
  };
  store.selectedNodeId.value = null;
});
function mount() {
  const root = document.createElement('div');
  render(h(DetailCard, null), root);
  return root;
}

describe('DetailCard', () => {
  it('renders nothing when no node is selected', () => {
    store.selectedNodeId.value = null;
    expect(mount().querySelector('.galaxy-detail-card')).toBe(null);
  });
  it('shows the selected node name + type and a working Rossum link for a queue', () => {
    store.selectedNodeId.value = 'queue:100';
    const root = mount();
    expect(root.querySelector('.galaxy-detail-card')!.textContent).toContain('Invoices');
    const link = root.querySelector('a.galaxy-detail-link');
    expect(link!.getAttribute('href')).toBe('https://acme.rossum.app/queues/100');
  });
  it('hides the Rossum link for a type without a known route (workspace, v1)', () => {
    store.selectedNodeId.value = 'workspace:10';
    const root = mount();
    expect(root.querySelector('.galaxy-detail-card')!.textContent).toContain('WS A');
    expect(root.querySelector('a.galaxy-detail-link')).toBe(null);
  });
  it('renders node.detail rows in .galaxy-detail-facts for a queue', () => {
    store.selectedNodeId.value = 'queue:100';
    const facts = mount().querySelector('.galaxy-detail-facts');
    expect(facts).not.toBe(null);
    const pairs = [...facts!.querySelectorAll('div')].map((d) => [d.querySelector('dt')!.textContent, d.querySelector('dd')!.textContent]);
    expect(pairs).toContainEqual(['Status', 'importing']);
    expect(pairs).toContainEqual(['Hooks', '2']);
    expect(pairs).toContainEqual(['Schema', '42']);
  });
  it('renders node.detail rows for an engine node', () => {
    store.selectedNodeId.value = 'engine:7';
    const facts = mount().querySelector('.galaxy-detail-facts');
    expect(facts).not.toBe(null);
    const pairs = [...facts!.querySelectorAll('div')].map((d) => [d.querySelector('dt')!.textContent, d.querySelector('dd')!.textContent]);
    expect(pairs).toContainEqual(['Type', 'extractor']);
    expect(pairs).toContainEqual(['Learning', 'On']);
  });
  it('renders node.detail rows for a workspace node', () => {
    store.selectedNodeId.value = 'workspace:10';
    const facts = mount().querySelector('.galaxy-detail-facts');
    expect(facts).not.toBe(null);
    const pairs = [...facts!.querySelectorAll('div')].map((d) => [d.querySelector('dt')!.textContent, d.querySelector('dd')!.textContent]);
    expect(pairs).toContainEqual(['Queues', '3']);
    expect(pairs).toContainEqual(['Autopilot', 'On']);
  });
  it('omits .galaxy-detail-facts when node.detail is empty', () => {
    store.graph.value = {
      nodes: [{ val: 1, id: 'queue:99', type: 'queue', rawId: '99', name: 'Empty', color: '#aaa', detail: [] }],
      links: [],
    };
    store.selectedNodeId.value = 'queue:99';
    expect(mount().querySelector('.galaxy-detail-facts')).toBe(null);
  });
  it('omits .galaxy-detail-facts when node has no detail property', () => {
    store.graph.value = {
      nodes: [{ val: 1, detail: [], id: 'queue:99', type: 'queue', rawId: '99', name: 'Legacy', color: '#aaa' }],
      links: [],
    };
    store.selectedNodeId.value = 'queue:99';
    expect(mount().querySelector('.galaxy-detail-facts')).toBe(null);
  });
  it('produces a hook deep-link for a hook node', () => {
    store.selectedNodeId.value = 'hook:200';
    const link = mount().querySelector('a.galaxy-detail-link');
    expect(link!.getAttribute('href')).toBe('https://acme.rossum.app/settings/extensions/200');
  });
  it('clicking close clears the selection', () => {
    store.selectedNodeId.value = 'queue:100';
    mount().querySelector<HTMLElement>('.galaxy-detail-close')!.click();
    expect(store.selectedNodeId.value).toBe(null);
  });
  it('renders nothing for an unknown selected id', () => {
    store.selectedNodeId.value = 'queue:99999';
    expect(mount().querySelector('.galaxy-detail-card')).toBe(null);
  });
});
