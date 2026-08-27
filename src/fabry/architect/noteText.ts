// The document bar's note is ONE line, and an unacknowledged upload failure rides inside it.
//
// That is Task 7's rule and it is load-bearing: for a file pasted into the editor the note is the
// only record there is — the panel's own log never sees that path — so a failure must survive every
// later message until the reader DISMISSES it. Not overwritten by a success in the same batch, not
// by a later batch, and not by the PDF flow, which became a second writer to the same slot and
// replaced the line wholesale.
//
// Extracted from SourceEditor for that second writer. A shared formatter rather than a copy in each,
// because two places composing the same line is how the two would eventually disagree — and it is
// its own module rather than an export of SourceEditor because two test files mock that component,
// and SpecView reads this DURING RENDER.

/** Upload failures the reader has not dismissed yet, and how many older ones the cap dropped. */
export type NoteFailures = { lines: string[]; hidden: number };

/** The empty carrier. One shared value is safe to hand to every note slot: `withFailure` returns a
 *  new object and nothing in the app writes to this one. */
export const NO_FAILURES: NoteFailures = { lines: [], hidden: 0 };

// The note is one line above the document, so it names the most recent few failures and counts the
// rest. The panel's log carries FAILED_CAP = 50 of them because it is a scrollable list; this is not.
const FAIL_CAP = 5;

/** Newest kept, oldest counted — `capLog`'s rule in AssetsPanel, for its reason: a failure collapsed
 *  into a count silently is a failure nobody hears about, and unbounded growth is its own bug. */
export function withFailure(prev: NoteFailures, line: string): NoteFailures {
  const lines = [...prev.lines, line];
  const over = Math.max(0, lines.length - FAIL_CAP);
  return { lines: lines.slice(over), hidden: prev.hidden + over };
}

/**
 * The `busy` sentinel's guard, for every writer to the note slot that does not OWN it.
 *
 * Ruling 39: there are four writers to this one slot now — the PDF flow, an asset link opened from
 * the document column, the editors' upload reports, and the reader's own ×. `SpecView` keys the PDF
 * button's `disabled` state AND its label off the exact literal `'busy'`, and `runPdf` takes
 * seconds, so any of the others landing mid-print re-enables the button and lets a second print
 * start on top of the first. The rule cannot be per-writer diligence, so it is a function: the flow
 * that SET the sentinel is the only one allowed to replace it, and everyone else defers.
 *
 * A failure is not lost by deferring — an unacknowledged one rides in `NoteFailures`, which the PDF
 * flow's own next message composes back in (`noteWith`).
 */
export function keepBusy(prev: string | null, next: string | null): string | null {
  return prev === 'busy' ? prev : next;
}

/** One message plus every failure still unacknowledged. An empty message is dropped, so this is
 *  also how the failures alone are rendered. */
export function noteWith(message: string, failed: NoteFailures): string {
  return [
    message,
    ...failed.lines,
    failed.hidden
      ? `${failed.hidden} earlier failure${failed.hidden === 1 ? '' : 's'} not shown`
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
