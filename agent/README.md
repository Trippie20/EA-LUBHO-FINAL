# EA LUBHO Windows host agent

Runs on the Windows computer that has MetaTrader 5 (your HP laptop now, a Windows VPS later).

## Setup
1. Windows 10 or newer is recommended (current MT5 and Python builds do not support Windows 8.1).
2. Install Python 3.10+ from python.org (tick "Add to PATH"). Optional: `pip install MetaTrader5` (lets the agent confirm MT5 logins).
3. Install MetaTrader 5 once and note its folder (default `C:\Program Files\MetaTrader 5`).
4. In EA LUBHO: Super Admin → Hosting machines → Add. Copy the token (shown once).
5. Copy `config.example.json` to `config.json` and set `serverUrl`, `token`, `mt5InstallDir`.
6. Double-click `start-agent.bat` (restarts the agent if it stops). Leave it running.

## Behaviour
- Only makes outbound HTTPS calls; no ports are opened on your computer.
- MT5 passwords reach the agent only inside a task it has claimed; the start file is removed after launch and the agent never logs passwords.
- A session is reported "running" only after the agent confirms it; a lost terminal is reported as failed, never as running.
- `--simulate` exists for automated tests only. Every result it sends is labelled SIMULATED and the site shows that.

## Not yet proven
This agent has NOT been run against a real MetaTrader 5 terminal in this build (needs Windows). Test with a DEMO
account first. MT5's start-up options and log wording can differ between builds. Investor (read-only) passwords can
verify a login, but an EA cannot trade with them.
