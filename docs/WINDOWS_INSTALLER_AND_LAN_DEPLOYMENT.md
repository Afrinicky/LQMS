# SECH_LIMS by Nickland — Windows installer and LAN deployment guide

Practical guide for an administrator deploying the desktop host on a Windows machine and (later) preparing other desktops on the same LAN to connect.

This document covers the offline-first foundation only. Cloud sync, internet-database sync, live LHIMS/Lightwave integration, live SMS/email/calendar delivery, and the mobile app are not yet built.

---

## 1. What you are installing

- The **host desktop** runs both the local API and the Electron user interface on the same machine.
- The SQLite database, uploaded files, evidence files, configuration, and backup ZIPs live in the per-user app data folder — **not** in the installation folder. Reinstalling or updating the app does not touch your data.
- Other desktops on the same LAN will (in a future phase) be approved as paired clients of the host and reach the host API over the LAN. The desktop pairing workflow is currently a foundation only.

---

## 2. Install Node.js and dependencies (developer/builder machine)

This is only needed on the machine that **builds** the installer.

1. Install Node.js 20 LTS or newer from <https://nodejs.org>.
2. Install Git for Windows from <https://git-scm.com>.
3. Open a Command Prompt in the project folder and run:

```
npm install
```

If `better-sqlite3` requires a native rebuild on Windows you may need the "Desktop development with C++" workload from the Visual Studio Build Tools. Re-run `npm install` after installing.

---

## 3. Run in development

To launch the local API, the Vite UI, and the Electron shell together:

```
npm run dev
```

To run only the host API for LAN preparation:

```
npm run api
```

The API listens on `http://0.0.0.0:4317/api`. The Electron window connects to `http://127.0.0.1:5173` in dev mode and to the bundled `dist/` HTML in production.

---

## 4. Build the production assets

```
npm run typecheck
npm run build
```

This produces:

- `dist/` — the Vite client bundle.
- `dist-electron/` — compiled Electron main + preload + apiServer.
- A clean type check first to prevent shipping broken types.

You can sanity-check the project structure with:

```
npm run smoke
```

The smoke check is read-only — it never touches the database.

---

## 5. Create the Windows installer

```
npm run dist:win
```

This calls `electron-builder` with the configuration in `package.json`:

- **appId**: `com.nickland.sechlims`
- **product name**: `SECH_LIMS by Nickland`
- **output folder**: `release/`
- **Windows target**: NSIS x64 installer named `SECH_LIMS-by-Nickland-<version>-Setup.exe`
- **asarUnpack**: `node_modules/better-sqlite3/**/*` so the native module is loadable from inside the asar
- **install type**: per-user (not per-machine), user can change the install directory, with desktop + start-menu shortcuts

If `electron-builder` complains about code signing on Windows, sign later or run unsigned for internal use. Do not publish an unsigned installer publicly.

To do a quick directory-only test build without producing the installer:

```
npm run pack
```

The packaged folder appears under `release/`.

> The smoke check verifies the package.json configuration but does not run electron-builder. The installer must be built on a Windows host (or on Linux with Wine + the Windows toolchain). On CI/non-Windows environments without these prerequisites, `npm run dist:win` will exit with a packaging-toolchain error; this is expected.

---

## 6. Where the data lives on Windows

The Electron main process sets `SECH_LIMS_DATA_DIR` to `app.getPath('userData')/local-data` at startup. On Windows this resolves to:

```
%APPDATA%\SECH_LIMS by Nickland\local-data\
```

Inside that folder you will find:

| Sub-folder | Contents |
| --- | --- |
| `sech_lims.sqlite` | The SQLite database. |
| `uploads/` | Files uploaded to the file register. |
| `evidence/` | Evidence files linked to records. |
| `backups/` | ZIP backup packages produced by the in-app backup feature. |
| `config/` | Configuration files. |

> The database is **never** stored inside the installed application folder. Removing the program will not remove your data.

You can override the location by setting the environment variable `SECH_LIMS_DATA_DIR` before launching the app. Useful for putting data on a separate drive.

---

## 7. Backing up data

1. In the app, go to **Settings → Backup & Restore**.
2. Click **Create backup**. The app produces a ZIP under `backups/` containing the database, uploads, evidence, config, and a `backup-manifest.json`.
3. Copy the ZIP off the machine. Recommended: a secured network share, an external drive that is rotated, or another physically separate location.
4. Record the backup check in **Records, Reports & Evidence → Backup/Restore Checks**.

Restore is currently a guarded placeholder. For now, restoration is a manual process: stop the application, replace the contents of the `local-data/` folder with the unzipped backup, and start the application again. Verify the audit trail and a small QMS record after restore.

---

## 8. Running the host desktop

1. Run the installer on the host laptop and launch **SECH_LIMS by Nickland** from the Start menu.
2. The first time you launch, the setup wizard creates the system administrator user, default positions, default modules, and default permissions.
3. The host API binds to `0.0.0.0:4317` so future LAN client desktops can reach it.

---

## 9. Preparing other desktops on the same LAN

Full LAN client desktops are foundation-only at this phase. Plan the LAN steps now so the deployment is ready when the client UI is finalised in a later phase:

1. On the host laptop, allow inbound TCP `4317` through Windows Defender Firewall on the private network profile only.
2. Note the host's static LAN IP (or DHCP reservation). Other desktops will be configured to reach `http://<host-lan-ip>:4317/api`.
3. Use **Settings → Device Access / Pairing** on the host to create a pending device entry with a pairing code for each future client desktop.
4. Until the client desktop UI is shipped, additional desktops should **not** reach the host API. Keep the firewall closed to public networks.

---

## 10. Updating the app safely

When a new SECH_LIMS installer is released:

1. **Back up first.** Create a backup ZIP via Settings → Backup & Restore and copy it off the machine.
2. Close the running app.
3. Run the new installer. It will install over the previous version. Because the SQLite database lives in `%APPDATA%\SECH_LIMS by Nickland\local-data\` and not in the install folder, the upgrade does not touch it.
4. Launch the app and verify:
   - The login still works.
   - The Audit Trail still shows historical events.
   - A small read on each major module returns the expected counts.
   - The Main Dashboard System Health card looks healthy.

If a release ships database migrations, the migrations run on first start. Take the backup **before** launching the new version so a roll-back is possible.

---

## 11. Things this guide deliberately does not cover

- Mobile application — not yet built.
- Cloud sync — not yet built.
- Internet database sync — not yet built.
- Live LHIMS/Lightwave integration — not yet built.
- Live POCT device or result interfacing — not yet built.
- Live Google Forms / Sheets / Gmail integration — not yet built.
- Live SMS / email / calendar invite delivery — not yet built.
- Advanced AI SOP conversion — not yet built.
- Advanced visual report designer — not yet built.

Each of these will be addressed in a dedicated phase. Until then, SECH_LIMS does not replace LHIMS/Lightwave for patient registration, test requests, clinical result entry, verification, dispatch, or reporting.
