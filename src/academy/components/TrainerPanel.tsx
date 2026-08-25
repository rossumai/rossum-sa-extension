import { h } from 'preact';
import { useState, useRef } from 'preact/hooks';
import { verifyReceipt } from '../../training/receipt.js';
import { hmacSha256 } from '../../training/hmac.js';
import { RECEIPT_KEY } from '../../training/receiptKey.js';
import { track } from '../../usage/track.js';
import css from '../Academy.module.css';

const sign = (msg: string) => hmacSha256(RECEIPT_KEY, msg);

export default function TrainerPanel() {
  const [text, setText] = useState('');
  const [result, setResult] = useState<any>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Read the textarea's live DOM value rather than the `text` state closure:
  // preact batches state updates onto a microtask, so a caller that sets the
  // DOM value, fires `input`, and clicks synchronously (the same pattern
  // FabryInput's onKeyDown already relies on via `e.target.value`) would
  // otherwise hand `check()` the PREVIOUS render's stale (often empty) text.
  const check = async () => {
    track('sa_training_receipt_verify');
    setResult(await verifyReceipt(taRef.current?.value ?? text, sign));
  };

  return (
    <section class={css.trainer}>
      <h3>Check a receipt</h3>
      <p class={css.fine}>Paste the whole receipt a trainee sent you.</p>
      <textarea
        ref={taRef}
        class={css.textarea}
        rows={8}
        value={text}
        onInput={(e) => {
          setText(e.currentTarget.value);
          setResult(null);
        }}
      />
      <button type="button" class={css.primary} onClick={check}>
        Check
      </button>
      {/* Naming the person is safe only because canonicalString SIGNS the
          username. It did not once, which made the printed name free-form
          text a trainee could swap for their own on a colleague's receipt —
          and a trainer reading this line has no reason to cross-check the
          opaque numeric id. */}
      {result && (
        <p class={result.valid ? css.ok : css.warn}>
          {result.valid
            ? `Valid — issued to ${result.fields.username} (id ${result.fields.userId}) at ${result.fields.host} on ${result.fields.dateUtc}.`
            : 'Not valid — this code does not match its own receipt.'}
        </p>
      )}
    </section>
  );
}
