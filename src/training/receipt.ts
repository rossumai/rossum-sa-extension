// PURE. The signing function is injected, so this module has no crypto
// dependency and both minting and validation are unit-testable. Mint and check
// share it, so they cannot disagree.

// Crockford base32: no I, L, O or U — the four characters people mistype.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_CHARS = 12; // 3 groups of 4 → 60 bits

// EVERY field renderReceipt prints is signed, the username included. It was
// omitted once, and that made the printed name free-form: anyone could take a
// colleague's receipt, swap the name for their own, and have it validate — and
// a trainer reading "Valid — issued to <name>" has no reason to cross-check the
// opaque numeric user id. Attributing a completion to a PERSON is the receipt's
// only job, so the name has to be inside the signature.
/** Every field the signature covers — omitting one is how a receipt became forgeable. */
export type ReceiptFields = {
  trackId: string;
  trackVersion: number | string;
  host: string;
  userId: number | string;
  username: string;
  /** The mission ids that passed — joined with commas in the canonical string. */
  missionsPassed: string[];
  selfCount: number;
  dateUtc: string;
};

/** What a printed receipt parses back into: the signed fields, plus the code itself. */
export type ParsedReceipt = { fields: ReceiptFields; code: string };

export type VerifyResult = { valid: boolean; fields: ReceiptFields | null };

export type SignFn = (message: string) => Promise<Uint8Array>;

export function canonicalString(f: ReceiptFields): string {
  return [
    'RSAT1',
    `${f.trackId}@${f.trackVersion}`,
    f.host,
    String(f.userId),
    String(f.username ?? ''),
    f.missionsPassed.join(','),
    String(f.selfCount),
    f.dateUtc,
  ].join('|');
}

export function formatCode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < CODE_CHARS; i++) out += ALPHABET[bytes[i] % 32];
  return `RSA1-${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

export async function mintCode(fields: ReceiptFields, sign: SignFn): Promise<string> {
  return formatCode(await sign(canonicalString(fields)));
}

export function renderReceipt(f: ReceiptFields, code: string): string {
  return [
    'ROSSUM PARTNER ONBOARDING — COMPLETION RECEIPT',
    `track          | ${f.trackId}@${f.trackVersion}`,
    `org            | ${f.host}`,
    `user           | ${f.username} (id ${f.userId})`,
    `missions       | ${f.missionsPassed.join(',')}`,
    `self-attested  | ${f.selfCount}`,
    `issued         | ${f.dateUtc}`,
    `code           | ${code}`,
  ].join('\n');
}

// `[ \t]*`, never `\s*`: \s matches a newline, so an empty field value would let
// the match cross into the next line and capture ITS content as this field's
// value — a malformed paste must fail to parse, never mis-parse.
const LINE = (label: string) => new RegExp(`^${label}[ \\t]*\\|[ \\t]*(.+)$`, 'm');

export function parseReceipt(text: unknown): ParsedReceipt | null {
  const t = String(text || '').trim();
  if (!t.startsWith('ROSSUM PARTNER ONBOARDING')) return null;
  const grab = (label: string) => {
    const m = LINE(label).exec(t);
    return m ? m[1].trim() : null;
  };
  const track = grab('track');
  const user = grab('user');
  const code = grab('code');
  if (!track || !user || !code) return null;
  const trackM = /^(.+)@(\d+)$/.exec(track);
  const userM = /^(.*)\s+\(id\s+(\d+)\)$/.exec(user);
  const missions = grab('missions');
  const self = grab('self-attested');
  const issued = grab('issued');
  const host = grab('org');
  if (!trackM || !userM || missions == null || self == null || !issued || !host) return null;
  return {
    fields: {
      trackId: trackM[1],
      trackVersion: Number(trackM[2]),
      host,
      userId: Number(userM[2]),
      username: userM[1],
      missionsPassed: missions.split(',').filter(Boolean),
      selfCount: Number(self),
      dateUtc: issued,
    },
    code,
  };
}

export async function verifyReceipt(text: unknown, sign: SignFn): Promise<VerifyResult> {
  const parsed = parseReceipt(text);
  if (!parsed) return { valid: false, fields: null };
  const expected = await mintCode(parsed.fields, sign);
  return { valid: expected === parsed.code, fields: parsed.fields };
}
