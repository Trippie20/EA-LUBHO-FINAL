# EA LUBHO

A hosting and management platform for MetaTrader 5 Expert Advisors (EAs).
**It is not a trading bot.** It never places, closes or advises on trades and has no trade buttons.
Your own EA makes every trading decision inside MetaTrader 5.

Read `docs/STATUS.md` for exactly what is finished, what was tested, and what still needs a real
Windows MT5 machine or a real Cloudflare deployment.

## What is in this folder

| Folder / file | What it is |
|---|---|
| `public/` | The website and PWA: `index.html` (the app), `home.html` (public landing page), `js/`, `css/`, `sw.js`, `manifest.webmanifest`, `icons/`, `_headers`, `_routes.json` |
| `functions/` | Cloudflare Pages Functions: `api/[[path]].js` (the API) and `_middleware.js` (security headers, robots.txt, sitemap.xml) |
| `src/` | API source code (routes, crypto, storage, hosting logic) |
| `schema.sql`, `migrations/0001_init.sql` | The database (identical copies; use the migration file) |
| `wrangler.toml` | Cloudflare configuration (contains no secrets) |
| `agent/` | The Windows host agent, `agent/README.md` explains it |
| `test/`, `tools/` | Automated tests, the local test server and the secret scanner |
| `backup/original/` | Your original EA LUBHO `index.html`, untouched |
| `docs/` | `STATUS.md` (status and test results) |

## Running the tests (needs Node 22+ and, for the browser tests, Python with Playwright)

    npm test                       # 8 backend and site suites
    python3 test/windows_driver.test.py   # agent start-file logic (runs anywhere)
    python3 test/ui.test.py        # real browser: every page, phone/tablet/desktop, PWA, headers
    node tools/secret-scan.mjs     # make sure no secrets are in the folder

---

## Deploying to Cloudflare (free, no command line needed)

Everything below can be done in a web browser. Nothing here has been deployed yet: do these steps
yourself (or together with Claude) after reviewing the files.

### Costs
Everything needed is on Cloudflare's free plan and GitHub's free plan: Pages, Pages Functions, D1 database
and the `*.pages.dev` address. Check Cloudflare's current pricing page, because limits change.
Things that **could** cost money, none of which is required:
- **R2 file storage** (optional): needs a payment method on the account; without it EX5 files go into D1 (about 3 MB each).
- **A custom domain** (e.g. `.com`): optional. The free `*.pages.dev` address works.
- **A Windows VPS** to run MetaTrader 24/7: optional. A Windows 10+ computer you already own works for testing.
- If the site gets very busy, free-plan request and database limits may be reached. Each running host agent
  contacts the server about every 10 seconds, which is roughly 8,600 requests per day per machine.

### Step 1: Scan, then put the project on GitHub
1. In this folder run `node tools/secret-scan.mjs` (or skip if you cannot run Node; the folder was scanned before delivery).
2. On github.com create a **private** repository called `EA-LUBHO-2`. Do not touch your old EA LUBHO repository.
3. Upload this folder's contents (GitHub web "Add file → Upload files", or git). `.gitignore` already excludes `node_modules`, `.dev.vars` and `*.secret`.
4. Never type `SETUP_TOKEN` or `CREDENTIAL_KEY` into GitHub.

### Step 2: Create the database
1. Cloudflare dashboard → **Storage & Databases → D1 → Create database**. Name it `ea-lubho`.
2. Copy its **Database ID**.
3. In GitHub, edit `wrangler.toml`: replace `REPLACE-WITH-YOUR-D1-DATABASE-ID` with that ID and commit. (The ID is not a secret.)

### Step 3: Create the tables
In the D1 database page open **Console**, paste the whole contents of `migrations/0001_init.sql`, and run it.
You should then see the tables (users, eas, mt5_accounts, hosting_sessions, and so on) listed.
(With Node 22+ and wrangler you could instead run `npx wrangler d1 migrations apply ea-lubho --remote`.)

### Step 4: Create the Pages project
1. **Workers & Pages → Create → Pages → Connect to Git** → choose `EA-LUBHO-2`.
2. Framework preset: **None**. Build command: leave **empty**. Build output directory: **`public`**. Save and Deploy.
3. Cloudflare reads `wrangler.toml`, so the `DB` binding and the two variables are applied from that file.
   Because that file exists, the dashboard shows those bindings as read-only; change them in the file.
   (Dashboard wording changes from time to time; if a label differs, look for the equivalent.)

