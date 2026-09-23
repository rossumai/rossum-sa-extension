// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { h, render } from 'preact';
import StatsSummary from '../src/mdh/components/StatsSummary.jsx';
import StatsFieldCard from '../src/mdh/components/StatsFieldCard.jsx';

function mount(props: any) {
  const root = document.createElement('div');
  render(<StatsSummary total={4_210_663} fieldCount={50} fieldsTotal={50} {...props} />, root);
  return root;
}

describe('StatsSummary sampling notice', () => {
  it('states the sample and what stayed exact, instead of warning about timeouts', () => {
    const root = mount({ sampled: 5000 });
    const note = root.querySelector('.stats-note')!;
    expect(note.textContent).toContain('5,000');
    expect(note.textContent).toContain('4,210,663');
    expect(note.textContent).toContain('exact');
    expect(root.querySelector('.stats-warn')).toBeNull();
  });

  it('says nothing on an exact run, at any size', () => {
    const root = mount({ sampled: null });
    expect(root.querySelector('.stats-note')).toBeNull();
    expect(root.querySelector('.stats-warn')).toBeNull();
  });
});

describe('StatsSummary document size', () => {
  it('shows the average from storage stats and omits a min/max tooltip it does not have', () => {
    const root = mount({
      sampled: 5000,
      docSize: { count: 10, avg: 812, min: null, max: null, total: 8120 },
    });
    const card = [...root.querySelectorAll('.stats-overview-card')].find((c) =>
      c.textContent!.includes('Avg doc'),
    )!;
    expect(card.textContent).toContain('812 B');
    expect(card.getAttribute('title')).toBeNull();
  });

  it('keeps the min/max tooltip on an exact run', () => {
    const root = mount({
      sampled: null,
      docSize: { count: 10, avg: 812, min: 100, max: 2000, total: 8120 },
    });
    const card = [...root.querySelectorAll('.stats-overview-card')].find((c) =>
      c.textContent!.includes('Avg doc'),
    )!;
    expect(card.getAttribute('title')).toContain('Min:');
  });
});

const profile = {
  field: 'currency',
  total: 4_210_663,
  pct: 100,
  present: 5000,
  nullCount: 0,
  missingCount: 0,
  emptyCount: 0,
  primaryType: 'string',
  types: [{ type: 'string', count: 5000 }],
  isMixed: false,
  distinct: 4812,
  diversityPct: 96,
  topValues: [{ value: 'EUR', count: 2104 }],
  fullyDistinct: false,
  string: null,
  numeric: null,
  date: null,
  sentinel: null,
};

function mountCard(props: any) {
  const root = document.createElement('div');
  render(<StatsFieldCard profile={profile} {...props} />, root);
  return root;
}

describe('StatsFieldCard distinct count', () => {
  it('marks the count as a lower bound and names the sample it came from', () => {
    const meta = mountCard({ sampled: 5000 }).querySelector('.stats-fcard-meta')!;
    expect(meta.textContent).toContain('4,812');
    expect(meta.textContent).toContain('≥'); // the count is a floor: a sample
    expect(meta.textContent).toContain('in 5,000 sampled'); // cannot see a value it did not draw
  });

  it('drops the qualifier on an exact run, because then it is the real count', () => {
    const meta = mountCard({ sampled: null }).querySelector('.stats-fcard-meta')!;
    expect(meta.textContent).toContain('4,812 distinct');
    expect(meta.textContent).not.toContain('≥');
    expect(meta.textContent).not.toContain('sampled');
  });

  it('renders no meta row when there is no count to show', () => {
    const root = document.createElement('div');
    render(<StatsFieldCard profile={{ ...profile, distinct: 0 }} sampled={null} />, root);
    expect(root.querySelector('.stats-fcard-meta')).toBeNull();
  });
});
