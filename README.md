# Stockroom

Stockroom is a shared inventory and sales tracker backed by PostgreSQL. Password hashes, products, stock levels, sales, verified email addresses, and server-side login sessions are stored in the database; browser storage is not used as the application's data store.

## Requirements

- Node.js 20 or later and npm
- PostgreSQL 14 or later, reachable from the machine running Stockroom

## Create the database

Connect to PostgreSQL as a database administrator. On Windows, use the connection port configured for your PostgreSQL service (the standard port is `5432`):

```powershell
psql -h localhost -p 5432 -U postgres -d postgres
```

The PostgreSQL service detected on this workstation uses port `2510`; use that port in the `psql` command and `DATABASE_URL` if connecting to that installation.

Create a dedicated, non-superuser application login and database. Replace the example password with a unique password; do not commit it:

```sql
CREATE ROLE stockroom_app LOGIN PASSWORD 'choose-a-unique-database-password';
CREATE DATABASE stockroom OWNER stockroom_app;
```

The application creates its tables and indexes at startup using `db/001_initial.sql`. The app login owns only the Stockroom database, not the PostgreSQL server.

## Configure and run

From this directory:

```powershell
npm install
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Put the generated random value into `SESSION_SECRET` in `.env`. Change the database name, username, password, host, and port to match your PostgreSQL installation (URL-encode special characters in credentials). Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM` using credentials from your email provider. SMTP submission uses TLS; use your provider's app password when required. Set `APP_BASE_URL` to the public HTTPS origin users will open from their email (for example, `https://stockroom.example.com`); the default is only suitable for local development. `.env` is ignored by Git. Never use the placeholders from `.env.example` as credentials.

At startup Stockroom loads `.env` from the project root, validates `DATABASE_URL` and `SESSION_SECRET`, opens a real PostgreSQL connection, then applies the idempotent schema. Startup errors distinguish malformed configuration, refused/unreachable servers, rejected credentials, and missing databases without printing the connection URL or password.

Then start the server:

```powershell
npm start
```

While Stockroom is running, it creates a PostgreSQL custom-format backup at startup and repeats it every 24 hours by default. On Windows, backups are stored outside the project in `%LOCALAPPDATA%\Stockroom\backups`; the newest 14 are kept. PostgreSQL command-line tools (`pg_dump`) must be installed. Set `PG_DUMP_PATH` if `pg_dump.exe` is not on `PATH`, `BACKUP_DIR` to choose another local folder, `BACKUP_INTERVAL_HOURS` to change the schedule, and `BACKUP_RETENTION_COUNT` to change how many backups are kept. A backup can also be created immediately with `npm run backup`. Backup failures are reported in the server console without stopping the app. Keep the backup folder accessible only to trusted users, and copy backups to a separate drive or secure off-site location for protection against device failure.

Open <http://localhost:8000>. The first visitor sees the one-time setup form to create the first administrator. Stockroom emails a single-use verification link that expires after 24 hours; the administrator must open it before signing in. Team accounts also receive verification links, and unverified users can request a replacement link from the sign-in screen. Setup and team invitations require working SMTP settings. To share the workspace across devices, run the server on a machine reachable by those devices and put it behind HTTPS; set `NODE_ENV=production` so session cookies are marked secure. Set `APP_BASE_URL` to the same public HTTPS origin so verification links work on those devices. If TLS terminates at a trusted reverse proxy, also set `TRUST_PROXY=1`. Keep PostgreSQL private to the application network.

On an existing Stockroom browser, first-admin setup offers an explicit opt-in to import the old browser-only catalog and sales history. Imported records are committed with administrator creation in one transaction, and current stock is preserved as-is (it is not decremented a second time). Declining the import leaves the old browser data untouched, but Stockroom will not read or write it after setup.

## Roles

| Role | Permissions |
|---|---|
| Admin | Manage inventory, suppliers and purchase orders, view sales and reports, create/manage team accounts, reset passwords, and change roles |
| Manager | Manage inventory, suppliers and purchase orders, record and view sales, view reports |
| Cashier | View products, record sales, view their own sale history |

Every protected operation is authorized by the server. Hiding a button in the interface is not the access-control boundary. Cashiers do not receive product cost data.

## Stock history

Admins and managers can open **Stock history** to review stock additions, removals, and sales, including who recorded each change and the resulting balance. Use **Adjust stock** in Inventory for restocks, customer returns, corrections, or damaged/lost units; direct stock edits are disabled when editing product details so every adjustment has a reason. New products with opening stock are recorded automatically. On startup, existing products with stock are recorded once as opening balances, and the history page can load older entries in batches.

## Suppliers and purchase orders

Admins and managers can open **Purchasing** to save supplier contact details and place purchase orders for products already in inventory. Reorder suggestions appear when stock is below a product's reorder level; the suggested amount fills the gap to that level and can be edited before ordering. Each order stores the product name, SKU, ordered quantity, and unit-cost snapshot, so later catalog edits do not rewrite its original details. Orders can be received in multiple deliveries: record the quantity delivered for each line, and Stockroom updates inventory, the received balance, and stock history together. A delivery cannot exceed the outstanding quantity; orders with no deliveries can be cancelled. Every receipt is kept as a separate record and linked to its purchase-order number in stock history.

## CSV exports

Admins and managers can open **Reports** and download complete CSV exports for products, sales, stock history, and purchase-order lines. Exports include headers, use UTF-8 encoding, and escape spreadsheet formula prefixes in text fields.

## Checks

```powershell
npm test
npm run check
```

Tests cover first-admin setup, email verification, login/logout and session cookies, CSRF rejection, role enforcement, validation, browser-data import, stock updates, partial purchase-order receipts, CSV export access and escaping, and backup scheduling configuration, retention, and failure handling. They use a database test double; running the app requires a real PostgreSQL database configured with `DATABASE_URL`.
