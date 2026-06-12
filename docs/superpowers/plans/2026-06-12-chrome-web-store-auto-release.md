# Chrome Web Store Auto-Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Commits:** The repo owner's standing preference is **no commits during the run, stay on `master`, no branches/worktrees.** This plan therefore has **no per-task commit steps** — each task ends at verification. A single diff review with the owner is the final task; the owner commits when they choose.

**Goal:** Add a manually-triggered GitHub Actions workflow that builds, runs tests, and — only if tests are green — uploads and publishes the extension to the Chrome Web Store, plus the docs for the one-time credential setup.

**Architecture:** A new self-contained `.github/workflows/release.yml` with a `workflow_dispatch` trigger and two jobs: `test` (build + `npm test`) and `release` (`needs: test`) that rebuilds, zips the contents of `dist/`, and runs `chrome-webstore-upload-cli`. The existing `ci.yml` is left untouched. Versioning is unchanged — `build.js`'s git-commit-count scheme is already strictly monotonic and satisfies the Store's strict-increase rule.

**Tech Stack:** GitHub Actions, Node 20, esbuild (existing), `chrome-webstore-upload-cli@4` (V2 Chrome Web Store API), `zip`, `actionlint` (local validation).

---

## File structure

| File | Responsibility | Action |
| --- | --- | --- |
| `.github/workflows/release.yml` | Manual release pipeline: gate on green tests → upload + publish | Create |
| `CLAUDE.md` | "Release Process" section now points at the workflow | Modify (Release Process section) |
| `docs/chrome-web-store-release.md` | One-time OAuth credential setup + secrets + known behaviors | Create |
| `.github/workflows/ci.yml` | Routine push/PR CI | **Unchanged** (deliberately — see Task 2 note) |
| `build.js`, `manifest.json` | Build + versioning | **Unchanged** (scheme already compliant) |

---

## Manual prerequisites (performed by the repo owner — NOT a code task)

These are documented in Task 4's `docs/chrome-web-store-release.md` and must be done **before the first release run**, but they are not automated and not part of any code commit. Listed here so the implementer knows the secrets the workflow consumes exist:

- A Google Cloud project with the **Chrome Web Store API** enabled.
- An **OAuth consent screen** configured as **External** and set to **"In production"** (the listing is owned by a personal Google account, so Internal is unavailable; External + Testing would expire the refresh token after 7 days).
- An OAuth 2.0 client + a minted **refresh token** (scope `https://www.googleapis.com/auth/chromewebstore`).
- **2-Step Verification** enabled on that Google account.
- Five **GitHub Actions repository secrets**: `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`, `CWS_PUBLISHER_ID`, `CWS_EXTENSION_ID`.

---

## Task 1: Ground the build, zip-root, and CLI contract locally

No file changes — this task confirms the facts the workflow depends on, on the actual machine, before writing YAML.

**Files:** none (verification only)

- [ ] **Step 1: Build and confirm the injected version**

Run:
```bash
npm ci && npm run build && cat dist/manifest.json | grep -E '"version"|"version_name"'
```
Expected: `dist/manifest.json` exists and shows a non-placeholder `"version"` like `"0.NNNN"` (the commit-count value, e.g. `"0.412"`) and a `"version_name"` git hash — i.e. NOT the source placeholder `"0.0"`.

- [ ] **Step 2: Confirm the version reflects full git history (the fetch-depth trap)**

Run:
```bash
git rev-list --count HEAD
```
Expected: a number well above 1 (the true commit count). This is the value `build.js` divides into `major.minor`. Note for Task 2: in CI a shallow checkout would make this `1` → version `0.1`, which is why the workflow pins `fetch-depth: 0`.

- [ ] **Step 3: Confirm zipping `dist/` *contents* puts manifest.json at the archive root**

Run:
```bash
cd dist && zip -r ../extension.zip . >/dev/null && cd .. && unzip -l extension.zip | grep -E 'manifest\.json$'
```
Expected: a line ending in `manifest.json` with **no `dist/` prefix** (e.g. `manifest.json`, not `dist/manifest.json`). Then clean up: `rm -f extension.zip`.

- [ ] **Step 4: Confirm the CLI command contract**

Run:
```bash
npx --yes chrome-webstore-upload-cli@4 --help
```
Expected: help text confirming `[command]` is `upload` or `publish`, "if the command is missing, it will both upload and publish", a `--source` flag ("Path to either a zip file, a crx file, or a directory to be zipped"), a `--trusted-testers` flag (publish only), and that credentials come from env vars `CLIENT_ID`, `CLIENT_SECRET`, `REFRESH_TOKEN`, `EXTENSION_ID`, `PUBLISHER_ID`. (Publishing to **public** is the default; `--trusted-testers` is opt-in.)

If any expectation in Steps 1–4 fails, STOP and reconcile with the spec before proceeding.

---

## Task 2: Create the release workflow

**Files:**
- Create: `.github/workflows/release.yml`

