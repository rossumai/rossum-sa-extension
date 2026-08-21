import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { runInTab } from '../utils.js';
import { readCurrentContext } from '../tab-readers.js';
import { fetchJson, apiPatch, extractIdFromUrl } from '../mdh-provenance.js';
import { isLockedByOther, pickHolderName } from '../reviewingLock.js';
import { track } from '../../usage/track.js';

// Real IO, overridable per-call for tests (repo pattern: devtools actions.js).
const defaultDeps = {
  readCtx: (tabId: number) => runInTab(tabId, readCurrentContext),
  getJson: fetchJson,
  patch: apiPatch,
  reloadTab: (tabId: number) => chrome.tabs.reload(tabId),
  closePopup: () => window.close(),
};

// Detects the "another user holds this annotation in reviewing" state.
// Returns null in EVERY other case (no annotation, not reviewing, held by me,
// any failed read) — the banner must never guess. The holder name is a
// best-effort embellishment: its read failing degrades the result (generic
// "another user"), never hides it.
export async function probeLock(tabId: number, deps?: any) {
  const d = { ...defaultDeps, ...deps };
  const ctx = await d.readCtx(tabId);
  if (!ctx || !ctx.token || !ctx.domain || !ctx.annotationId) return null;

  let ann;
  let me;
  try {
    ann = await d.getJson(
      `${ctx.domain}/api/v1/annotations/${ctx.annotationId}?fields=status,modified_by`,
      ctx.token,
    );
    if (!ann || ann.status !== 'reviewing') return null;
    me = await d.getJson(`${ctx.domain}/api/v1/auth/user`, ctx.token);
  } catch {
    return null;
  }
  if (!isLockedByOther({ status: ann.status, modifiedBy: ann.modified_by, meUrl: me && me.url })) {
    return null;
  }

  let holderName = 'another user';
  const holderId = extractIdFromUrl(ann.modified_by);
  if (holderId) {
    try {
      holderName = pickHolderName(
        await d.getJson(
          `${ctx.domain}/api/v1/users/${holderId}?fields=username,first_name,last_name`,
          ctx.token,
        ),
      );
    } catch {
      // keep the generic fallback
    }
  }

  return { ctx, holderName };
}

function LockIcon() {
  return (
    <svg width="13" height="14" viewBox="0 0 12 13" fill="none" stroke="currentColor" stroke-width="1.6">
      <rect x="1.5" y="5.5" width="9" height="6.2" rx="1.4" />
      <path d="M3.6 5.2V4a2.4 2.4 0 0 1 4.8 0v1.2" />
    </svg>
  );
}

export default function ReviewingLockBanner({ tab, deps }: { tab?: any; deps?: any }) {
  const d = { ...defaultDeps, ...deps };
  const [lock, setLock] = useState<any>(null);
  const [releasing, setReleasing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    probeLock(tab.id, d)
      .then((res) => {
        if (!cancelled && res) setLock(res);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!lock) return null;

  const onRelease = async () => {
    setError(null);
    setReleasing(true);
    try {
      await d.patch(
        `${lock.ctx.domain}/api/v1/annotations/${lock.ctx.annotationId}`,
        lock.ctx.token,
        { status: 'to_review' },
      );
      track('sa_popup_unlock_annotation');
      d.reloadTab(tab.id);
      d.closePopup();
    } catch (e: any) {
      const msg = String((e && (e as any).message) || e);
      setError(
        msg.includes('403')
          ? "You don't have permission to release this document."
          : msg.includes('401')
            ? 'Sign in to Rossum in this tab first.'
            : "Couldn't release the document — try again.",
      );
      setReleasing(false);
    }
  };

  return (
    <div class="reviewing-lock-banner" role="alert">
      <div class="rlb-row">
        <span class="rlb-icon" aria-hidden="true">
          <LockIcon />
        </span>
        <div class="rlb-text">
          <span class="rlb-title">Document locked by {lock.holderName}</span>
          <span class="rlb-sub">Read-only while they review</span>
        </div>
        <button class="rlb-release" onClick={onRelease} disabled={releasing}>
          {releasing ? 'Unlocking…' : 'Unlock'}
        </button>
      </div>
      {error ? <p class="rlb-error">{error}</p> : null}
    </div>
  );
}
