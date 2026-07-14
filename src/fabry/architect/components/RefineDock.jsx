import { h } from 'preact';
import { useState, useRef, useEffect } from 'preact/hooks';
import { refineTurn, answerRefine, updateDeliverable } from '../actions.js';
import DiffView from '../../../ui/DiffView.jsx';
import FabryInput from '../../../ui/fabry/FabryInput.jsx';
import FabryQuestions from '../../components/FabryQuestions.jsx';

const GERUNDS = ['Refining', 'Consulting the org', 'Tightening the wording', 'Checking names'];

// Docked, inline "Refine wording" bar (Proposal A) pinned at the bottom of the
// deliverable pane. The user drives the wording with instructions to Mr. Fabry using
// the design-system AI input (FabryInput); each instruction goes to ONE cautious
// read-only chat. A turn returns EITHER the complete revised Markdown (shown as a
// cumulative diff → Accept / Discard) OR clarifying questions (interactive elements),
// which render inline via FabryQuestions and are answered in the SAME chat. More
// instructions build on the last proposal. Accept is the only write. Reset on
// deliverable switch is handled by keying this component on deliverable.id.
export default function RefineDock({ deliverable }) {
  const base = deliverable.text;
  const hasText = base.trim().length > 0;
  const [chatId, setChatId] = useState(null);
  const [proposal, setProposal] = useState(null); // latest full revised text ('' = none returned), or null
  const [questions, setQuestions] = useState(null); // agent's clarifying questions, or null
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const ctrl = useRef(null);

  useEffect(() => () => { if (ctrl.current) ctrl.current.abort(); }, []); // abort in-flight on unmount/switch

  // Apply a refineTurn/answerRefine result (a proposal OR a fresh round of questions).
  function applyResult(res) {
    setChatId(res.chatId);
    setQuestions(res.questions || null);
    setProposal(res.proposal ?? null);
  }
  function runTurn(fn) {
    if (ctrl.current) ctrl.current.abort();
    const c = new AbortController();
    ctrl.current = c;
    setBusy(true);
    setError(null);
    return fn(c.signal)
      .then((res) => {
        if (res == null) return false; // aborted
        applyResult(res);
        return true;
      })
      .catch((err) => { setError(err?.message || 'Refine failed — try again.'); return false; })
      .finally(() => { if (ctrl.current === c) setBusy(false); });
  }

  function send(v) {
    const text = String(v ?? instruction).trim();
    if (!text || busy || !hasText) return;
    runTurn((signal) => refineTurn({ chatId, deliverableText: base, instruction: text, signal })).then((ok) => { if (ok) setInstruction(''); });
  }
  // FabryQuestions expects onSubmit to resolve true (accepted) or false (re-enable).
  function onAnswer(answers) { return runTurn((signal) => answerRefine({ chatId, answers, signal })); }

  function reset() {
    if (ctrl.current) { ctrl.current.abort(); ctrl.current = null; }
    setChatId(null);
    setProposal(null);
    setQuestions(null);
    setInstruction('');
    setBusy(false);
    setError(null);
  }
  const emptyProposal = proposal != null && proposal.trim().length === 0;
  const changed = proposal != null && proposal.trim().length > 0 && proposal.trim() !== base.trim();
  function accept() { if (changed) updateDeliverable(deliverable.id, proposal); reset(); }

  return (
    <div class="fabry-arch-dock">
      {questions ? (
        <div class="fabry-arch-refine-card">
          <FabryQuestions questions={questions} onSubmit={onAnswer} />
          <div class="fabry-arch-refine-card-actions">
            <span class="fabry-arch-credit">by Mr. Fabry</span>
            <button type="button" class="btn btn-secondary" onClick={reset}>Discard</button>
          </div>
        </div>
      ) : proposal != null ? (
        <div class="fabry-arch-refine-card">
          {changed
            ? <DiffView before={base} after={proposal} />
            : <p class="fabry-arch-dock-hint">{emptyProposal
                ? 'Mr. Fabry didn’t return a revision — try a more specific instruction.'
                : 'Mr. Fabry returned the same wording — try another instruction.'}</p>}
          <div class="fabry-arch-refine-card-actions">
            <span class="fabry-arch-credit">by Mr. Fabry</span>
            <button type="button" class="btn btn-secondary" onClick={reset}>Discard</button>
            <button type="button" class="btn btn-primary" disabled={!changed} onClick={accept}>Accept changes</button>
          </div>
        </div>
      ) : null}
      {error && <p class="fabry-arch-dock-err">{error}</p>}
      <FabryInput
        size="sm"
        value={instruction}
        onInput={setInstruction}
        onSubmit={send}
        busy={busy}
        disabled={!hasText}
        placeholder={hasText ? 'How should Mr. Fabry refine this deliverable? (e.g. tighten it · name the real queue)' : 'Add text to this deliverable to refine it…'}
        gerunds={GERUNDS}
      />
      <p class="fabry-arch-dock-hint">Read-only · Enter to send · you approve every change.</p>
    </div>
  );
}
