#!/usr/bin/env python3
"""EA LUBHO host agent.

Runs on the Windows machine that has MetaTrader 5 installed. It polls the EA LUBHO server for work
(verify an MT5 login, start/stop a hosted EA) and reports the REAL result. It never opens a port:
it only makes outgoing HTTPS requests, so no router/firewall changes are needed.

  python lubho_agent.py --config config.json
  python lubho_agent.py --config config.json --simulate    (tests only: no MT5, results are labelled simulated)

Standard library only. Optional: `pip install MetaTrader5` lets the agent confirm MT5 logins.
"""
import argparse
import hashlib
import json
import logging
import os
import platform
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

VERSION = "0.1.0"
log = logging.getLogger("lubho-agent")


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(f"{status}: {message}")
        self.status = status


class Api:
    def __init__(self, base, token):
        u = urllib.parse.urlparse(base)
        local = u.hostname in ("localhost", "127.0.0.1")
        if u.scheme != "https" and not local:
            raise SystemExit("serverUrl must start with https:// (http is only allowed for localhost tests).")
        self.base = base.rstrip("/")
        self.token = token

    def call(self, method, path, body=None, raw=False):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + "/api" + path, data=data, method=method)
        req.add_header("Authorization", "Bearer " + self.token)
        req.add_header("User-Agent", "lubho-agent/" + VERSION)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                payload = res.read()
                if raw:
                    return payload, res.headers
                return json.loads(payload.decode() or "{}")
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read().decode()).get("message", "")
            except Exception:
                msg = e.reason
            raise ApiError(e.code, msg)


# ---------------------------------------------------------------- drivers
class SimDriver:
    """Pretends to run MT5. Only for automated tests; every result says SIMULATED."""
    simulated = True
    mt5_found = True

    def __init__(self):
        self.alive_pids = set()
        self.next_pid = 1000

    def verify(self, account):
        if account["password"].startswith("bad"):
            return False, "SIMULATED: login rejected", None
        return True, "SIMULATED login", {"balance": 1000.0, "currency": "USD", "server": account["server"]}

    def start(self, session, ex5_path, workdir):
        self.next_pid += 1
        self.alive_pids.add(self.next_pid)
        return True, "SIMULATED terminal (no real MT5 was started)", {"pid": self.next_pid, "dir": workdir}

    def alive(self, handle):
        return handle["pid"] in self.alive_pids

    def snapshot(self, handle):
        # Fake numbers, currency "SIM", for automated tests only.
        return {"balance": 1000.0, "equity": 1002.5, "margin": 10.0, "freeMargin": 990.0, "currency": "SIM",
                "positions": [{"ticket": "1", "symbol": "SIMUSD", "type": "buy", "volume": 0.01, "openPrice": 1.0, "profit": 2.5,
                               "openedAt": int(time.time() * 1000)}]}

    def stop(self, handle):
        self.alive_pids.discard(handle["pid"])
        return True, "SIMULATED stop"


