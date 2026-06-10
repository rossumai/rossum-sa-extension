import { useRef, useEffect } from 'preact/hooks';
import * as api from '../api.js';
import { error, opNotice } from '../store.js';

// Tracks the most recent async Data Storage operation (a 202 + operation id) and
// auto-polls it to completion, surfacing status via the GLOBAL top stripes so it
// can't be missed (the old near-invisible bottom bar is gone):
//   RUNNING               -> info  opNotice  ("<label>… runs in the background")
//   FINISHED              -> clear opNotice + onFinished() (e.g. re-list)
//   FAILED                -> red error banner ("<label> failed: <server message>")
//   timeout / poll error  -> warning opNotice ("<label>: still running — Refresh")
// A new track aborts the prior poll (a late resolve can't clobber); the in-flight
// poll is aborted and our opNotice cleared on unmount / clear() (collection switch).
export default function useOperationStatus() {
  const abortRef = useRef(null);
  const ownsNoticeRef = useRef(false); // only clear opNotice we set

  function clearOwnNotice() {
    if (ownsNoticeRef.current) {
      opNotice.value = null;
      ownsNoticeRef.current = false;
    }
  }
  function setNotice(notice) {
    opNotice.value = notice;
    ownsNoticeRef.current = true;
  }

  useEffect(() => () => { abortRef.current?.abort(); clearOwnNotice(); }, []);

  function track(operationId, { label = 'Operation', onFinished } = {}) {
    if (!operationId) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setNotice({ message: `${label}… (runs in the background)`, kind: 'info' });
    api.waitForOperation(operationId, { signal: controller.signal })
      .then(() => {
        if (controller.signal.aborted) return;
        clearOwnNotice();
        onFinished?.();
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (err && (err.timedOut || err.pollUnavailable)) {
          // Inconclusive — the build may still be running. Neutral warning, not red.
          setNotice({ message: `${label}: still running — use Refresh to confirm.`, kind: 'warning' });
        } else {
          clearOwnNotice();
          error.value = { message: `${label} failed: ${err.message}` };
        }
      });
  }

  function clear() {
    abortRef.current?.abort();
    clearOwnNotice();
  }

  return { track, clear };
}