> **Do NOT modify `.github/workflows/ci.yml`.** Its shallow checkout is harmless because CI never publishes; the release workflow gets its own full-history checkout. Keeping CI untouched preserves the green push/PR pipeline.

- [ ] **Step 1: Write the workflow file**

Create `.github/workflows/release.yml` with exactly this content:

```yaml
name: Release

# Manual-only: a maintainer clicks "Run workflow" in the Actions tab.
# It builds, runs the tests, and — only if tests pass — uploads and
# publishes the extension to the Chrome Web Store (public).
on:
  workflow_dispatch:

# Never run two releases at once; don't cancel an in-flight publish.
concurrency:
  group: release
  cancel-in-progress: false

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # build.js derives the version from `git rev-list --count HEAD`;
          # a shallow clone would make the count 1 and the version "0.1".
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm test

  release:
    needs: test            # only runs if the test job succeeds
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # full history -> correct, monotonic version
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run build
      - name: Package dist/ contents into extension.zip
        # Zip the CONTENTS of dist/ so manifest.json lands at the archive
        # root; zipping the dist/ folder itself would nest it and fail upload.
        run: cd dist && zip -r ../extension.zip .
      - name: Upload and publish to Chrome Web Store
        # No subcommand => upload AND publish to public.
        run: npx --yes chrome-webstore-upload-cli@4 --source extension.zip
        env:
          EXTENSION_ID: ${{ secrets.CWS_EXTENSION_ID }}
          CLIENT_ID: ${{ secrets.CWS_CLIENT_ID }}
          CLIENT_SECRET: ${{ secrets.CWS_CLIENT_SECRET }}
          REFRESH_TOKEN: ${{ secrets.CWS_REFRESH_TOKEN }}
          PUBLISHER_ID: ${{ secrets.CWS_PUBLISHER_ID }}
```

- [ ] **Step 2: Validate the workflow YAML with actionlint**

Run:
```bash
command -v actionlint >/dev/null || brew install actionlint
actionlint .github/workflows/release.yml
```
Expected: actionlint exits 0 with **no output** (no syntax, expression, or schema errors). If `brew` is unavailable, validate the YAML parses instead:
```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml')); print('ok')"
```
Expected: `ok`. (GitHub also validates the file on the first dispatch.)

- [ ] **Step 3: Confirm the workflow does not alter `ci.yml`**

Run:
```bash
git status --short .github/workflows/
```
Expected: only `release.yml` shows as added (`?? .github/workflows/release.yml`); `ci.yml` is **not** listed as modified.

---

## Task 3: Update the Release Process docs in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (the `## Release Process` section)

- [ ] **Step 1: Replace the manual release steps**

Find this exact block in `CLAUDE.md`:

```markdown
## Release Process

1. `npm test` — must be fully green before packaging; fix any failures and re-run
2. `npm run build`
3. ZIP the `dist/` folder
4. Upload via https://chrome.google.com/webstore/devconsole
```

Replace it with:

```markdown
## Release Process

Releases are automated via the **Release** GitHub Actions workflow
(`.github/workflows/release.yml`), triggered manually:

1. Go to the repo's **Actions** tab → **Release** → **Run workflow** (on `master`).
2. The `test` job runs `npm ci → npm run build → npm test`. If it fails, nothing
   is published.
3. On green tests, the `release` job rebuilds, zips `dist/`, and uploads +
   publishes to the Chrome Web Store (public). Chrome review still applies
   (usually days).

One-time credential setup (Google Cloud OAuth + the five `CWS_*` GitHub secrets)
is documented in [`docs/chrome-web-store-release.md`](docs/chrome-web-store-release.md).

Notes:
- The version is derived from the git commit count (see Versioning), so each new
  commit yields a higher, valid version automatically. Re-running the workflow
  from the **same commit** fails the upload (duplicate version) — advance a
  commit to re-release.
- The manual ZIP-and-upload via the Developer Dashboard is still available as a
  fallback if the workflow is unavailable.
```

- [ ] **Step 2: Verify the edit applied cleanly**

Run:
```bash
grep -n "Run workflow" CLAUDE.md && grep -c "chrome.google.com/webstore/devconsole" CLAUDE.md
```
Expected: the `Run workflow` line is found, and the old devconsole-upload line count is `0` outside the new fallback note (i.e. the old numbered step 4 is gone). Visually confirm the section reads as the new block.

---

## Task 4: Create the credential setup guide

**Files:**
- Create: `docs/chrome-web-store-release.md`

- [ ] **Step 1: Write the doc**

Create `docs/chrome-web-store-release.md` with exactly this content:

````markdown
# Chrome Web Store release setup

The **Release** GitHub Actions workflow (`.github/workflows/release.yml`)
uploads and publishes this extension to the Chrome Web Store. It authenticates
with the Chrome Web Store API (V2) using credentials stored as GitHub Actions
secrets. This is a **one-time** setup performed by the account that owns the
published listing.

## Prerequisites

- You are signed in as the **personal Google account that owns the published
  listing** in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
