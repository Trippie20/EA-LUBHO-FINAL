# EA LUBHO: what is done, tested and still pending

EA LUBHO is a hosting-and-management platform. It has no trade execution, no trade buttons, and no invented statistics.

## Completed features (by module)

| Module | What exists |
|---|---|
| Master Robot Hub | Create/edit/delete robots, versions, compiled EX5 upload/download (private, owner-only), per-user list |
| Client Trading Configuration | Per-session symbol, timeframe and optional preset (.set) saved on the server and passed to MetaTrader by the host agent; edit while stopped, restart with saved settings |
| Live Trade Monitor | Read-only balance, equity, margin and open positions as reported by the hosting machine (kept 14 days). Labelled as reported by host; shows "not reporting" when stale. No trade buttons |
| Super Admin Dashboard | Platform stats (users, waiting approval, robots, sessions, hosts), system status, tabs for hosts, sessions, accounts, users, licences, EAs, logs, settings |
| Analytics Centre | Member: own sessions, hosted time, robots. Super Admin: platform totals, 30-day charts, most hosted robots. All counted from stored data; win rate and trade profit are stated as not collected |
| Notifications Centre | Per-user and admin notifications, unread dot, mark read |
| EA Cloud Hosting | Start / stop / restart / delete sessions, honest statuses (requested, starting, running, stopping, stopped, failed, unknown), limits of 5 active sessions per user |
| EA Development Studio | Save/edit/delete your MQL5 source projects on the server (storage only; nothing is compiled here) |
| Profile & Settings | View profile, edit name, change password (signs out other devices), install-app help, delete account |
| User Management | List/search, approve/reject new registrations, suspend (stops their sessions), restore, temporary password reset, delete |
| EA Catalogue Management | Admin publishes/unpublishes robots; members see the published catalogue |
| Licence Management | Create keys (shown once, stored hashed), redeem (starts trial clock), suspend/restore/revoke, reset bound accounts, public validation endpoint with rate limiting |
| Hosting Machine Management | Add machines (token shown once), rotate token, rename, delete, online/offline from last contact |
| Activity Logs | Server-side log of sign-ins, admin actions, hosting actions; secrets are never logged |
| Dashboard Statistics | Real counts only |
| Accounts & security | Super Admin created once via `SETUP_TOKEN`; separate member accounts; approval switch; server-enforced roles; encrypted MT5 passwords; live accounts locked by default |
| Platform | Cloudflare Pages + D1 (R2 optional) configuration, security headers/CSP, public landing page `/home`, `robots.txt`, `sitemap.xml`, canonical and social tags, PWA (manifest, icons incl. maskable and iPhone, offline app shell) |
| Windows host agent | Polls server, verifies accounts, starts/stops MT5 terminals with the EA, symbol, timeframe and preset, reports read-only account snapshots. `--simulate` mode for tests only, always labelled SIMULATED |

## Automated test results (this build)

| Suite | Result |
|---|---|
| auth (setup, register, login, rate limits, CSRF, sessions) | 31/31 |
| v5 (approval, hosting config, monitor, analytics, settings, live-account lock) | 44/44 |
| eas (EX5 upload/download/delete, permissions, D1 and R2) | 62/62 |
| hosting (accounts, agent protocol, sessions, licences-in-hosting, stale tasks) | 88/88 |
| backend (licences, hosts, users, notifications, logs, stats, studio) | 106/106 |
| e2e-agent (real Python agent over real HTTP, simulated MT5) | 9/9 |
| site (headers/CSP, robots, sitemap, middleware, wrangler.toml, migration equals schema, backup untouched) | 21/21 |
| windows_driver (start-file contents, symbol injection protection, preset file) | 0 failures |
| browser (real Chromium: every page and button reachable, forms, permissions, uploads, hosting, licences, approval, phone/tablet/desktop layout, PWA installability, offline shell, landing page, headers, no console errors) | 94/94 |

Secret scan: no keys, tokens, `.env` files, EX5 files or databases in the project.
Original `backup/original/index.html` is unchanged (SHA-256 `01e03f04…6efa`).

## Still requires real-world testing (not possible in this build)

1. **A real MetaTrader 5 terminal on Windows 10+ with a DEMO account.** The agent's start-file format (`/portable /config`), EA launch, terminal detection, login verification and snapshot reading are written to MetaTrader's documented behaviour but have never run against real MT5. Until you test this, treat real hosting as unproven. Results labelled SIMULATED come from the test stand-in only.
2. **A real Cloudflare deployment.** Tests use a SQLite stand-in for D1 and an in-memory R2. `wrangler.toml`, `_routes.json`, `_headers` and the middleware are validated for syntax and logic but have not been deployed. Pages dashboard wording may differ from the README.
3. **PWA on real phones.** Chrome's installability checks and offline shell pass in automated Chromium; Android install prompt and iPhone "Add to Home Screen" need a real device.
4. **Google Search Console** indexing (needs the live address). No ranking is promised.
5. **A security review / penetration test** before any real broker password is stored or `ALLOW_LIVE_ACCOUNTS` is set to `"true"`.
6. **Load behaviour** on free-plan limits with several hosting machines.

## Limits and not built
- No email: no verification or password-reset emails; the Super Admin hands out temporary passwords.
- No trade history, win rate or profit statistics: EA LUBHO does not record individual trades.
- No in-browser MQL5 compiler: the Studio stores source text only; you compile in MetaEditor and upload the EX5.
- EX5 size: about 3 MB per file in D1, about 20 MB with R2.
- If the host machine or agent restarts, previously running terminals are no longer tracked; sessions show failed until started again.
- Windows 8.1 is not supported by current MT5/Python builds; use Windows 10 or newer for the host.
