@echo off
rem Element news capture: one full pass over all sources (Gemini writes under its daily cap, Groq then template as fallbacks),
rem then Trending refresh. Scheduled hourly by Windows Task Scheduler (task name ElementIngest). Log: ingest\logs\run.log
cd /d "%~dp0"
if not exist logs mkdir logs
echo ===== %date% %time% >> logs\run.log
rem Groq scores every card against the report card and runs the format check (one revision, then publish or drop).
set REPORT_CARD_PROTOCOL=1
"C:\Program Files\nodejs\node.exe" src\main.ts --once >> logs\run.log 2>&1
echo exit %errorlevel% >> logs\run.log
rem Brief AI summary: one Gemini call per day and per week (skips when today's already exists).
"C:\Program Files\nodejs\node.exe" src\main.ts --brief-summary --kind both >> logs\run.log 2>&1
echo brief-summary exit %errorlevel% >> logs\run.log
