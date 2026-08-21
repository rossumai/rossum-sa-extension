// src/training/steps.ts
// PURE. Evaluation only — the curriculum lives in track.js, so a syllabus
// rewrite never touches this file and these rules are testable without it.
import { detectResource } from '../devtools/detect.js';
import {
  hookQueuePairs, fieldCount, ruleIds, thresholds, collectionCount,
  grew, changed,
} from './baseline.js';
import type { TrackStep } from './track.js';

// A `visit` step names a resource TYPE from the live-verified route table in
// src/devtools/detect.js. `detail: true` requires a detail route (the
// descriptor carries an id); `detail: false` requires a list route.
export function evaluateVisit(step: TrackStep, location: { pathname: string; search?: string }): boolean {
  const found = detectResource(location);
  if (!found) return false;
  const want: { type?: string; detail?: string | boolean } = step.target || {};
  if (found.type !== want.type) return false;
  if (want.detail === true) return found.id != null;
  if (want.detail === false) return found.id == null;
  return true;
}

// EVERY /api/v1/ check reads EVERY page (`paginate: true` below), and NONE of
// them orders. Both halves of that are deliberate:
//
// Why one page is not enough — Rossum list endpoints default to ascending id,
// so on an org past one page the thing the trainee just CREATED lands on the
// LAST page and a first-page check never sees it. Not hypothetical: the org
// this track was verified against holds 96 rules and 133 schemas, so
// `schemaFieldAdded` was already counting the wrong total there.
//
// Why not `ordering=-id` — it was tried, and it is worse than the ascending
// default for `thresholdChanged`. `changed()` only fires for a queue present in
// BOTH snapshots, and that step's own teaching text says "we confirm the value
// moved on a queue that ALREADY EXISTED" — precisely the queues newest-first
// excludes. It converted a partial gap into a targeted one, failing the way
// this feature keeps failing: never ticks, forever, nothing surfaced. It is
// also unverified — DRF's OrderingFilter silently IGNORES a field it does not
// expose, so a wrong guess here breaks the delta with no error anywhere.
// `pagination.next` is the opposite: a contract already followed by shipping
// code (`src/galaxy/api.js` `listAll`). Reading all pages also removes the
// old-hook-vs-new-hook trade on `hookAttachedToQueue` — with every page in the
// signature there is no trade left.
//
// Cost on that same org: rules 1 page, queues 1, hooks 1, schemas 2. One extra
// GET, and only while the step that needs it is the current one.
const HOOKS = '/api/v1/hooks?page_size=100';
const QUEUES = '/api/v1/queues?page_size=100';
const RULES = '/api/v1/rules?page_size=100';
const SCHEMAS = '/api/v1/schemas?page_size=100';
// Data Storage. VERIFIED LIVE 2026-08-07 against the shipping client
// (src/mdh/api.js builds `${serviceBase}/api/v1${path}`): the endpoint is a
// POST, authenticated with `Bearer` — NOT the `Token` scheme /api/v1/ uses —
// and it answers 401 (not 404) unauthenticated, which is what an existing
// auth-gated route looks like. It differs from every other check on three axes
// (method, auth scheme, path prefix), which is why it needs its own helper.
const COLLECTIONS = '/svc/data-storage/api/v1/collections/list';
const COLLECTIONS_BODY = { filter: null, nameOnly: true };

// One `api` check: which paths to read, how to reduce the responses to a signature, and how to
// compare that signature against the mission-start baseline. `method`/`body`/`auth` are optional
// and default to a token-authed GET (only `collectionAdded` sets them).
export type Check = {
  id: string;
  paths: string[];
  paginate?: boolean;
  method?: string;
  body?: unknown;
  auth?: string;
  signature: (r: Record<string, any>) => unknown;
  pass: (before: any, after: any) => boolean;
};

export const CHECKS: Record<string, Check> = {
  hookAttachedToQueue: {
    id: 'hookAttachedToQueue',
    paths: [HOOKS],
    paginate: true,
    signature: (r: Record<string, any>) => hookQueuePairs(r[HOOKS]),
    pass: grew,
  },
  schemaFieldAdded: {
    id: 'schemaFieldAdded',
    // Org-wide field count across every schema. Counting all schemas avoids
    // having to resolve "the queue the trainee happens to be on" at check time,
    // and a delta still means the trainee added a field somewhere. Names are
    // never recorded — only how many fields exist.
    paths: [SCHEMAS],
    paginate: true,
    signature: (r: Record<string, any>) => (r[SCHEMAS]?.results || []).reduce((n: number, s: any) => n + fieldCount(s), 0),
    pass: grew,
  },
  ruleCreated: {
    id: 'ruleCreated',
    paths: [RULES],
    paginate: true,
    signature: (r: Record<string, any>) => ruleIds(r[RULES]),
    pass: grew,
  },
  thresholdChanged: {
    id: 'thresholdChanged',
    paths: [QUEUES],
    // The check this matters most for: `changed()` only fires for a queue in
    // BOTH snapshots, and the step asks the trainee to move a threshold on a
    // queue that already existed — i.e. an OLD one.
    paginate: true,
    signature: (r: Record<string, any>) => thresholds(r[QUEUES]),
    pass: changed,
  },
  collectionAdded: {
    id: 'collectionAdded',
    paths: [COLLECTIONS],
    // The only check that is not a plain GET on /api/v1/. These three optional
    // fields keep the `paths` contract uniform: every caller does
    // `get(path, { method, body, auth })` and the defaults ('GET', undefined,
    // 'token') reproduce every other check exactly.
    method: 'POST',
    body: COLLECTIONS_BODY,
    auth: 'bearer',
    signature: (r: Record<string, any>) => collectionCount(r[COLLECTIONS]),
    pass: grew,
  },
};


// Hard stop on the page walk. 50 pages x 100 = 5000 schemas; a malformed or
// self-referential `next` must not spin a content script forever.
const MAX_PAGES = 50;

// `pagination.next` is an ABSOLUTE url. Both fetchers take a path (the content
// script's `safeApiUrl` allowlist rejects absolute urls outright, and the
// Academy's fetcher prefixes the domain), so reduce it to path+query.
function relativePath(next: unknown): string | null {
  try {
    const u = new URL(String(next), 'https://placeholder.invalid');
    return `${u.pathname}${u.search}`;
  } catch { return null; }
}

// The ONE place a check's paths are fetched — used by the content script's
// baseline capture, its per-tick evaluation, and the Academy's mint-time
// re-verification, so all three agree on what a check reads. Keeping the page
// walk here is what stops it being implemented three times (or, worse, twice).
export async function collectResponses(
  check: Check,
  get: (path: string, check: Check) => Promise<any>,
): Promise<Record<string, any>> {
  const responses: Record<string, any> = {};
  for (const p of check.paths) {
    let data = await get(p, check);
    if (check.paginate) {
      const results = [...(data?.results || [])];
      let next = data?.pagination?.next;
      for (let page = 0; next && page < MAX_PAGES; page++) {
        const rel = relativePath(next);
        if (!rel) break;
        const body = await get(rel, check);
        results.push(...(body?.results || []));
        next = body?.pagination?.next;
      }
      data = { ...data, results };
    }
    responses[p] = data;
  }
  return responses;
}

export function signatureFor(checkId: string, responses: Record<string, any>) {
  return CHECKS[checkId].signature(responses);
}

export function evaluateApi(check: Check, sigNow: unknown, baseline: unknown): boolean {
  if (baseline == null) return false;
  return check.pass(baseline, sigNow);
}
