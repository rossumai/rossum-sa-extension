// Pure helpers for the "someone else is reviewing this annotation" popup
// banner. All facts verified live on elis 2026-07-16 (see the design spec):
// the lock IS status==='reviewing'; the holder IS modified_by; a missing
// modified_by means we cannot attribute the lock, so we stay silent.

export function isLockedByOther(
  { status, modifiedBy, meUrl }: { status?: string | null; modifiedBy?: string | null; meUrl?: string | null },
): boolean {
  return status === 'reviewing' && !!modifiedBy && !!meUrl && modifiedBy !== meUrl;
}

// Plain display name for the lock holder: "First Last", else the username,
// else the generic fallback (rendered verbatim in the title "Locked by …").
export function pickHolderName(
  user?: { first_name?: string; last_name?: string; username?: string } | null,
): string {
  if (!user || typeof user !== 'object') return 'another user';
  const full = [user.first_name, user.last_name]
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join(' ');
  return full || (user.username || '').trim() || 'another user';
}
