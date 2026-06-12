# Automated Chrome Web Store release on green tests — design

**Date:** 2026-06-12
**Status:** Approved (design); pending implementation plan
**Author:** Martin Zlámal (with Claude)

## Goal

Let a maintainer release the extension to the Chrome Web Store with a single
manual action, gated on a fresh green test run, without the current manual
`build → zip → upload via Developer Dashboard` ritual.

## Decisions (locked with the user)

| Decision | Choice |
| --- | --- |
| **Trigger** | Manual button — GitHub Actions `workflow_dispatch`. No auto-release on push. |
| **Publish scope** | Upload **and** auto-publish to **public** (enters Chrome review, ships when approved). The manual click is the human gate. |
| **Tool** | `chrome-webstore-upload-cli` (fregante), run via `npx`, pinned to major `@4`. |
| **Workflow structure** | New self-contained `release.yml` (Approach A). `ci.yml` is left untouched. |
| **Listing owner** | A **personal Google account** owns the published listing. Internal user type is unavailable → consent screen must be **External + "In production."** |

## Verified facts this design rests on

All verified against official Google docs / tool sources on 2026-06-12 and
cross-checked by independent fact-checkers.

1. **Versioning is already compatible.** `build.js` derives `manifest.version`
   from `git rev-list --count HEAD` as `floor(count/65535).(count%65535)`. This
   is **strictly monotonic** across every 65535 rollover boundary (brute-force
   verified over commit counts 1–200000, zero ordering violations under Chrome's
   left-to-right integer comparison). It therefore satisfies the Store's "each
   uploaded version must be strictly greater than the published one" rule with
   **no changes**. `version_name` (git short hash) is display-only and ignored
   by Store ordering.
   - Sources: developer.chrome.com/docs/extensions/reference/manifest/version,
     developer.chrome.com/docs/webstore/update, build.js:8–24.

2. **The CLI targets the V2 API** (`chromewebstore.googleapis.com`), so it
   survives the **V1 sunset on 2026-10-15**. No tool migration looms.
   - Sources: github.com/fregante/chrome-webstore-upload (readme — V2 endpoints),
     developer.chrome.com/blog/cws-api-v2.

3. **Five credentials required** (V2 needs `PUBLISHER_ID`): `CLIENT_ID`,
   `CLIENT_SECRET`, `REFRESH_TOKEN`, `PUBLISHER_ID`, `EXTENSION_ID`.
   - Sources: github.com/fregante/chrome-webstore-upload-cli (Environment
     Variables — all four listed as required), plus `EXTENSION_ID`.

