# Ledger — Birr Ledger on Google Apps Script

Cash-flow ledger. Data is stored in **your** Google Sheet, receipts in **your** Google Drive.
Up to ~10 people use it through a web link with an app username + password — they never get
access to the Sheet, the Drive folder or the script.

| Path | What it is |
|---|---|
| `apps-script/Code.gs` | Server: login, per-user ledgers, Drive uploads, admin user management |
| `apps-script/Index.html` | The app (your original HTML, now server-backed) |
| `apps-script/appsscript.json` | Manifest: runs as you, public URL, Sheets + Drive scopes |
| `original/birr-ledger.html` | Your original single-file version (use it to export old data) |
| `tests/` | Server tests (Sheets/Drive mocked) and a real-browser end-to-end test |
| `SETUP.md` | Deploy + migrate, step by step |
