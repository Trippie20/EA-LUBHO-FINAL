@echo off
cd /d "%~dp0"
:loop
python lubho_agent.py --config config.json
timeout /t 10 >nul
goto loop