class WindowsDriver:
    simulated = False

    def __init__(self, cfg):
        self.install = cfg.get("mt5InstallDir", "")
        self.exe = os.path.join(self.install, "terminal64.exe")
        self.symbol = cfg.get("defaultSymbol", "EURUSD")
        self.period = cfg.get("defaultPeriod", "M1")
        self.wait = int(cfg.get("startupWaitSeconds", 25))
        self.mt5_found = os.path.isfile(self.exe)
        try:
            import MetaTrader5 as mt5  # noqa
            self.mt5 = mt5
        except Exception:
            self.mt5 = None

    def verify(self, account):
        if not self.mt5_found:
            return False, "MT5 is not installed at mt5InstallDir (terminal64.exe not found).", None
        if self.mt5 is None:
            return False, "The MetaTrader5 Python package is not installed on the host (pip install MetaTrader5), so logins cannot be checked.", None
        mt5 = self.mt5
        try:
            if not mt5.initialize(path=self.exe, login=int(account["login"]), password=account["password"], server=account["server"], timeout=60000):
                return False, "MT5 refused the login: %s" % (mt5.last_error(),), None
            ai = mt5.account_info()
            if ai is None:
                return False, "Logged in but no account information was returned.", None
            return True, "Login confirmed by MT5.", {
                "balance": float(ai.balance), "equity": float(ai.equity), "margin": float(ai.margin),
                "freeMargin": float(ai.margin_free), "currency": ai.currency, "company": ai.company,
                "server": ai.server, "leverage": ai.leverage, "tradeAllowed": bool(ai.trade_allowed),
            }
        finally:
            try:
                mt5.shutdown()
            except Exception:
                pass

    def start(self, session, ex5_path, workdir):
        if not self.mt5_found:
            return False, "MT5 is not installed at mt5InstallDir (terminal64.exe not found).", None
        term_dir = os.path.join(workdir, "terminal")
        if not os.path.isdir(term_dir):
            shutil.copytree(self.install, term_dir)  # one portable copy per session keeps accounts separate
        experts = os.path.join(term_dir, "MQL5", "Experts", "LUBHO")
        os.makedirs(experts, exist_ok=True)
        stem = os.path.splitext(os.path.basename(ex5_path))[0]
        shutil.copy2(ex5_path, os.path.join(experts, stem + ".ex5"))
        acc = session["account"]
        cfg = session.get("config") or {}
        symbol = re.sub(r"[^A-Za-z0-9._#@-]", "", cfg.get("symbol") or "") or self.symbol
        period = cfg.get("timeframe") or self.period
        params_line = ""
        if cfg.get("preset"):
            pname = re.sub(r"[^\w .-]", "_", os.path.basename(cfg.get("presetName") or "preset.set"))
            if not pname.lower().endswith(".set"):
                pname += ".set"
            presets = os.path.join(term_dir, "MQL5", "Presets")
            os.makedirs(presets, exist_ok=True)
            with open(os.path.join(presets, pname), "w", encoding="utf-8", newline="\r\n") as pf:
                pf.write(cfg["preset"])
            params_line = "ExpertParameters=%s\n" % pname
        ini = os.path.join(workdir, "start.ini")
        fd = os.open(ini, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write("[Common]\nLogin=%s\nPassword=%s\nServer=%s\nKeepPrivate=1\n" % (acc["login"], acc["password"], acc["server"]))
            f.write("[Experts]\nAllowLiveTrading=1\nEnabled=1\n")
            f.write("[StartUp]\nExpert=LUBHO\\%s\nSymbol=%s\nPeriod=%s\n%s" % (stem, symbol, period, params_line))
        proc = subprocess.Popen([os.path.join(term_dir, "terminal64.exe"), "/portable", "/config:" + ini],
                                cwd=term_dir, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        # The ini holds the password: remove it shortly after the terminal has read it.
        threading.Timer(90, lambda: os.path.exists(ini) and os.remove(ini)).start()
        deadline = time.time() + self.wait
        while time.time() < deadline:
            if proc.poll() is not None:
                return False, "The MT5 terminal exited right after starting (code %s)." % proc.returncode, None
            time.sleep(1)
        return True, ("Terminal process is running. (The agent can confirm the process, not the EA's trading state: "
                      "check the terminal's Experts log to see that the EA attached.)"), {"pid": proc.pid, "dir": workdir}

    def snapshot(self, handle):
        """Read-only account snapshot from a running portable terminal. Never places or changes orders.
        NOT verified against a real terminal in this build."""
        if self.mt5 is None:
            return None
        mt5 = self.mt5
        exe = os.path.join(handle["dir"], "terminal", "terminal64.exe")
        try:
            if not mt5.initialize(path=exe, portable=True, timeout=30000):
                return None
            ai = mt5.account_info()
            if ai is None:
                return None
            pos = []
            for p in (mt5.positions_get() or [])[:100]:
                pos.append({"ticket": str(p.ticket), "symbol": p.symbol, "type": "buy" if p.type == 0 else "sell",
                            "volume": float(p.volume), "openPrice": float(p.price_open), "profit": float(p.profit),
                            "openedAt": int(p.time) * 1000})
            return {"balance": float(ai.balance), "equity": float(ai.equity), "margin": float(ai.margin),
                    "freeMargin": float(ai.margin_free), "currency": ai.currency, "positions": pos}
        except Exception:
            return None
        finally:
            try:
                mt5.shutdown()
            except Exception:
                pass

    def alive(self, handle):
        out = subprocess.run(["tasklist", "/FI", "PID eq %d" % handle["pid"], "/NH"], capture_output=True, text=True).stdout
        return str(handle["pid"]) in out

    def stop(self, handle):
        subprocess.run(["taskkill", "/PID", str(handle["pid"]), "/T", "/F"], capture_output=True)
        time.sleep(1)
        if self.alive(handle):
            return False, "The terminal process is still running after taskkill."
        return True, "Terminal stopped."


# ---------------------------------------------------------------- agent
class Agent:
    def __init__(self, cfg, driver):
        self.api = Api(cfg["serverUrl"], cfg["token"])
        self.driver = driver
        self.data = os.path.abspath(cfg.get("dataDir", "data"))
        os.makedirs(os.path.join(self.data, "sessions"), exist_ok=True)
        self.state_file = os.path.join(self.data, "state.json")
        self.sessions = self._load()  # session id -> {pid, dir}
        self.monitor_every = float(cfg.get("monitorSeconds", 60))
        self.last_monitor = {}

    def _load(self):
        try:
            with open(self.state_file) as f:
                return json.load(f)
        except Exception:
            return {}

    def _save(self):
        tmp = self.state_file + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.sessions, f)
        os.replace(tmp, self.state_file)

    def running_ids(self):
        alive = [sid for sid, h in self.sessions.items() if self.driver.alive(h)]
        for sid in [s for s in self.sessions if s not in alive]:
            log.warning("session %s is no longer running", sid)
            self.sessions.pop(sid)
        self._save()
        return alive

    def collect_monitor(self, running):
        out = []
        for sid in running:
            if time.time() - self.last_monitor.get(sid, 0) < self.monitor_every:
                continue
            self.last_monitor[sid] = time.time()
            try:
                snap = self.driver.snapshot(self.sessions[sid])
            except Exception:
                snap = None
            if snap:
                snap["sessionId"] = sid
                out.append(snap)
        return out

    def poll_once(self):
        running = self.running_ids()
        res = self.api.call("POST", "/agent/poll", {
            "agentVersion": VERSION,
            "info": {"os": platform.platform(), "mt5Found": self.driver.mt5_found, "terminals": len(self.sessions),
                     "simulated": self.driver.simulated},
            "running": running,
            "monitor": self.collect_monitor(running),
        })
        task = res.get("task")
        if task:
            self.handle(task)
        return task is not None, int(res.get("pollSeconds", 10))

    def report(self, task, ok, detail, info=None):
        body = {"ok": ok, "detail": detail}
        if info:
            body["info"] = info
        self.api.call("POST", "/agent/tasks/%s/result" % task["id"], body)

    def handle(self, task):
        log.info("task %s %s", task["id"], task["type"])  # never log the payload: it holds a password
        try:
            if task["type"] == "verify_account":
                ok, detail, info = self.driver.verify(task["account"])
                self.report(task, ok, detail, info)
            elif task["type"] == "start_session":
                self.start_session(task)
            elif task["type"] == "stop_session":
                self.stop_session(task)
            else:
                self.report(task, False, "Unknown task type.")
        except Exception as e:  # report instead of crashing; keep the message free of secrets
            log.exception("task failed")
            try:
                self.report(task, False, "Agent error: %s" % type(e).__name__)
            except Exception:
                pass

    def start_session(self, task):
        sid = task["sessionId"]
        f = task["file"]
        workdir = os.path.join(self.data, "sessions", re.sub(r"[^\w-]", "_", sid))
        os.makedirs(workdir, exist_ok=True)
        data, headers = self.api.call("GET", "/agent/files/" + urllib.parse.quote(f["id"]), raw=True)
        if hashlib.sha256(data).hexdigest() != f["sha256"]:
            return self.report(task, False, "The downloaded EX5 does not match its checksum; not started.")
        name = re.sub(r"[^\w .()+-]", "_", os.path.basename(f["filename"]))
        if not name.lower().endswith(".ex5"):
            return self.report(task, False, "Unexpected file name.")
        ex5 = os.path.join(workdir, name)
        with open(ex5, "wb") as fh:
            fh.write(data)
        ok, detail, handle = self.driver.start(task, ex5, workdir)
        if ok:
            self.sessions[sid] = handle
            self._save()
        self.report(task, ok, detail)

    def stop_session(self, task):
        sid = task["sessionId"]
        handle = self.sessions.get(sid)
        if not handle:
            return self.report(task, True, "Nothing was running for this session on the host.")
        ok, detail = self.driver.stop(handle)
        if ok:
            self.sessions.pop(sid, None)
            self._save()
        self.report(task, ok, detail)

    def run(self, once=False):
        backoff = 5
        while True:
            try:
                busy, wait = self.poll_once()
                backoff = 5
                if once:
                    return
                time.sleep(0.5 if busy else wait)
            except ApiError as e:
                log.error("server said %s", e)
                if e.status == 401:
                    log.error("The host token was rejected. Check config.json.")
                time.sleep(backoff)
                backoff = min(backoff * 2, 120)
            except Exception as e:
                log.error("cannot reach server: %s", type(e).__name__)
                if once:
                    raise
                time.sleep(backoff)
                backoff = min(backoff * 2, 120)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--simulate", action="store_true", help="tests only: do not touch MT5")
    ap.add_argument("--once", action="store_true", help="poll one time and exit")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    with open(args.config) as f:
        cfg = json.load(f)
    if not cfg.get("serverUrl") or not cfg.get("token"):
        raise SystemExit("config.json needs serverUrl and token.")
    driver = SimDriver() if args.simulate else WindowsDriver(cfg)
    if args.simulate:
        log.warning("SIMULATION MODE: no real MT5 is used. Never run this against your real site.")
    Agent(cfg, driver).run(once=args.once)


if __name__ == "__main__":
    main()
