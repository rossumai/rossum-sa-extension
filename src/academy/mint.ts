// Minting re-runs every `api` check against LIVE org state before issuing, and
// revokes any step whose delta no longer holds.
//
// What that actually buys, stated precisely because an earlier version of this
// comment overclaimed it: the org must STILL exhibit the change NOW. A trainee
// cannot mint against an org they never touched, and cannot keep a pass for
// work they have since undone.
//
// What it does NOT buy: the live signature is compared against the
// MISSION-START BASELINE, which lives in chrome.storage.local and is editable
// by the trainee. Setting a baseline to `[]` (or `0`) makes every check pass
// trivially. So live re-verification raises the floor; it is not a forgery
// guard. Neither is the signature — RECEIPT_KEY ships in the bundle by design
// (same tradeoff as src/usage/ga4Config.js). The receipt is a training
// artifact, not a credential, and the in-app copy says so.
import { TRACK } from '../training/track.js';
import { CHECKS, evaluateApi, signatureFor, collectResponses } from '../training/steps.js';
import { renderReceipt, mintCode, parseReceipt, canonicalString } from '../training/receipt.js';
import { hmacSha256 } from '../training/hmac.js';
import { RECEIPT_KEY } from '../training/receiptKey.js';
import { writeProgress } from '../training/storage.js';
import * as store from './store.js';
import { markStep, type Progress } from '../training/progress.js';
import { track } from '../usage/track.js';

const sign = (msg: string) => hmacSha256(RECEIPT_KEY, msg);
const iso = (d: Date) => d.toISOString().slice(0, 10);

type MintDeps = {
  get: (path: string, check?: any) => Promise<any>;
  whoami: () => Promise<any>;
  now: () => Date;
};

async function mint({ get, whoami, now }: MintDeps) {
  let progress = store.progress.value as Progress;
  const origin = store.getOrigin();

  for (const mission of TRACK.missions) {
    for (const step of mission.steps.filter((s) => s.kind === 'api')) {
      const check = CHECKS[step.check!];
      let sig = null;
      try {
        sig = signatureFor(check.id, await collectResponses(check, get));
      } catch {
        // Nothing is revoked here on purpose: an unreachable org says nothing
        // about whether the work still holds.
        return { ok: false, failedStep: step.id, reason: 'unreachable' };
      }
      const baseline = progress.missions[mission.id]?.baseline?.[check.id];
      if (!evaluateApi(check, sig, baseline)) {
        // Revoke the pass: the org no longer shows the change.
        progress = markStep(progress, mission.id, step.id, null, Date.now());
        await writeProgress(origin, progress);
        store.progress.value = progress;
        return { ok: false, failedStep: step.id, reason: 'no-longer-true' };
      }
    }
  }

  const me = await whoami();
  const userId = Number.isInteger(me?.id) ? me.id : Number(/\/(\d+)\/?$/.exec(me?.url || '')?.[1]);
  const username = String(me?.username ?? '').trim();
  // Both are load-bearing for the printed line `user | <name> (id <n>)`, which
  // parseReceipt has to read back. An absent id renders "(id NaN)" and an empty
  // name renders "user | (id 42)" — BOTH fail to parse, so the trainee would
  // send a receipt the trainer's own checker reports as "Not valid".
  //
  // `|` and newlines are rejected for a different reason: canonicalString joins
  // its fields with `|` and does not escape them, so a username containing one
  // makes the signed string ambiguous — `username:'a|b'` and a crafted missions
  // list can sign identically. Not producible from a Rossum username today, but
  // one clause here is cheaper than an escaping scheme, and a receipt naming a
  // user whose name contains a pipe is not a thing worth issuing.
  if (!Number.isFinite(userId) || !username || /[|\r\n]/.test(username)) {
    return { ok: false, reason: 'identity' };
  }

  const selfCount = TRACK.missions
    .flatMap((m) => m.steps.filter((s) => s.kind === 'self')).length;
  const fields = {
    trackId: TRACK.id,
    trackVersion: TRACK.version,
    host: new URL(origin).host,
    userId,
    username,
    missionsPassed: TRACK.missions.map((m) => m.id),
    selfCount,
    dateUtc: iso(now()),
  };
  const code = await mintCode(fields, sign);
  const text = renderReceipt(fields, code);
  // Last gate: verifying a receipt means parsing it back and re-signing what
  // came out, so anything that does not survive that round trip can never
  // verify no matter how correct the signature is. Catching it here — rather
  // than at the trainer, on a receipt we ourselves issued — is the difference
  // between an honest failure and an unexplainable one.
  const back = parseReceipt(text);
  if (!back || back.code !== code || canonicalString(back.fields) !== canonicalString(fields)) {
    return { ok: false, reason: 'unverifiable' };
  }

  const next: Progress = { ...progress, receipt: { text, issuedAt: Date.now() } };
  await writeProgress(origin, next);
  store.progress.value = next;
  store.receiptText.value = text;
  track('sa_training_receipt_issue');
  return { ok: true, text };
}

// Error boundary. whoami(), the check fetches and the progress writes all
// reject on the most ordinary failure there is — an expired token — and this is
// the LAST action of the whole track. Without this, that rejection escapes into
// the click handler, the panel's `busy` is never cleared, and the button sits
// disabled reading "Checking…" forever with nothing said.
export async function mintReceipt({ get, whoami, now = () => new Date() }: Partial<MintDeps> & Pick<MintDeps, 'get' | 'whoami'>) {
  try {
    return await mint({ get, whoami, now });
  } catch (e) {
    return { ok: false, reason: 'error', message: String((e as any)?.message || e) };
  }
}
