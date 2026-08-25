// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';

vi.mock('../src/fabry/architect/actions.js', () => ({
  refineTurn: vi.fn(),
  answerRefine: vi.fn(),
  updateDeliverable: vi.fn(),
}));

import * as actions from '../src/fabry/architect/actions.js';
import RefineDock from '../src/fabry/architect/components/RefineDock.jsx';
import diffStyles from '../src/ui/DiffView.module.css';

let root: any;
function mount(props: any) {
  root = document.createElement('div');
  document.body.appendChild(root);
  act(() => {
    render(<RefineDock {...props} />, root);
  });
  return root;
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const accept = (r: any) =>
  [...r.querySelectorAll('button')].find((b) => /accept/i.test(b.textContent));
const discard = (r: any) =>
  [...r.querySelectorAll('button')].find((b) => /discard/i.test(b.textContent));
function submit(r: any, v: any) {
  const i = r.querySelector('input');
  act(() => {
    i.value = v;
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return act(async () => {
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
  });
}

beforeEach(() => vi.clearAllMocks());

describe('RefineDock (docked, inline, design-system AI input)', () => {
  it('renders the AI input enabled with no diff for a deliverable that has text', () => {
    const r = mount({ deliverable: { id: 'a', text: '# base requirement' } });
    const input = r.querySelector('input');
    expect(input).toBeTruthy();
    expect(input.disabled).toBe(false);
    expect(r.querySelector('.' + diffStyles.diff)).toBeNull();
  });
  it('disables the AI input for an empty deliverable', () => {
    const r = mount({ deliverable: { id: 'b', text: '   ' } });
    expect(r.querySelector('input').disabled).toBe(true);
  });
  it('an instruction → refineTurn (fresh chat) → shows the diff + enables Accept; Accept applies via updateDeliverable', async () => {
    vi.mocked(actions.refineTurn).mockResolvedValue({
      chatId: 'chat_1',
      proposal: '# refined requirement',
    });
    const r = mount({ deliverable: { id: 'a', text: '# base requirement' } });
    await submit(r, 'tighten it');
    expect(actions.refineTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: null,
        deliverableText: '# base requirement',
        instruction: 'tighten it',
      }),
    );
    expect(r.querySelector('.' + diffStyles.diff)).toBeTruthy();
    expect(accept(r).disabled).toBe(false);
    accept(r).click();
    expect(actions.updateDeliverable).toHaveBeenCalledWith('a', '# refined requirement');
  });
  it('a follow-up instruction (before accept) reuses the chatId so Fabry builds on its last proposal', async () => {
    vi.mocked(actions.refineTurn)
      .mockResolvedValueOnce({ chatId: 'chat_1', proposal: '# v1' })
      .mockResolvedValueOnce({ chatId: 'chat_1', proposal: '# v2' });
    const r = mount({ deliverable: { id: 'a', text: '# base' } });
    await submit(r, 'tighten');
    await submit(r, 'name the field');
    expect(actions.refineTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ chatId: 'chat_1', instruction: 'name the field' }),
    );
  });
  it('renders the agent questions (interactive elements) inline when a turn asks — no diff, no Accept', async () => {
    vi.mocked(actions.refineTurn).mockResolvedValue({
      chatId: 'c',
      questions: [{ question: 'Which queue?' }],
    });
    const r = mount({ deliverable: { id: 'a', text: '# base' } });
    await submit(r, 'tighten');
    expect(r.querySelector('.fabry-q')).toBeTruthy();
    expect(r.querySelector('.' + diffStyles.diff)).toBeNull();
    expect(accept(r)).toBeFalsy(); // nothing to accept yet
  });
  it('answering the questions calls answerRefine (same chat) and shows the resulting diff', async () => {
    vi.mocked(actions.refineTurn).mockResolvedValue({
      chatId: 'c',
      questions: [{ question: 'Which queue?' }],
    });
    vi.mocked(actions.answerRefine).mockResolvedValue({
      chatId: 'c',
      proposal: '# refined for the Invoices queue',
    });
    const r = mount({ deliverable: { id: 'a', text: '# base' } });
    await submit(r, 'tighten');
    const qin = r.querySelector('.fabry-q-input');
    act(() => {
      qin.value = 'Invoices';
      qin.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      r.querySelector('.fabry-q-submit').click();
      await flush();
    });
    expect(actions.answerRefine).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'c',
        answers: [{ question: 'Which queue?', answer: 'Invoices' }],
      }),
    );
    expect(r.querySelector('.' + diffStyles.diff)).toBeTruthy();
  });
  it('an empty proposal is never shown as a diff and cannot be accepted (guards a destructive Accept)', async () => {
    vi.mocked(actions.refineTurn).mockResolvedValue({ chatId: 'c', proposal: '' });
    const r = mount({ deliverable: { id: 'a', text: '# base requirement' } });
    await submit(r, 'do the impossible');
    expect(r.querySelector('.' + diffStyles.diff)).toBeNull();
    expect(accept(r).disabled).toBe(true);
  });
  it('Discard clears the card and starts a fresh chat on the next instruction (no updateDeliverable)', async () => {
    vi.mocked(actions.refineTurn).mockResolvedValue({ chatId: 'chat_1', proposal: '# refined' });
    const r = mount({ deliverable: { id: 'a', text: '# base' } });
    await submit(r, 'tighten');
    act(() => {
      discard(r).click();
    });
    expect(actions.updateDeliverable).not.toHaveBeenCalled();
    expect(r.querySelector('.' + diffStyles.diff)).toBeNull();
    await submit(r, 'again');
    expect(actions.refineTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ chatId: null, instruction: 'again' }),
    );
  });
});
