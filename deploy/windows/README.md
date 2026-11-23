# PB Portal on a Windows server

How to run the site on a Windows Server of your own instead of Render. Written for whoever looks after the server.

**Not yet proven on Windows.** The site has been run and tested on Linux only. The code has been reviewed for Windows
and nothing in it should stop it, but the first install is the real test: do it on a spare or staging server first,
and work through "Check it works" below before anyone relies on it.

## What you end up with

```
D:\PBPortal\
  site\          the code (a git checkout)
  data\          the encrypted database, uploaded photos and documents, nightly backups
  logs\          the site's log
  portal.env     the settings, including the database key
```

- One Windows service, **PB Portal**, running Node.js and listening only on `127.0.0.1:3000`.
- A web server in front of it (Caddy or IIS) that takes HTTPS on port 443 and passes requests to the service.
- A scheduled task that copies the nightly backups to another machine.

## What the server needs

| | |
| --- | --- |
| Windows | Windows Server 2019 or 2022, 64-bit |
| Size | 2 cores, 4 GB memory, 50 GB disk is enough for every office |
| Node.js | Version 22 LTS (the 64-bit installer from nodejs.org) |
| Git | Git for Windows, to fetch the code and updates |
| NSSM | The Non-Sucking Service Manager, to run the site as a service |
| A web server | Caddy (simplest) or IIS with URL Rewrite and Application Request Routing |
| A name | A DNS name for the site, for example `portal.pyebarker.com`, and a certificate for it |
| Optional | Poppler for Windows on the PATH (`pdftoppm.exe`). Without it newsletters still upload but have no page pictures. |

No compiler is needed: the encrypted database library comes with a ready-made Windows build.

## HTTPS is required

The site must be reached over HTTPS at one fixed name. Without it nobody can sign in (the sign-in cookie is only sent
over HTTPS), and phone notifications, Face ID and "add to home screen" do not work.

Decide first who should reach it:

- **From anywhere** (as on Render today): open ports 80 and 443 to the server. Technicians use it from their phones in
  the field. Caddy can then get and renew a free certificate by itself.
- **Inside the company network only**: technicians need the VPN on their phones. Use a certificate from the company's
  own authority, or a public one issued another way.

## Install

Run these in an elevated PowerShell.

1. **Folders and code**

   ```powershell
   New-Item -ItemType Directory -Force D:\PBPortal\data, D:\PBPortal\logs
   git clone https://github.com/uriahredos/pblancasterwebsite.git D:\PBPortal\site
   cd D:\PBPortal\site
   npm ci --omit=dev
   ```

2. **Settings**

   ```powershell
   Copy-Item deploy\windows\portal.env.example D:\PBPortal\portal.env
   notepad D:\PBPortal\portal.env
   ```

   Fill in `BASE_URL`, `SESSION_SECRET` and `DB_KEY` (see "Moving the data from Render" before choosing a key).
   Then lock the file down, because it holds the database key:

   ```powershell
   icacls D:\PBPortal\portal.env /inheritance:r /grant "Administrators:F" "SYSTEM:F"
   ```

3. **The service**

   ```powershell
   .\deploy\windows\install-service.ps1
   ```

   It should end by printing `ok`.

4. **The web server in front** (one of these)

   - **Caddy:** copy `deploy\windows\Caddyfile`, put the site's real name in it, and run Caddy as a service with it.
   - **IIS:** make a site bound to the name on 443 with the certificate, and put `deploy\windows\web.config` in its
     folder. The notes at the top of that file list the two IIS modules and the one setting it needs.

5. **Firewall:** allow inbound 443 (and 80 if Caddy is getting the certificate). Port 3000 stays closed; the site only
   listens on the server itself.

6. **Keep the data folder out of antivirus real-time scanning** (`D:\PBPortal\data`). A scanner holding the database
   file open can make the site's own backups and restores fail.

7. **Backups off the server.** In Task Scheduler, run this daily at 3 am as an account that can write to the share:

   ```powershell
   powershell -File D:\PBPortal\site\deploy\windows\copy-backups.ps1 -To \\fileserver\backups\pbportal
   ```

## Moving the data from Render

1. In the live site, open **Corporate > Backups** and press **Back up now**, then download that backup and
   **Download all photos**.
2. On the Windows server, with the service stopped, put the backup at `D:\PBPortal\data\portal.db` and unpack the
   photos so they sit in `D:\PBPortal\data\uploads`.
3. Set `DB_KEY` in `portal.env` to **exactly the key Render has**. The database and the photos are encrypted with it;
   any other key cannot open them.
4. Start the service and sign in. Everyone will have to sign in again, because backups leave out sign-in sessions.
5. People who turned on phone notifications or Face ID will need to turn them on again if the site's address changed.

Keep Render running until the Windows server has been checked, then switch the DNS name over.

## Updating

```powershell
D:\PBPortal\site\deploy\windows\update.ps1
```

It fetches the newest code, installs what it needs, restarts the service and prints the health check. The site is
down for under a minute. The first start of a new version keeps a checked copy of the database from before the
update (Corporate > Backups marks it "Made before an update"). The script prints the command to go back.

Updates are not automatic here, unlike on Render: someone runs this after each release.

## Check it works

- `https://<the name>/healthz` shows `ok`.
- Sign in, then open **Corporate > Security check**: it should say the database is encrypted, the newest backup opens,
  and there is room on the disk.
- Upload a photo to Social and open it again.
- **Corporate > Backups > Back up now** makes a backup, and **Download all photos** downloads an archive.
- Restart the server: the site comes back by itself.
- On a phone: sign in, turn on alerts under Notification settings, and send a test (assign yourself a task).

## Known differences from Render

- **Updates** are run by hand (above).
- **Certificates, Windows patches and uptime** are the server owner's job.
- **Download all photos** uses the `tar.exe` that comes with Windows Server 2019 and later.
- **Newsletter page pictures** need Poppler installed (optional, above).
- **The service stops cleanly** on a normal stop or restart. If Windows has to end it by force (after 20 seconds) the
  database is still safe: it keeps a journal and recovers on the next start.

## If something goes wrong

- **The service will not start:** read `D:\PBPortal\logs\portal.log`. The usual causes are a missing `SESSION_SECRET`,
  a `DB_KEY` that does not match the database, or a `DATA_DIR` the service account cannot write to.
- **Nobody can sign in, the page just comes back:** the site is not being told the request came over HTTPS. With IIS,
  check the `HTTP_X_FORWARDED_PROTO` setting described in `web.config`. `BASE_URL` must be the `https://` address.
- **Backups fail:** check free disk space and the antivirus exclusion on the data folder.
