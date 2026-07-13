import { h } from 'preact';
import { useState } from 'preact/hooks';

// An option is normally an object `{value, label, description}` (live shape);
// a plain string is also accepted for backward-compat.
const optLabel = (o) => (o && typeof o === 'object' ? o.label : o);
const optDesc = (o) => (o && typeof o === 'object' ? o.description : '');

// Inline interactive form for one turn's agent clarifying questions. Free-text
// → input; options → toggle buttons (single- or multi-select). On submit it
// emits [{question, answer}] and renders the chosen answers read-only. State is
// local + per-turn (the turn is never persisted — spec §1).
export default function FabryQuestions({ questions, onSubmit }) {
  const [answers, setAnswers] = useState(() => questions.map(() => ({ text: '', selected: [] })));
  const [submitted, setSubmitted] = useState(false);

  const setText = (i, v) => setAnswers((a) => a.map((x, j) => (j === i ? { ...x, text: v } : x)));
  const toggle = (i, opt, multi) => setAnswers((a) => a.map((x, j) => {
    if (j !== i) return x;
    if (!multi) return { ...x, selected: [opt] };
    return { ...x, selected: x.selected.includes(opt) ? x.selected.filter((o) => o !== opt) : [...x.selected, opt] };
  }));

  const answerFor = (q, a) => (q.options && q.options.length ? a.selected.join(', ') : a.text.trim());
  const complete = questions.every((q, i) => answerFor(q, answers[i]).length > 0);
  const collect = () => questions.map((q, i) => ({ question: q.question, answer: answerFor(q, answers[i]) }));

  if (submitted) {
    return (
      <div class="fabry-q fabry-q-done">
        {questions.map((q, i) => (
          <div key={i} class="fabry-q-item">
            <div class="fabry-q-text">{q.question}</div>
            <div class="fabry-q-answer">{answerFor(q, answers[i])}</div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div class="fabry-q">
      {questions.map((q, i) => (
        <div key={i} class="fabry-q-item">
          <div class="fabry-q-text">{q.question}</div>
          {q.options && q.options.length ? (
            <div class="fabry-q-opts">
              {q.options.map((opt, k) => (
                <button type="button" key={k} class={'fabry-q-opt' + (answers[i].selected.includes(optLabel(opt)) ? ' on' : '')} title={optDesc(opt)} onClick={() => toggle(i, optLabel(opt), q.multi_select)}>{optLabel(opt)}</button>
              ))}
            </div>
          ) : (
            <input class="fabry-q-input" type="text" value={answers[i].text} placeholder="Your answer" onInput={(e) => setText(i, e.target.value)} />
          )}
        </div>
      ))}
      <button type="button" class="fabry-q-submit" disabled={!complete} onClick={async () => { setSubmitted(true); const ok = await onSubmit(collect()); if (ok === false) setSubmitted(false); }}>
        {questions.length === 1 ? 'Send answer' : 'Send answers'}
      </button>
    </div>
  );
}
