"""Headless-Chrome end-to-end test of the real page + real API + real Python agent (simulated MT5)."""
import json, os, subprocess, sys, tempfile, time, re
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8790
BASE = f"http://127.0.0.1:{PORT}"
results = []
def check(name, cond, extra=""):
    results.append(bool(cond)); print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else " " + str(extra)))
def section(t): print("\n" + t)

srv = subprocess.Popen(["node", "tools/devserver.mjs", str(PORT)], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
for _ in range(50):
    try:
        import urllib.request; urllib.request.urlopen(BASE + "/api/setup/status"); break
    except Exception: time.sleep(0.2)
agent = None
errors = []
tmp = tempfile.mkdtemp()

def nav(page, view):
    page.evaluate("v => document.querySelector(`#sideNav [data-view=${v}], [data-view=${v}]`).click()", view)
    page.wait_for_timeout(500)

def wait_text(page, sel, pattern, timeout=20000):
    page.wait_for_function("([s,p]) => new RegExp(p, 'i').test(document.querySelector(s)?.innerText || '')", arg=[sel, pattern], timeout=timeout)

try:
  with sync_playwright() as p:
    b = p.chromium.launch()
    def newctx(**kw):
        c = b.new_context(**kw); pg = c.new_page()
        pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        pg.on("console", lambda m: errors.append(f"console: {m.text}") if m.type == "error" and "401" not in m.text and "403" not in m.text and "ERR_INTERNET_DISCONNECTED" not in m.text and "404" not in m.text and "409" not in m.text and "400" not in m.text else None)
        return c, pg
    actx, A = newctx(viewport={"width": 1280, "height": 900})

    section("First-time setup and admin sign-in")
    A.goto(BASE); A.wait_for_selector("#setupForm:not([hidden])")
    check("setup screen shown when no admin exists", True)
    check("app hidden before sign-in", A.is_hidden("#app"))
    A.fill("#setupToken", "wrong-token"); A.fill("#setupName", "Boss"); A.fill("#setupEmail", "admin@example.com"); A.fill("#setupPassword", "Admin-password-123")
    A.click("#setupSubmit"); A.wait_for_selector("#setupError:not([hidden])")
    check("wrong setup token shows an error", "wrong" in A.inner_text("#setupError").lower())
    A.fill("#setupToken", "dev-setup-token"); A.click("#setupSubmit")
    A.wait_for_selector("#app:not([hidden])")
    check("admin lands in the app", A.inner_text("#roleTag") == "SUPER ADMIN")
    check("admin sees Super Admin nav", A.is_visible("#sideNav [data-view=admin]") and A.is_visible("#sideNav [data-view=ea-studio]"))
    check("no demo/prototype wording in status", "prototype" not in A.inner_text("body").lower())
    try: wait_text(A, "#topStatus", "no host", 8000)
    except Exception: pass
    check("host status honest: no host", "no host" in A.inner_text("#topStatus").lower())

    section("Admin: hosting machine + agent")
    nav(A, "admin"); A.click("#adminTabs [data-tab=hosts]"); A.wait_for_selector("[data-act=host-new]")
    A.click("[data-act=host-new]"); A.fill("#f_name", "HP laptop"); A.click("#modalSubmit")
    A.wait_for_selector("#secretText"); token = A.inner_text("#secretText").strip()
    check("host token shown once", token.startswith("lhost_"))
    A.click("#closeModal")
    A.wait_for_timeout(300)
    check("host listed as never connected", "NEVER CONNECTED" in A.inner_text("#adminBody"))
    cfg = os.path.join(tmp, "config.json"); json.dump({"serverUrl": BASE, "token": token, "dataDir": os.path.join(tmp, "data"), "monitorSeconds": 1}, open(cfg, "w"))
    agent = subprocess.Popen([sys.executable, "-I", "agent/lubho_agent.py", "--config", cfg, "--simulate"], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    A.wait_for_timeout(2500); A.click("#adminTabs [data-tab=hosts]"); A.wait_for_timeout(600)
    check("host shows ONLINE and SIMULATED", "ONLINE" in A.inner_text("#adminBody") and "SIMULATED" in A.inner_text("#adminBody"))

    section("Member: register, permissions")
    uctx, U = newctx(viewport={"width": 1280, "height": 900})
    U.goto(BASE); U.wait_for_selector("#loginForm:not([hidden])")
    check("login shown when an admin exists", True)
    U.click("[data-auth=register]"); U.fill("#regName", "Alice"); U.fill("#regEmail", "alice@example.com"); U.fill("#regPassword", "short")
    U.evaluate("document.querySelector('#regPassword').removeAttribute('minlength')"); U.click("#registerSubmit")
    U.wait_for_selector("#registerError:not([hidden])"); check("short password rejected with message", "10" in U.inner_text("#registerError"))
    U.fill("#regPassword", "Wonderland-9921"); U.click("#registerSubmit"); U.wait_for_selector("#app:not([hidden])")
    check("member role tag", U.inner_text("#roleTag") == "MEMBER")
    check("member cannot see admin nav", not U.is_visible("#sideNav [data-view=admin]") and not U.is_visible("#sideNav [data-view=ea-studio]"))
    U.evaluate("go('admin')") if False else None
    st = U.evaluate("fetch('/api/admin/users',{headers:{'x-requested-with':'lubho'}}).then(r=>r.status)")
    check("member API call to admin route is refused", st == 403)
    st = U.evaluate("fetch('/api/admin/studio',{headers:{'x-requested-with':'lubho'}}).then(r=>r.status)")
    check("member cannot reach studio API", st == 403)
    check("overview shows zero real numbers", U.inner_text("#robotCount") == "0")

    section("Member: robot + EX5 upload")
    nav(U, "robots"); U.click("#addRobot"); U.fill("#f_name", "Jumbo Scalper"); U.fill("#f_version", "3.0"); U.click("#modalSubmit")
    U.wait_for_selector("#uploadFile"); check("robot created and detail opens", True)
    U.set_input_files("#uploadFile", files=[{"name": "bad.exe", "mimeType": "application/octet-stream", "buffer": b"MZ" + b"\0" * 50}])
    U.click("[data-act=file-upload]"); U.wait_for_selector(".toast.error.show")
    check("bad file refused with a visible error", ".ex5" in U.inner_text("#toast").lower() or "ex5" in U.inner_text("#toast").lower())
    U.set_input_files("#uploadFile", files=[{"name": "Jumbo.ex5", "mimeType": "application/octet-stream", "buffer": bytes([1]) + b"\x07" * 5000}])
    U.click("[data-act=file-upload]"); U.wait_for_selector("#modalBody td:has-text('Jumbo.ex5')")
    check("EX5 uploaded and listed", True)
    with U.expect_download() as d: U.click("[data-act=file-download]")
    check("download returns identical bytes", os.path.getsize(d.value.path()) == 5001)
    U.click("#closeModal"); U.wait_for_timeout(300)
    check("robot table shows the robot with 1 file", "Jumbo Scalper" in U.inner_text("#robotTable") and "1" in U.inner_text("#robotTable"))

    section("Member: MT5 account (honest statuses)")
    nav(U, "hosting"); U.click("[data-act=session-new]"); U.wait_for_selector("#modalBackdrop.open")
    check("cannot host before anything is ready (clear message)", "verified" in U.inner_text("#modalBox").lower() or "nothing" in U.inner_text("#modalBox").lower(), U.inner_text("#modalBox")[:150])
    U.click("#closeModal"); U.wait_for_selector("#modalBackdrop:not(.open)", state="attached")
    nav(U, "brokers"); U.click("#addBroker"); U.wait_for_selector("#modalBackdrop.open #f_server"); U.fill("#f_login", "12345678"); U.fill("#f_server", "Sim-Demo"); U.fill("#f_password", "good-password-1"); U.click("#modalSubmit")
    U.wait_for_timeout(600)
    if U.is_visible("#modalError"): print("MODAL ERROR:", U.inner_text("#modalError"), "| FIELDS:", U.eval_on_selector_all("#modalFields input,#modalFields select", "els => els.map(e => e.id + '=' + e.value)"))
    deadline = time.time() + 25; seen = ""
    while time.time() < deadline:
        nav(U, "brokers"); seen = U.inner_text("#brokerList")
        if "CONNECTED" in seen and "NOT VERIFIED" not in seen: break
        U.wait_for_timeout(1200)
    check("account shows CONNECTED only after the agent confirmed", "CONNECTED" in seen and "SIMULATED" in seen, seen[:200])
    check("password is never displayed", "good-password-1" not in U.content())
    U.click("[data-act=acct-edit]"); check("edit form does not prefill password", U.input_value("#f_password") == ""); U.click("#closeModal")
    U.fill if False else None
    section("Member: hosting start / status / stop")
    nav(U, "hosting"); U.click("[data-act=session-new]"); U.wait_for_selector("#f_fileId"); U.click("#modalSubmit")
    deadline = time.time() + 25; txt = ""
    while time.time() < deadline:
        nav(U, "hosting"); txt = U.inner_text("#sessionTable")
        if "RUNNING" in txt: break
        U.wait_for_timeout(1200)
    check("session shows RUNNING after host confirmation", "RUNNING" in txt, txt[:200])
    check("running detail says simulated", "SIMULATED" in txt)
    check("hosting badge says machine online", "ONLINE" in U.inner_text("#hostBadge"))
    U.click("[data-act=session-stop]")
    deadline = time.time() + 25
    while time.time() < deadline:
        nav(U, "hosting"); txt = U.inner_text("#sessionTable")
        if "STOPPED" in txt: break
        U.wait_for_timeout(1200)
    check("session reaches STOPPED via host", "STOPPED" in txt, txt[:200])


    section("Member: client configuration, live monitor, analytics, settings")
    nav(U, "config"); U.wait_for_selector("#configBody table")
    check("config page explains hosting-only purpose", "does not place" in U.inner_text("#configBody").lower())
    check("config page lists the stopped session", "STOPPED" in U.inner_text("#configBody") and "host default" in U.inner_text("#configBody"))
    check("live accounts are off during testing (message shown)", "switched off" in U.inner_text("#configBody").lower())
    U.click("[data-act=config-edit]"); U.wait_for_selector("#modalBackdrop.open #f_symbol")
    U.fill("#f_symbol", "XAUUSD.m"); U.select_option("#f_timeframe", "M5")
    U.set_input_files("#f_presetFile", files=[{"name": "my.set", "mimeType": "text/plain", "buffer": b"Lots=0.01\nMax=2\n"}])
    U.click("#modalSubmit"); U.wait_for_timeout(900)
    cfgtxt = U.inner_text("#configBody")
    check("configuration saved on server and shown", "XAUUSD.m" in cfgtxt and "M5" in cfgtxt and "my.set" in cfgtxt, cfgtxt[:300])
    U.click("#configBody [data-act=session-restart]")
    deadline = time.time() + 25; txt = ""
    while time.time() < deadline:
        nav(U, "hosting"); txt = U.inner_text("#sessionTable")
        if "RUNNING" in txt: break
        U.wait_for_timeout(1200)
    check("session restarted with its saved configuration reaches RUNNING", "RUNNING" in txt, txt[:200])
    deadline = time.time() + 25; mon = ""
    while time.time() < deadline:
        nav(U, "trades"); mon = U.inner_text("#monitorCards")
        if "SIMUSD" in mon: break
        U.wait_for_timeout(1200)
    check("monitor shows positions reported by the host (read-only)", "SIMUSD" in mon and "BUY" in mon, mon[:200])
    check("monitor badge says reported by host", "REPORTED BY HOST" in U.inner_text("#tmFeedBadge"))
    check("monitor has no trade buttons", U.locator("#view-trades button:has-text('Close'), #view-trades button:has-text('Buy'), #view-trades button:has-text('Sell')").count() == 0)
    nav(U, "analytics"); U.wait_for_timeout(700)
    at = U.inner_text("#analyticsBody")
    check("analytics counts real sessions", "HOSTING SESSIONS" in at and "SESSIONS PER ROBOT" in at.upper(), at[:200])
    check("analytics does not invent trade statistics", "win rate" in at.lower() and "not collected" in at.lower() and "NET PROFIT" not in at)
    check("analytics has no Super Admin platform section for members", "Platform (Super Admin)" not in at)
    nav(U, "settings"); U.wait_for_timeout(500)
    st = U.inner_text("#settingsBody")
    em = U.input_value("#settingsBody input[readonly]:nth-of-type(1)") if False else U.eval_on_selector_all("#settingsBody input[readonly]", "els => els.map(e => e.value)")
    check("profile and settings page", "alice@example.com" in em and "install" in st.lower() and "delete my account" in st.lower(), f"{em} | {st[:200]}")
    nav(A, "analytics"); A.wait_for_timeout(900)
    check("Super Admin analytics includes the platform section", "Platform (Super Admin)" in A.inner_text("#analyticsBody"))
    nav(U, "hosting"); U.click("[data-act=session-stop]")
    deadline = time.time() + 25
    while time.time() < deadline:
        nav(U, "hosting"); txt = U.inner_text("#sessionTable")
        if "STOPPED" in txt: break
        U.wait_for_timeout(1200)
    check("session stopped again", "STOPPED" in txt)

    section("Licences (admin creates, member redeems)")
    nav(A, "admin"); A.click("#adminTabs [data-tab=licences]"); A.wait_for_selector("[data-act=lic-new]"); A.click("[data-act=lic-new]")
    A.fill("#f_label", "Alice trial"); A.fill("#f_durationDays", "30"); A.click("#modalSubmit")
    A.wait_for_selector("#secretText"); key = A.inner_text("#secretText").strip()
    check("licence key generated and shown", re.match(r"^LUBHO-[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$", key) is not None, key)
    check("mailto option offered", A.locator("a[href^='mailto:']").count() == 1)
    A.click("#closeModal")
    nav(U, "licenses"); U.fill("#redeemKey", "LUBHO-AAAA-AAAA-AAAA-AAAA"); U.click("#redeemBtn"); U.wait_for_selector(".toast.error.show")
    check("wrong key shows an error", "not valid" in U.inner_text("#toast").lower())
    U.fill("#redeemKey", key); U.click("#redeemBtn"); U.wait_for_timeout(900)
    check("redeemed licence listed as ACTIVE", "ACTIVE" in U.inner_text("#licenseTable"))
    A.click("#adminTabs [data-tab=licences]"); A.wait_for_timeout(600)
    check("admin sees licence holder, not the key", "alice@example.com" in A.inner_text("#adminBody") and key not in A.content())

    section("Notifications, admin views, studio")
    nav(U, "notifications"); U.wait_for_timeout(500)
    check("member has notifications from real events", "verified" in U.inner_text("#noticeList").lower() or "running" in U.inner_text("#noticeList").lower())
    for tab, expect in [("dashboard", "System status"), ("users", "alice@example.com"), ("eas", "Jumbo Scalper"), ("files", "Jumbo.ex5"), ("accounts", "12345678"), ("sessions", "alice@example.com"), ("logs", "session.")]:
        A.click(f"#adminTabs [data-tab={tab}]"); A.wait_for_timeout(700)
        check(f"admin tab '{tab}' shows real data", expect.lower() in A.inner_text("#adminBody").lower(), A.inner_text("#adminBody")[:150])
    A.click("#adminTabs [data-tab=accounts]"); A.wait_for_timeout(500)
    check("admin monitor never shows passwords", "good-password-1" not in A.content())
    A.click("#adminTabs [data-tab=users]"); A.wait_for_timeout(500)
    A.click("[data-act=user-reset]"); A.click("#modalSubmit"); A.wait_for_selector("#secretText"); check("admin can reset a user's password", len(A.inner_text("#secretText").strip()) == 16)
    A.click("#closeModal")
    nav(A, "ea-studio"); A.wait_for_timeout(500); A.fill("#eaProjectName", "Scalper X"); A.fill("#eaCodeEditor", "// my source"); A.click("#saveEaProject"); A.wait_for_timeout(800)
    check("studio project saved on server", "Scalper X" in A.inner_text("#eaProjectList") and "SAVED" in A.inner_text("#eaSaveStatus"))
    A.reload(); A.wait_for_selector("#app:not([hidden])"); nav(A, "ea-studio"); A.wait_for_timeout(600)
    check("studio project survives reload", "Scalper X" in A.inner_text("#eaProjectList"))

    section("Sign out / sign in")
    U.reload(); U.wait_for_selector("#loginForm:not([hidden])")
    check("admin password reset signed the member out everywhere", U.is_hidden("#app"))
    U2c, U2 = newctx(viewport={"width": 1280, "height": 900})
    U2.goto(BASE); U2.wait_for_selector("#loginForm:not([hidden])")
    U2.fill("#loginEmail", "admin@example.com"); U2.fill("#loginPassword", "Admin-password-123"); U2.click("#loginSubmit"); U2.wait_for_selector("#app:not([hidden])")
    U2.click("#avatarBtn"); U2.click("[data-act=logout]"); U2.wait_for_selector("#loginForm:not([hidden])")
    check("sign out returns to login", U2.is_hidden("#app"))
    U.fill("#loginEmail", "alice@example.com"); U.fill("#loginPassword", "wrong-pass"); U.click("#loginSubmit"); U.wait_for_selector("#loginError:not([hidden])")
    check("wrong password message", "wrong" in U.inner_text("#loginError").lower())


    section("Approval of new members (Super Admin)")
    nav(A, "admin"); A.click("#adminTabs [data-tab=settings]"); A.wait_for_timeout(600)
    check("approval setting visible and off", "Approve new members" in A.inner_text("#adminBody") and "OFF" in A.inner_text("#adminBody"))
    A.click("[data-act=setting-approval]"); A.wait_for_timeout(900)
    check("approval turned on", "New registrations wait" in A.inner_text("#adminBody"))
    n_ctx, N = newctx(viewport={"width": 1280, "height": 900})
    N.goto(BASE); N.wait_for_selector("#loginForm:not([hidden])"); N.click("[data-auth=register]")
    check("register screen says accounts are checked", N.is_visible("#approvalNote"))
    N.fill("#regName", "Newbie"); N.fill("#regEmail", "newbie@example.com"); N.fill("#regPassword", "Brand-new-pass-77"); N.click("#registerSubmit")
    N.wait_for_selector("#loginForm:not([hidden])")
    check("new member is told to wait for approval, not logged in", "approve" in N.inner_text("#loginNote").lower() and N.is_hidden("#app"))
    N.fill("#loginEmail", "newbie@example.com"); N.fill("#loginPassword", "Brand-new-pass-77"); N.click("#loginSubmit"); N.wait_for_selector("#loginError:not([hidden])")
    check("pending member cannot sign in", "waiting" in N.inner_text("#loginError").lower())
    A.click("#adminTabs [data-tab=users]"); A.wait_for_timeout(800)
    check("admin sees the waiting member", "WAITING FOR APPROVAL" in A.inner_text("#adminBody"))
    A.click("[data-act=user-approve]"); A.wait_for_timeout(900)
    N.click("#loginSubmit"); N.wait_for_selector("#app:not([hidden])")
    check("approved member can sign in as a normal member", "MEMBER" in N.inner_text("#roleTag") and N.is_hidden("#sideNav [data-view=admin]"))
    N.evaluate("go('admin')")
    check("member cannot open Super Admin by script", not N.evaluate("document.querySelector('#view-admin').classList.contains('active')"))
    A.click("#adminTabs [data-tab=settings]"); A.wait_for_timeout(500); A.click("[data-act=setting-approval]"); A.wait_for_timeout(600)

    section("Responsive layout")
    for name, w, h in [("phone", 390, 844), ("tablet", 820, 1180), ("desktop", 1440, 900)]:
        c, pg = newctx(viewport={"width": w, "height": h}, device_scale_factor=1)
        pg.goto(BASE); pg.wait_for_selector("#loginForm:not([hidden])")
        pg.fill("#loginEmail", "admin@example.com"); pg.fill("#loginPassword", "Admin-password-123"); pg.click("#loginSubmit"); pg.wait_for_selector("#app:not([hidden])")
        for v in ["overview", "robots", "brokers", "hosting", "config", "trades", "analytics", "settings", "licenses", "notifications"]:
            pg.evaluate("v => document.querySelector(`[data-view=${v}]`).click()", v); pg.wait_for_timeout(400)
            over = pg.evaluate("document.documentElement.scrollWidth - window.innerWidth")
            if over > 2: check(f"{name}: no sideways scroll on {v}", False, over)
        check(f"{name}: no sideways scrolling on main views", True)
        if name == "phone":
            check("phone: bottom nav visible, sidebar hidden", pg.is_visible("#mobileNav") and not pg.is_visible(".sidebar"))
            pg.click("#mobileNav [data-act=more]"); check("phone: More sheet lists admin pages for admin", "Super Admin" in pg.inner_text("#modalBox")); pg.click("#closeModal")
            pg.screenshot(path=os.path.join(ROOT, "docs", "screenshot-phone.png"))
        if name == "desktop": pg.screenshot(path=os.path.join(ROOT, "docs", "screenshot-desktop.png"))
        c.close()

    section("PWA installability")
    pctx, P = newctx(viewport={"width": 412, "height": 800})
    P.goto(BASE); P.wait_for_selector("#loginForm:not([hidden])")
    mf = P.evaluate("fetch(document.querySelector('link[rel=manifest]').href).then(r=>r.json())")
    check("manifest valid (name, standalone, start_url)", mf["name"] == "EA LUBHO" and mf["display"] == "standalone" and mf["start_url"])
    sizes = {i["sizes"] for i in mf["icons"]}
    check("Android icons 192 and 512 declared", {"192x192", "512x512"} <= sizes)
    codes = [P.evaluate("u => fetch(u).then(r=>[r.status, r.headers.get('content-type')])", BASE + "/" + i["src"]) for i in mf["icons"]]
    check("every manifest icon loads", all(c[0] == 200 for c in codes), codes)
    check("iPhone touch icon (180px PNG) loads", P.evaluate("fetch(document.querySelector('link[rel=apple-touch-icon]').href).then(r=>r.status+r.headers.get('content-type'))") == "200image/png")
    P.evaluate("navigator.serviceWorker.ready.then(()=>1)"); 
    check("service worker registered", P.evaluate("navigator.serviceWorker.getRegistration().then(r=>!!r)"))
    cdp = pctx.new_cdp_session(P); cdp.send("Page.enable")
    errs = cdp.send("Page.getInstallabilityErrors")["installabilityErrors"]
    check("Chrome reports no installability errors", errs == [], errs)
    P.context.set_offline(True); P.reload(); P.wait_for_timeout(1200)
    check("app shell opens offline (service worker cache)", P.evaluate("!!document.querySelector('#auth')") and "EA LUBHO" in P.title())
    P.context.set_offline(False)
    st = P.evaluate("fetch('/api/me',{headers:{'x-requested-with':'lubho'}}).then(r=>r.status)"); check("API is not cached/served offline-stale", st == 401)

    section("Public landing page, SEO files and security headers")
    c_, L = newctx(viewport={"width": 390, "height": 844})
    resp = L.goto(BASE + "/home"); L.wait_for_timeout(300)
    check("landing page loads without signing in", resp.status == 200 and "MT5 Expert Advisors" in L.inner_text("h1"))
    check("landing page says it does not trade", "does not trade" in L.inner_text("main").lower())
    check("landing page canonical uses the real address", L.get_attribute("link[rel=canonical]", "href") == BASE + "/home")
    check("landing page has no sideways scrolling on a phone", L.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"))
    L.click("header a.btn.primary"); L.wait_for_selector("#loginForm:not([hidden])")
    check("landing page leads to the sign-in screen", True)
    hh = resp.headers
    check("security headers present on pages", "frame-ancestors 'none'" in hh.get("content-security-policy", "") and hh.get("x-content-type-options") == "nosniff" and hh.get("x-frame-options") == "DENY")
    rb = L.evaluate("fetch('/robots.txt').then(r=>r.text())"); check("robots.txt served", "Disallow: /api/" in rb and BASE + "/sitemap.xml" in rb)
    sm = L.evaluate("fetch('/sitemap.xml').then(r=>r.text())"); check("sitemap.xml served", BASE + "/home" in sm)

    check("no JavaScript errors or console errors during the whole run", errors == [], errors[:5])
    b.close()
finally:
    if agent: agent.kill()
    srv.kill()
print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
