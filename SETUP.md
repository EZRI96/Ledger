# Setup

## 1. Create the Apps Script project (≈10 min)

1. Sign in to the Google account that will **own** the data, open <https://script.google.com> → **New project**.
   Everything (the Sheet, the Drive folders, the deployment) ends up owned by whichever account is signed in
   here, so use that same account throughout this whole setup.
2. Rename it "Birr Ledger".
3. Project Settings (⚙) → tick **Show "appsscript.json" manifest file in editor**.
4. Replace the contents of the three files with the ones in `apps-script/`:
   - `Code.gs` → paste `apps-script/Code.gs`
   - `appsscript.json` → paste `apps-script/appsscript.json`
   - **+ → HTML**, name it exactly `Index` → paste `apps-script/Index.html`
   (Or use [clasp](https://github.com/google/clasp): `clasp create --type standalone`, copy the files in, `clasp push`.)

## 2. First run: create the Sheet, Drive folders and your admin login

1. In the editor choose the function **`setup`** and press **Run**. Approve the permission prompt
   (Google shows "unverified app" because it is your own script: *Advanced → Go to Birr Ledger*).
2. **View → Logs** (or *Execution log*). It prints your admin **username** (`admin`), a random
   **password**, and links to the data Sheet and the attachments folder. Save the password.
3. Optional but recommended: run **`installBackupTrigger`** once → nightly copy of the data Sheet
   into the "sheet backups" Drive folder (keeps 14).

> Lost the admin password? Run `resetAdminPassword` in the editor; it prints a new one.

## 3. Deploy

**Deploy → New deployment → ⚙ Web app**
- Execute as: **Me**
- Who has access: **Anyone**  ← this only means "no Google sign-in needed to open the page".
  Nobody can see data without an app username + password.

Copy the **Web app URL** — that is the link you give people.

Changing code later: **Deploy → Manage deployments → ✎ → Version: New version → Deploy**
(a brand-new deployment gets a new URL).

## 4. Add people

Open the URL, sign in as `admin`, press **Users** (bottom of the page) → enter name + username →
**Create user**. The generated password is shown **once**; send it privately. People can change it
under **Account**. **Reset password** and **Disable** are on the same screen (disabling keeps their data).

Each person has a **private, separate ledger**, identified by their own `userId` — no one but them can
load it through the app, and the server refuses it outright for anyone else (`FORBIDDEN`), admin included
by default. The admin account is also a normal ledger of its own.

**Admin oversight.** You, the admin, are the one exception: **Users → View ledger** opens any user's
ledger **read-only** — every add/edit/delete/settings/restore control is gone from that screen, and
the server has no "write as another user" call at all, so there is no path (bug or otherwise) for the
admin to alter someone else's entries this way. Every view is appended to **Users → audit log**
(who, whose ledger, when) — never editable, never deleted by the app — so access to a user's data is
visible, not silent. To change what the Sheet actually holds, use **Reset password** and sign in as them.

## 5. Move your existing data

Your current data lives in the browser that has been running the old HTML file.

1. In **that same browser**, open the old file `original/birr-ledger.html` (same way you always did).
2. Tap **Backup (JSON)** → **Save file** (or **Copy**, and paste it into a note).
3. Open the new web app URL, sign in, tap **Restore** → pick the file / paste → confirm.
   Old formats (v1–v5) are upgraded automatically and written to the Sheet.
4. Check totals match the old app *before* retiring it. Keep the JSON file as your archive.

Everyone else starts with an empty ledger and goes through the normal first-run setup screen.
You can also restore a JSON backup into another person's ledger by signing in as them.

## Attachments

On any entry form: **+ Add photo or PDF** (up to 5 per entry). Photos are shrunk to ≤1600 px JPEG in the
browser; PDFs are limited to 5 MB. Files are saved to
`<attachments folder>/<username (id)>/` in **your** Drive (they count against your Drive storage), are
never shared by link, and are only served back to the user who owns the entry. Deleting an entry, or
removing a file while editing, moves the file to your Drive trash.

## What is and is not tested

Tested here (`node tests/server.test.js`, `node tests/e2e.js`): the real `Code.gs` running against an
in-memory imitation of Sheets/Drive/Cache/Lock, driven by the real `Index.html` in Chromium — login,
lockout, per-user isolation, attachment upload/view/trash, >1000-row growth, chunked settings, old-backup
restore, two-device concurrent saves, admin user management, admin read-only "view as" (every mutating
control confirmed absent from the DOM, a non-admin's direct RPC attempt confirmed refused server-side,
the audit log entry confirmed written, and the viewed ledger confirmed unchanged afterwards).

**Not** testable outside Google, so verify on first deploy: (1) the Drive/Sheets permission prompt,
(2) opening the `/exec` URL in a private window, (3) uploading a photo from a phone, (4) the
**Backup → Save file** download inside Google's iframe. If a download is blocked there, the **Copy**
option on the same screen works as a fallback.

## Known limits and trade-offs

- **Access to the Sheet = access to everyone's data**, same as before: it's your Sheet and no one but you
  has it. Through the *app*, the only account with any reach beyond its own ledger is admin, and even that
  is read-only and logged — see "Admin oversight" above. Passwords are stored as salted HMACs keyed by a
  secret in Script Properties, but the Sheet still holds all ledgers in clear text, which is why the Sheet
  itself must stay unshared.
- **Lockout is per username**: 5 wrong passwords → locked 15 min. Someone who knows a username can keep
  locking that person out; the fix is simply waiting or resetting.
- Sessions last 30 days and are stored in the browser's localStorage; changing/resetting a password or disabling
  a user signs them out everywhere.
- Same-device conflicts: entries merge by id across devices. Settings/people edits are last-writer-wins, and a
  stale device is told to reload instead of overwriting.
- Free Google accounts have daily Apps Script quotas (~90 min runtime/day) — ample for 10 people logging a few
  entries a day; each save is one short call.
- Money stays in integer cents (÷100 for display), as in the original.