### Step 5: Optional R2 storage
Skip this to stay free. Otherwise: R2 → create bucket `ea-lubho-files`, then uncomment the `[[r2_buckets]]`
block in `wrangler.toml` and commit.

### Step 6: Enter the two secrets privately (never in GitHub)
Pages project → **Settings → Variables and Secrets → Add** → type **Secret** (encrypted):

| Name | Value | Notes |
|---|---|---|
| `SETUP_TOKEN` | A long phrase you invent (20+ characters) | Needed once to create the first Super Admin. Nothing is built in. |
| `CREDENTIAL_KEY` | 32 random bytes, base64 | Encrypts saved MT5 passwords. **Back it up somewhere safe.** If you lose it, saved MT5 passwords cannot be decrypted. If it leaks, treat all saved broker passwords as exposed. |

Generate `CREDENTIAL_KEY` on your own computer. In PowerShell:

    $b=New-Object byte[] 32; (New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($b); [Convert]::ToBase64String($b)

Then trigger a new deployment (Deployments → Retry, or push a small commit) so the secrets take effect.

### Variables kept in `wrangler.toml`

| Name | Default | Meaning |
|---|---|---|
| `ALLOW_LIVE_ACCOUNTS` | `"false"` | Real-money broker accounts are refused unless this is `"true"`. Keep `false` until the security review is done. |
| `REQUIRE_APPROVAL_DEFAULT` | `"true"` | New registrations wait for the Super Admin. The Super Admin can switch this in the app (Super Admin → Settings). |

### Step 7: First sign-in
Open your site. The first screen is **First-time setup**: enter the `SETUP_TOKEN`, your name, email and a password you choose.
This works only once. After it, the same address shows the normal sign-in. Members register themselves; you approve them in Super Admin → Users.

### Step 8: Add a hosting machine and run the agent
1. Super Admin → **Hosting machines → Add**. Copy the token (shown once).
2. On a Windows 10+ computer with MetaTrader 5, follow `agent/README.md`.
3. Test with a **demo** MT5 account first. Do not ask members to enter real broker passwords until a security review is done and `ALLOW_LIVE_ACCOUNTS` is turned on deliberately.

### Step 9: Make the site visible to Google (no ranking is promised)
The public page is `/home`. `robots.txt` and `sitemap.xml` are generated automatically with your real address.
1. Go to Google Search Console → add your site (the `*.pages.dev` address or your domain).
2. Verify ownership (the "HTML tag" method means adding one meta tag to `public/home.html`).
3. Submit `https://YOUR-ADDRESS/sitemap.xml`. Use "URL inspection" on `/home` and request indexing.
Indexing can take days or weeks and is not guaranteed.

### Step 10: Check on phones
Open the site on an Android phone in Chrome (menu → Install app) and on an iPhone in Safari (Share → Add to Home Screen).
Open it once online, then switch on airplane mode: the app shell should still open (data needs internet).

## Security summary
- Passwords: PBKDF2-SHA256, 100,000 rounds, per-user salt. Sessions use HttpOnly, Secure, SameSite cookies, 14 days.
- MT5 passwords: AES-256-GCM with `CREDENTIAL_KEY`; never returned by any API; decrypted only for a task a hosting machine has claimed.
- Licence keys: stored hashed, shown once. EX5 files: private, owner-only, never public URLs.
- Protection: CSRF header and origin check, login/setup rate limiting, Content-Security-Policy (no external scripts), frame blocking, nosniff, HSTS.
- Only the Super Admin can reach admin routes; this is enforced on the server, not just hidden in the page.

## Troubleshooting
- "The server is not configured": `SETUP_TOKEN` or `CREDENTIAL_KEY` is missing, or you did not redeploy after adding it.
- API errors about the database: the `DB` binding or `database_id` in `wrangler.toml` is wrong, or the migration was not run.
- Live account refused: `ALLOW_LIVE_ACCOUNTS` is `"false"` (intended).
- Session shows "unknown": the hosting machine has not reported in for 90 seconds (agent stopped, computer asleep, or offline).