- **2-Step Verification is enabled** on that Google account (required to publish
  or update an extension).

## 1. Create OAuth credentials

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create
   (or pick) a project.
2. **APIs & Services → Library →** enable the **"Chrome Web Store API"**.
3. **APIs & Services → OAuth consent screen:**
   - User type: **External**.
   - Fill the required app/contact fields.
   - Click **"Publish app"** so the publishing status becomes **"In
     production."** Do **not** leave it in **Testing** — an External + Testing
     consent screen issues refresh tokens that **expire after 7 days**, which
     would silently break the release workflow. (Internal user type is not
     available on a personal account.)
4. **APIs & Services → Credentials → Create credentials → OAuth client ID.**
   Use a **Desktop app** client (simplest; no redirect-URI setup) — or **Web
   application** with `https://developers.google.com/oauthplayground` as an
   authorized redirect URI if you prefer the OAuth Playground. Note the
   **Client ID** and **Client secret**.

## 2. Mint a refresh token

Easiest path (Desktop-app client):

```bash
npx chrome-webstore-upload-keys
```

Follow the prompts (it opens a browser to authorize the
`https://www.googleapis.com/auth/chromewebstore` scope and prints
`CLIENT_ID`, `CLIENT_SECRET`, `REFRESH_TOKEN`). Alternatively, use the
[OAuth 2.0 Playground](https://developers.google.com/oauthplayground/) with a
Web-application client.

## 3. Gather the IDs

- **Extension ID** (`EXTENSION_ID`): the 32-character item id in the store URL
  and the Developer Dashboard.
- **Publisher ID** (`PUBLISHER_ID`): your developer-account id (visible in the
  Developer Dashboard URL when signed in) — **not** the extension id.

## 4. Store the GitHub secrets

In the repo: **Settings → Secrets and variables → Actions → New repository
secret.** Create all five:

| Secret | Value |
| --- | --- |
| `CWS_CLIENT_ID` | OAuth client id |
| `CWS_CLIENT_SECRET` | OAuth client secret |
| `CWS_REFRESH_TOKEN` | Minted refresh token |
| `CWS_PUBLISHER_ID` | Publisher / developer account id |
| `CWS_EXTENSION_ID` | 32-char extension item id |

## Running a release

**Actions tab → Release → Run workflow** (on `master`). It builds, tests, and on
green tests uploads + publishes to the public listing.

## Known behaviors

- **Review always applies.** Publishing enters Chrome's review queue (usually a
  few days, occasionally weeks). Auto-publish does not skip review.
- **Re-running from the same commit fails.** The version comes from the git
  commit count, so the same commit produces the same version, which the upload
  API rejects as a duplicate. Land a new commit to release again.
- **A rejected submission is safe.** It leaves the current live listing intact;
  only the new version is blocked.
- **Rollback** (Developer Dashboard) re-publishes the immediately previous
  version under a new, higher version number, without review (~1 minute). It
  only goes one version back.
- **First run:** because the credentials have never been exercised, consider
  validating them once with an upload-only dry run before relying on the full
  publish — e.g. locally with the five env vars set:
  `npx chrome-webstore-upload-cli@4 upload --source extension.zip`
  (uploads a draft without publishing).
````

- [ ] **Step 2: Verify the doc renders and links resolve**

Run:
```bash
test -f docs/chrome-web-store-release.md && grep -c "CWS_" docs/chrome-web-store-release.md
```
Expected: file exists and the five `CWS_*` secret names appear (count ≥ 5).

---

## Task 5: Final review (no commit)

**Files:** none

- [ ] **Step 1: Review the full diff with the owner**

Run:
```bash
git status --short && echo "---" && git diff --stat
```
Expected: exactly these changes —
- `?? .github/workflows/release.yml` (new)
- `?? docs/chrome-web-store-release.md` (new)
- `?? docs/superpowers/...` (spec + this plan, new)
- ` M CLAUDE.md` (Release Process section)

- [ ] **Step 2: Confirm tests still pass and the build is clean**

Run:
```bash
npm test && npm run build
```
Expected: tests pass; build writes `dist/` with the injected version.

- [ ] **Step 3: Hand off**

Per the owner's preference, **do not commit.** Summarize the changes and the
remaining manual prerequisite (creating the five `CWS_*` secrets via the new
doc) so the owner can commit and run the first release when ready.

---

## Acceptance criteria

- `.github/workflows/release.yml` exists, validates with `actionlint`, triggers
  only on `workflow_dispatch`, runs `test` then `release` (`needs: test`), uses
  `fetch-depth: 0` in both jobs, zips `dist/` contents, and invokes
  `chrome-webstore-upload-cli@4` with the five credential env vars.
- `ci.yml` is unchanged.
- `CLAUDE.md`'s Release Process points at the workflow; the credential setup
  doc exists with all five secrets named.
- No source versioning/build changes.
- The end-to-end publish is exercised by the owner's first manual dispatch after
  the secrets are set (cannot be tested in this plan without publishing).
```
