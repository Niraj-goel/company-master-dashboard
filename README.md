# Company Master Dashboard

A web page plus a small Node.js server. The server reads the **Company Master Data** Google Sheet and the **ROC** folder in Google Drive with a service account, and the page shows the result. The service-account key stays on the server, in `.env`, and is never sent to the browser.

## Run it

Double-click `start.bat`, or run `node server.js`. It opens http://localhost:3000. Needs Node.js 18 or later; there is nothing to install.

- **Refresh data** re-reads Google straight away. Otherwise the server reuses a read for 2 minutes.
- To change the data, edit the Google Sheet or add files to the ROC folder, then refresh the page.

## Sign-in, roles and the access matrix

Everyone signs in on the dashboard's own sign-in page with a personal user name and password.

- **Owner**: the `DASHBOARD_USER` / `DASHBOARD_PASSWORD` account from `.env`. Always an admin, and can't be deleted from the page, so you can't lock yourself out.
- **Admin**: sees everything, plus the **Access** tab. There it adds users, sets their role, resets passwords, switches people off, and edits the access matrix.
- **General**: the standard staff view. By default it gets Entity register, Director register, Capital, Observations, document downloads and CSV export. It does not get Group financials, Inter-group loans, Cross holding, Refresh, the sheet and Drive links, or the local-file tools. Change any of this in the matrix.
- **More roles** (for example Accounts) can be added from the Access tab, each with its own column in the matrix.

The server applies the matrix before it sends anything. Sheet tabs, ROC workbooks and document links that a role can't see are left out of the data, so they can't be read from the browser's developer tools either. A switched-off user is signed out on their next click. Changing a password ends that user's other sessions. Five wrong passwords lock that user name for 15 minutes.

Users and the matrix are saved in `access.json` (passwords only as scrypt hashes). The file is in `.gitignore`; never commit it. On a host that wipes its disk on restart, set `ACCESS_FILE` to a path on a persistent disk.

## Document downloads

In the entity register, a CIN, PAN or GSTIN with a ↓ next to it downloads that entity's document from Drive:

| Click | Downloads | Looked for in |
|---|---|---|
| CIN / LLPIN | ROC record (a PDF if there is one, otherwise the MCA workbook) | `ROC` |
| PAN | PAN card | `Statutory/PAN` |
| GSTIN | GST certificate | `Statutory/GST` and its subfolders |

A file is matched when its name contains the entity's CIN, PAN or GSTIN, or names the company (spelling differences of a letter or two are allowed). To add a document, put it in the right folder named after the company, for example `Mekhala Builders Pvt Ltd.pdf`, and press **Refresh data**. The server downloads only files matched this way, so no other file in Drive can be fetched through it.

## One-time Google setup

1. In the Google Cloud project that owns the key, enable the **Google Sheets API** and the **Google Drive API**.
2. Share the Drive folder (it contains the sheet) with the service account as **Viewer**:
   `company-master-dashboard@company-master-dashboard.iam.gserviceaccount.com`

## Settings: `.env`

All settings, including the key, are in `.env` in this folder. `.env.example` shows the same settings without the key; copy it to `.env` on a new machine and fill in the blanks.

| Setting | Use |
|---|---|
| `PORT` | Port to listen on (default 3000) |
| `DASHBOARD_USER`, `DASHBOARD_PASSWORD` | Owner (admin) account. Without a password the dashboard opens only on localhost |
| `ACCESS_FILE` | Where users, roles and the access matrix are saved (default `access.json`) |
| `SESSION_HOURS`, `SESSION_SECRET` | How long a sign-in lasts (default 12 h); optional fixed cookie-signing secret |
| `SHEET_ID`, `ROC_FOLDER_ID` | The Google Sheet and the ROC folder the dashboard reads |
| `PAN_FOLDER_ID`, `GST_FOLDER_ID` | Folders searched for PAN cards and GST certificates (GST includes its subfolders) |
| `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_PRIVATE_KEY_ID`, `GOOGLE_PROJECT_ID`, `GOOGLE_TOKEN_URI` | The service-account key. Keep `GOOGLE_PRIVATE_KEY` in double quotes, with `\n` for line breaks |

Values set in the real environment override `.env`, so on a hosting service you can enter the same names in its settings screen instead of uploading the file.

## Files

| File | What it is |
|---|---|
| `server.js` | Web server: sign-in, `/` serves the page, `/api/data` returns what the user's role may see |
| `access.js` | Users, roles, access matrix and sign-in sessions |
| `public/login.html` | Sign-in page |
| `google.js` | Google sign-in with the service account, plus Sheets and Drive calls |
| `docs.js` | Matches PAN cards, GST certificates and ROC files to entities |
| `env.js` | Reads `.env` |
| `public/index.html` | The dashboard page |
| `.env` | Settings and the key. Never email it, commit it or put it in the page |
| `Company_Master_Dashboard.html` | The original offline dashboard, unchanged |

## Hosting it for the team

Any Node host works: an office PC or server on the network, Google Cloud Run, Render or Railway. Set `DASHBOARD_PASSWORD` (and `ACCESS_FILE` on a persistent disk), enter the `.env` values in the host's environment settings, and use the host's HTTPS address.