4. **Upload and publish are separate API calls.** The default CLI command (no
   subcommand) does both; `upload`/`publish` subcommands exist for a
   draft-only or publish-only split if ever needed.
   - Sources: developer.chrome.com/docs/webstore/api/v1 ("The draft revision of
     the item will be updated but it won't be sent for review until you call
     publish"), developer.chrome.com/docs/webstore/using-api.

5. **The 7-day refresh-token trap.** A Google OAuth consent screen of type
   **External** with publishing status **Testing** issues refresh tokens that
   **expire after 7 days** (the `chromewebstore` scope is *not* in the exempt
   name/email/profile set). CI would silently break after a week. Avoid by
   either setting the consent screen to **In production** (click "Publish app")
   or using **Internal** user type (Google Workspace orgs only).
   - Sources: developers.google.com/identity/protocols/oauth2 (verbatim),
     support.google.com/cloud/answer/15549945.

6. **2-Step Verification** must be enabled on the publishing Google account to
   publish or update an extension.
   - Source: developer.chrome.com/docs/webstore/using-api.

7. **Zip the *contents* of `dist/`** (manifest.json at the archive root), not the
   `dist/` folder. A nested manifest fails upload.
   - Source: developer.chrome.com/docs/webstore/prepare ("place the manifest
     file in the root directory, not in a folder").

8. **Shallow checkout breaks the version.** `actions/checkout` defaults to a
   depth-1 clone; `git rev-list --count HEAD` then returns `1` → version `0.1`.
   The release job **must** use `fetch-depth: 0`. (The existing `ci.yml` has the
   same shallow checkout, but it is harmless there because CI never publishes.)

9. **Review always applies; failures are safe.** Auto-publish does not skip
   Chrome review (typically days, occasionally weeks). A rejected submission
   leaves the current live listing intact. Re-running from the *same commit*
   fails the upload as a duplicate version. Built-in rollback re-ships the prior
   version under a new higher number, one step back, without review (~1 min).
   - Sources: developer.chrome.com/docs/webstore/review-process,
     developer.chrome.com/docs/webstore/rollback,
     developer.chrome.com/docs/webstore/using-api.

## Architecture

A single new workflow file, additive — nothing existing changes behaviorally.

```
.github/workflows/release.yml   (NEW)
  on: workflow_dispatch
  concurrency: { group: release, cancel-in-progress: false }

  job test:
    - checkout (fetch-depth: 0)
    - setup-node 20, cache npm
    - npm ci
    - npm run build
    - npm test

  job release:
    needs: test           # only runs if tests are green
    - checkout (fetch-depth: 0)
    - setup-node 20, cache npm
    - npm ci
    - npm run build                      # produces dist/ with injected version
    - zip the CONTENTS of dist/ -> extension.zip   (manifest.json at root)
    - npx --yes chrome-webstore-upload-cli@4 <default upload+publish>
        --source extension.zip
      env:
        EXTENSION_ID:  ${{ secrets.CWS_EXTENSION_ID }}
        CLIENT_ID:     ${{ secrets.CWS_CLIENT_ID }}
        CLIENT_SECRET: ${{ secrets.CWS_CLIENT_SECRET }}
        REFRESH_TOKEN: ${{ secrets.CWS_REFRESH_TOKEN }}
        PUBLISHER_ID:  ${{ secrets.CWS_PUBLISHER_ID }}
```

Notes:
- `ci.yml` is unchanged and keeps running on push/PR to `master`.
- The release workflow runs its own `test` job so the green-tests gate is on the
  *exact commit being released*, not a separate prior CI run.
- The exact CLI flag for the source path (`--source` vs alternative) and whether
  the default command auto-publishes to public must be confirmed against the
  pinned CLI version during implementation.

## One-time manual setup (documented, not automated)

A maintainer performs this once; CI never sees the OAuth playground.

1. The published listing is owned by a **personal Google account** (confirmed).
   Sign in as that account for all steps below.
2. In a Google Cloud project: **enable the "Chrome Web Store API."**
3. Configure the **OAuth consent screen** as **External**, then click **"Publish
   app"** so the publishing status is **In production** — this is what removes
   the 7-day refresh-token expiry. Do **not** leave it in *Testing*. (Internal
   user type is not available on a personal account.)
4. Create an **OAuth 2.0 client** and mint a **refresh token** (e.g. via
   `npx chrome-webstore-upload-keys`, or the OAuth Playground per the official
   doc). Scope: `https://www.googleapis.com/auth/chromewebstore`.
5. Ensure **2-Step Verification** is enabled on that Google account.
6. Find `PUBLISHER_ID` (developer/publisher account id, Dashboard URL) and
   `EXTENSION_ID` (32-char item id, store URL / Dashboard).
7. Store all five as **GitHub Actions repository secrets**: `CWS_CLIENT_ID`,
   `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`, `CWS_PUBLISHER_ID`,
   `CWS_EXTENSION_ID`.

## Documentation changes

- **`CLAUDE.md` → "Release Process":** replace the manual `npm test → npm run
  build → ZIP dist → upload via devconsole` steps with: "Click **Run workflow**
  on the **Release** workflow (Actions tab). It builds, tests, and on green
  tests uploads + publishes to the Chrome Web Store." Keep a one-line pointer to
  the credential setup doc.
- **New `docs/chrome-web-store-release.md`:** the one-time OAuth setup above
  (External + "In production" consent screen), the five secrets, the 2FA
  requirement, and the known behaviors (duplicate-version on same-commit
  re-run, review latency, rejection leaves listing intact, rollback).

## Out of scope (YAGNI)

- No versioning changes (scheme already compliant).
- No trusted-testers / staged-publish / percentage rollout.
- No auto-retry / cancel-and-resubmit (cancel+resubmit actually slows Chrome
  review).
- No change to `ci.yml`'s shallow checkout (harmless there; only the release
  workflow needs full history).

## Backward compatibility

- Purely additive: a new workflow + docs. No existing build, test, version, or
  CI behavior changes.
- The git-commit-count version scheme is preserved and already satisfies the
  Store's strict-increase requirement.
- The chosen tool is on the V2 API, so it keeps working past the 2026-10-15 V1
  sunset.

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Refresh token silently expires after 7 days | Consent screen Internal or In-production; documented explicitly. |
| Shallow checkout → wrong (low) version | `fetch-depth: 0` in both jobs. |
| Nested manifest in zip → upload fails | Zip the *contents* of `dist/`. |
| Re-run from same commit → duplicate-version upload error | Documented as expected; advance a commit to re-release. |
| A broken build reaches the public | Manual trigger + own test gate; Chrome review is an additional backstop; one-step rollback available. |
| Supply-chain (floating `npx` latest) | Pin CLI to a major (`@4`). |
