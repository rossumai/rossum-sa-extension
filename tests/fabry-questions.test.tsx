// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { h, render } from 'preact';
import FabryQuestions from '../src/fabry/components/FabryQuestions.jsx';

function mount(props: any) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  render(<FabryQuestions {...props} />, root);
  return root;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('FabryQuestions', () => {
  it('free-text: submit disabled until filled, emits {question, answer}', async () => {
    const onSubmit = vi.fn();
    const root = mount({ questions: [{ question: 'Name?', options: [], multi_select: false }], onSubmit });
    const submit = root.querySelector<HTMLButtonElement>('.fabry-q-submit');
    expect(submit!.disabled).toBe(true);
    const input = root.querySelector<HTMLInputElement>('.fabry-q-input')!;
    input.value = 'Acme'; input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(root.querySelector<HTMLButtonElement>('.fabry-q-submit')!.disabled).toBe(false);
    root.querySelector<HTMLElement>('.fabry-q-submit')!.click();
    expect(onSubmit).toHaveBeenCalledWith([{ question: 'Name?', answer: 'Acme' }]);
  });

  it('single-select: option objects render their label, carry a title=description, and emit the label', async () => {
    const onSubmit = vi.fn();
    const options = [
      { value: 'dev', label: 'Development', description: 'The dev environment' },
      { value: 'prod', label: 'Production', description: 'The live environment' },
    ];
    const root = mount({ questions: [{ question: 'Env?', options, multi_select: false }], onSubmit });
    const opts = root.querySelectorAll<HTMLElement>('.fabry-q-opt');
    expect(opts[0].textContent).toBe('Development');
    expect(opts[1].textContent).toBe('Production');
    expect(opts[1].title).toBe('The live environment');
    opts[1].click();
    await flush();
    root.querySelector<HTMLElement>('.fabry-q-submit')!.click();
    expect(onSubmit).toHaveBeenCalledWith([{ question: 'Env?', answer: 'Production' }]);
  });

  it('multi-select: option objects toggle multiple, emitted as labels joined with comma', async () => {
    const onSubmit = vi.fn();
    const options = [
      { value: 'a', label: 'Alpha', description: 'First' },
      { value: 'b', label: 'Beta', description: 'Second' },
      { value: 'c', label: 'Gamma', description: 'Third' },
    ];
    const root = mount({ questions: [{ question: 'Which?', options, multi_select: true }], onSubmit });
    const opts = root.querySelectorAll<HTMLElement>('.fabry-q-opt');
    opts[0].click(); opts[2].click();
    await flush();
    root.querySelector<HTMLElement>('.fabry-q-submit')!.click();
    expect(onSubmit).toHaveBeenCalledWith([{ question: 'Which?', answer: 'Alpha, Gamma' }]);
  });

  it('backward-compat: a plain-string option still works (label == string, no title)', async () => {
    const onSubmit = vi.fn();
    const root = mount({ questions: [{ question: 'Env?', options: ['dev', 'prod'], multi_select: false }], onSubmit });
    const opts = root.querySelectorAll<HTMLElement>('.fabry-q-opt');
    expect(opts[1].textContent).toBe('prod');
    expect(opts[1].title).toBe('');
    opts[1].click();
    await flush();
    root.querySelector<HTMLElement>('.fabry-q-submit')!.click();
    expect(onSubmit).toHaveBeenCalledWith([{ question: 'Env?', answer: 'prod' }]);
  });

  it('after submit, renders chosen answers read-only (no inputs)', async () => {
    const root = mount({ questions: [{ question: 'Name?', options: [], multi_select: false }], onSubmit: vi.fn() });
    const input = root.querySelector<HTMLInputElement>('.fabry-q-input')!;
    input.value = 'Acme'; input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    root.querySelector<HTMLElement>('.fabry-q-submit')!.click();
    await flush();
    expect(root.querySelector('.fabry-q-input')).toBeNull();
    expect(root.querySelector('.fabry-q-answer')!.textContent).toBe('Acme');
  });

  it('re-enables the form when onSubmit resolves false (failed send)', async () => {
    const onSubmit = vi.fn().mockResolvedValue(false);
    const root = mount({ questions: [{ question: 'Name?', options: [], multi_select: false }], onSubmit });
    const input = root.querySelector<HTMLInputElement>('.fabry-q-input')!;
    input.value = 'Acme'; input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    root.querySelector<HTMLElement>('.fabry-q-submit')!.click();
    await flush(); // submitted=true renders read-only view synchronously
    await flush(); // let the awaited onSubmit promise resolve and re-render
    expect(root.querySelector('.fabry-q-input')).not.toBeNull();
    expect(root.querySelector('.fabry-q-submit')).not.toBeNull();
  });
});
