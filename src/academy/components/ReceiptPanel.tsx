import { h } from 'preact';
import { useState } from 'preact/hooks';
import * as store from '../store.js';
import { mintReceipt } from '../mint.js';
import { fetchAcademyApi, whoami } from '../api.js';
import { TRACK } from '../../training/track.js';
import { isTrackComplete } from '../../training/progress.js';
import css from '../Academy.module.css';

// Each failure gets its OWN wording. Telling someone whose wifi blipped to
// "redo it" sends them off to repeat work that was never wrong — and only the
// 'no-longer-true' case actually un-ticks anything, so only it may say so.
export function noteFor(res: any) {
  if (!res || res.ok) return null;
  const step = res.failedStep;
  switch (res.reason) {
    case 'no-longer-true':
      return `Not issued — step ${step} no longer checks out in your org, so it has been un-ticked. Redo it and issue again.`;
    case 'unreachable':
      return `Not issued — we couldn't reach your org to re-check step ${step}. Nothing has been un-ticked; check your connection and try again.`;
    case 'identity':
      return "Not issued — we couldn't read your Rossum user name and id, and the receipt is issued to a person. Reopen the Academy from the extension's popup and try again.";
    case 'unverifiable':
      return "Not issued — the receipt this would produce cannot be read back, so your trainer's check would reject it. Nothing has been un-ticked.";
    default:
      return `Not issued — something went wrong${res.message ? `: ${res.message}` : ''}. Nothing has been un-ticked; try again.`;
  }
}

export default function ReceiptPanel() {
  const [busy, setBusy] = useState(false);
  const note = store.mintNote.value;
  const text = store.receiptText.value || store.progress.value?.receipt?.text;
  const complete = isTrackComplete(TRACK, store.progress.value!);

  const issue = async () => {
    setBusy(true);
    store.mintNote.value = null;
    try {
      const res = await mintReceipt({ get: fetchAcademyApi, whoami });
      store.mintNote.value = noteFor(res);
    } finally {
      // `finally`, not a trailing statement: mintReceipt has its own error
      // boundary, but a button that can latch on "Checking…" forever must not
      // depend on another module never throwing.
      setBusy(false);
    }
  };

  return (
    <section class={css.receipt}>
      <h3>Completion receipt</h3>
      {text ? (
        <pre class={css.receiptBlock}>{text}</pre>
      ) : (
        <p>
          {complete
            ? 'Every mission is done. Issuing re-checks your org one last time.'
            : 'Finish the un-ticked step above, then issue your receipt.'}
        </p>
      )}
      {!text && complete && (
        <button type="button" class={css.primary} disabled={busy} onClick={issue}>
          {busy ? 'Checking…' : 'Issue receipt'}
        </button>
      )}
      {text && (
        <button type="button" class={css.ghost} onClick={() => navigator.clipboard?.writeText(text as string)}>
          Copy receipt
        </button>
      )}
      {note && <p class={css.warn}>{note}</p>}
      <p class={css.fine}>
        The code is tied to this org, your user id and your user name. It is a training receipt, not a
        credential {'—'} the signing key ships in the extension and can be extracted.
      </p>
    </section>
  );
}
