"""Checks what the Windows driver writes for MetaTrader (start file, preset) using a stand-in terminal
script on Linux. This proves the file contents the agent produces, NOT that real MT5 accepts them."""
import os, sys, stat, tempfile, time, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "agent"))
import lubho_agent as a

fails = 0
def check(name, cond, extra=""):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name, "" if cond else extra)
    fails += 0 if cond else 1

tmp = tempfile.mkdtemp()
inst = os.path.join(tmp, "mt5"); os.makedirs(inst)
exe = os.path.join(inst, "terminal64.exe")
open(exe, "w").write('#!/bin/sh\ncp "${2#/config:}" "$PWD/seen.ini"\nsleep 30\n')
os.chmod(exe, 0o755)
d = a.WindowsDriver({"mt5InstallDir": inst, "startupWaitSeconds": 2, "defaultSymbol": "EURUSD", "defaultPeriod": "M1"})
work = os.path.join(tmp, "w"); os.makedirs(work)
ex5 = os.path.join(work, "Jumbo.ex5"); open(ex5, "wb").write(b"\x01" * 50)
task = {"account": {"login": "123", "password": "pw-secret", "server": "S-Demo"},
        "config": {"symbol": "XAUUSD.m", "timeframe": "M5", "presetName": "my preset.set", "preset": "Lots=0.01\nMax=2\n"}}
ok, detail, handle = d.start(task, ex5, work)
check("terminal started", ok, detail)
seen = open(os.path.join(work, "terminal", "seen.ini")).read()
check("symbol and period come from the client configuration", "Symbol=XAUUSD.m" in seen and "Period=M5" in seen, seen)
check("expert and preset referenced", "Expert=LUBHO\\Jumbo" in seen and "ExpertParameters=my preset.set" in seen, seen)
check("preset file written", open(os.path.join(work, "terminal", "MQL5", "Presets", "my preset.set")).read().replace("\r\n", "\n") == "Lots=0.01\nMax=2\n")
check("EX5 copied into MQL5/Experts/LUBHO", os.path.isfile(os.path.join(work, "terminal", "MQL5", "Experts", "LUBHO", "Jumbo.ex5")))
check("start file is private (0600)", stat.S_IMODE(os.stat(os.path.join(work, "start.ini")).st_mode) == 0o600)
os.kill(handle["pid"], 9)
# defaults when no configuration is sent
work2 = os.path.join(tmp, "w2"); os.makedirs(work2); ex5b = os.path.join(work2, "B.ex5"); open(ex5b, "wb").write(b"1")
ok, detail, h2 = d.start({"account": task["account"]}, ex5b, work2)
seen2 = open(os.path.join(work2, "terminal", "seen.ini")).read()
check("defaults used without configuration", "Symbol=EURUSD" in seen2 and "Period=M1" in seen2 and "ExpertParameters" not in seen2)
os.kill(h2["pid"], 9)
# hostile symbol cannot inject ini lines
work3 = os.path.join(tmp, "w3"); os.makedirs(work3); ex5c = os.path.join(work3, "C.ex5"); open(ex5c, "wb").write(b"1")
ok, detail, h3 = d.start({"account": task["account"], "config": {"symbol": "EURUSD\nPassword=x"}}, ex5c, work3)
seen3 = open(os.path.join(work3, "terminal", "seen.ini")).read()
check("symbol cannot inject extra start-file lines", seen3.count("Password=") == 1, seen3)
os.kill(h3["pid"], 9)
print("%d failure(s)" % fails); sys.exit(1 if fails else 0)
