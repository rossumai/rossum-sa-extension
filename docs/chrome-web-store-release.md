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
