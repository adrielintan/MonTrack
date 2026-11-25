# MonTrack

MonTrack is an invitation-only, self-hosted money tracker with an installable local-first PWA. Each user has a private workspace. Entries are stored in the browser first and synchronize with the Docker-hosted SQLite server when online.

## Run with Docker

1. Copy `.env.example` to `.env` and set a unique administrator email and strong password.
2. Run `docker compose up --build` from this folder.
3. Open `http://localhost:3001` and sign in with the bootstrap administrator credentials.
4. Create invitations in **Settings**. Invitees set their own name and password using the generated link.

The named `montrack-data` volume contains the SQLite database and receipt photos. Back it up regularly. To install the PWA on phones or access it over a network, serve it through an HTTPS reverse proxy; browsers only allow service workers on HTTPS (localhost is the development exception).

## Development

Requires Node.js 22 or newer and npm.

```powershell
cd montrack-app
npm install
$env:BOOTSTRAP_ADMIN_EMAIL = "admin@example.com"
$env:BOOTSTRAP_ADMIN_PASSWORD = "use-a-unique-long-password"
npm run dev
```

The Vite UI runs at `http://localhost:5173` and proxies `/api` requests to the API on port `3001`. The development database and receipt uploads are written to `montrack-app/data` unless `DATA_DIR` is set.

## Included in this first version

- Multiple invited users with isolated server records and per-user browser databases.
- Offline transaction entry and browsing, an idempotent push/pull sync queue, tombstones, and explicit prompts for conflicting edits or deletes.
- Custom accounts, dated opening adjustments, expenses, income, transfers, cross-currency transfer amounts, manual or current exchange rates, and transfer fees. New transactions snapshot the reporting-currency rate available when entered; later quote updates do not revalue completed transactions. Combined account balances are current valuations and use the latest available rate.
- Custom expense/income categories, one project per transaction, multiple tags, receipt photo capture, CSV transaction export, and a basic debt/loan ledger with manually recorded principal and interest portions.
- PWA install metadata and precached application shell.

Current limitations: conflict prompts choose the complete local or server version rather than merging individual fields; exchange-rate quotes come from Frankfurter when online; older transactions without a saved reporting-rate snapshot remain grouped in their original currency; the debt ledger has no automatic schedules or interest calculations; attachments are limited to image files up to 8 MB. Browser storage is not a substitute for server backups.