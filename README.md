# Pye-Barker Lancaster Branch Portal

A small website for the Pye-Barker Lancaster Branch: parts sign-out (take / return / request), training requests, and anonymous complaints. Everyone signs in with a username and password that an admin creates.

## Links to share

| Link | What it is |
|---|---|
| `/parts` | Parts form. `/parts?action=take`, `?action=return` or `?action=request` opens it with that choice made. |
| `/training` | Training request form |
| `/complaint` | Anonymous complaint form |
| `/complaint/status` | Check a complaint with its tracking code |
| `/my` | A person's own parts and training submissions, with status |
| `/admin/parts`, `/admin/training`, `/admin/users`, `/admin/profiles` | Depends on the person's profile |
| `/admin/parts/audit` | Parts audit for a date range (needs the audit permission) |
| `/admin/parts/summary` | Parts usage totals (needs the parts log permission) |
| `/admin/catalog` | Parts catalog (needs the catalog permission) |
| `/admin/backups` | Backups (profiles with the backups permission) |
| `/admin/complaints` | Profiles with the complaints permission |

Someone who opens a link while signed out is sent to the sign-in page and then straight back to that form.

## Run it on your own computer

Needs Node.js 22 or newer.

```bash
npm install
```

```bash
npm run create-admin -- yourusername "Your Name"
```

```bash
npm start
```

Open http://localhost:3000 and sign in with the temporary password that `create-admin` printed. Data is kept in the `data/` folder.

Run the automated tests with:

```bash
npm test
```

## Put it online (Render)

The app needs a disk that survives restarts (for the database and photos), so it needs Render's paid "Starter" web service plus a 1 GB disk. Free plans wipe the disk and would lose your data.

1. Put this folder in a GitHub repository.
2. In Render: **New > Blueprint**, pick the repository. `render.yaml` sets up the service and disk.
3. When asked for values, fill in:
   - `BASE_URL`: the address Render gives you, for example `https://branch-portal.onrender.com`
   - `BOOTSTRAP_ADMIN_USERNAME` and `BOOTSTRAP_ADMIN_PASSWORD`: your first sign-in. You are made to change the password immediately.
   - Email settings (optional, see below). Leave blank to skip.
4. After your first sign-in, delete `BOOTSTRAP_ADMIN_PASSWORD` from the Render environment settings.

The same `Dockerfile` works on Railway, Fly.io or any server with Docker. Mount a volume at `/data` and set the variables listed in `.env.example`.

All the data is `/data/portal.db` and `/data/uploads`. See Backups below.

## Put it on a phone's home screen

The site can be installed like an app, with its own icon.

- **iPhone (Safari):** open the site, tap the Share button, then **Add to Home Screen**.
- **Android (Chrome):** open the site, tap the three-dot menu, then **Add to Home screen** or **Install app**.

What it does with no signal:

- The parts and training forms save what is typed on the phone as it is typed. If the page is closed or the signal drops, it is put back the next time the form is opened, and it is cleared once the form is sent. Photos are not saved.
- Pressing Submit with no signal shows "not sent" instead of losing the form. Nothing is sent later automatically; the person presses Submit again when they have signal.
- Complaint text is never saved on the phone.

## Parts catalog (`/admin/catalog`)

A list of part numbers and descriptions. When someone types on the parts form, matching catalog parts are suggested; they can still type a part that is not listed. Parts that are not in the catalog but have been typed before are suggested too.

- **Import**: upload a CSV file. It needs a part number column (for example "Part Code", "Part Number" or "Item"); "Description", "Category" and "Manufacturer" are used if present. **Prices, costs and every other column are ignored and not stored.** There is no price field in the database.
- From Excel: File > Save As > CSV, then upload that.
- Importing again adds new parts and updates descriptions. It never removes parts.
- **Hide** stops a part being suggested without deleting it.

## Parts usage summary (`/admin/parts/summary`)

Reached from the **Usage summary** button on the parts log. For a date range (and optionally one person or a search), it shows totals by part (taken, returned, net used, requested), by person and by job, with a CSV download. Part names are matched ignoring upper/lower case and stray spaces. Cancelled entries are not counted.

## Parts audit (`/admin/parts/audit`)

**Audit** in the admin menu. Choose a date range (or a quick range such as This month or Last month) and it lists every part taken, returned and requested in those dates, in three sections, with unit totals for each. Catalog descriptions are filled in where the part number matches.

- **Checked box:** tick an entry once you have checked it against the shelf or paperwork. It records who ticked it and when. Click again to undo. **Mark all as checked** ticks everything still unticked in that section and date range.
- **Show: Not checked yet** hides entries already ticked.
- Cancelled entries are listed struck through and are not counted in the totals.
- If an entry is edited after it was checked, the tick is removed so it gets checked again.
- **Print** gives a clean printout without menus; **Download CSV** gives one row per part.

## Look and feel

The banner uses the Pye-Barker logo (`public/logo.png`) and the colors are taken from it; they are set at the top of `public/styles.css`. The button at the top right switches between light and dark. The choice is remembered on that device; until someone uses the button, the site follows the device's own light/dark setting.

## Editing and cancelling

- A person can edit or cancel their own parts entry or training request from **My submissions** for 24 hours (`EDIT_WINDOW_HOURS`), as long as nobody has acted on it (a request that is no longer "New" is locked).
- People whose profile allows managing parts or training can edit or cancel any entry they can see, at any time, from its detail page.
- Take / Return / Request cannot be switched by an edit; cancel and send a new one.
- Nothing is deleted. A cancelled entry stays in the log marked "Cancelled", and every edit records who made it, when, and what the entry said before. This shows on the entry's detail page and in the CSV export.

## Backups (`/admin/backups`)

- A copy of the database is made every night (after `BACKUP_HOUR`, default 2 am) and the newest 14 are kept in `/data/backups`.
- **These copies are on the same disk as the site.** They protect against mistakes, not against losing the disk. To get copies off the server, either set `BACKUP_EMAIL_TO` (needs the email settings below) so each night's copy is emailed, or download one from the Backups page now and then.
- The Backups page also has **Back up now** and **Download all photos**.
- A backup contains everything, including anonymous complaints, so it has its own permission, and `BACKUP_EMAIL_TO` should only name someone trusted with that.
- To restore: stop the site, replace `/data/portal.db` with the backup file, start the site.

## Email notifications

Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM` to an account the site may send from, then:

- `NOTIFY_TO`: who is emailed about each new **parts request** and **training request**. Take and return entries do not send email. A training request marked private sends only "a private request was submitted", without the text or the name.
- `COMPLAINT_NOTIFY_TO`: who gets the complaint notice. This is sent **once a day** (at `COMPLAINT_DIGEST_HOUR`, default 5 pm) and says only how many new complaints there are. It is not sent the moment a complaint arrives, because the arrival time could point to who wrote it.

With no SMTP settings the site works normally and skips email.

## People, profiles and permissions

### Profiles (`/admin/profiles`)

A profile is a set of permissions. Each person has exactly one profile, and what they can see and do comes from it.

- The site starts with **Technician**, **Warehouse**, **Manager** and **Admin**. They are ordinary profiles: open one to rename it or change its tick-boxes.
- **Add a profile** at the bottom of the Profiles page, then tick what it should allow.
- Each profile also has **"Whose submissions can this profile see?"**: *Everyone*, or *Only the people assigned to them* (a manager).
- Saving a profile changes it for everyone on that profile immediately.
- A profile can only be deleted when nobody is using it.

| Starts with | Technician | Warehouse | Manager | Admin |
|---|---|---|---|---|
| Send parts, training and complaint forms | Yes | Yes | Yes | Yes |
| Parts log, summary, exports | | Yes | Own people | Yes |
| Update requests, edit/cancel others' entries | | Yes | Own people | Yes |
| Parts audit | | Yes | Own people | Yes |
| Parts catalog | | Yes | | Yes |
| Training log and updates | | | Own people | Yes |
| Manage people | | | | Yes |
| Manage profiles | | | | Yes |
| Read complaints, download backups | | | | Yes |

### People (`/admin/users`)

- **Add a person**: username, name and a profile. The site generates a temporary password and shows it once; the person chooses their own at first sign-in.
- **Edit**: name, username, email and profile.
- **Managers**: when a person's profile is a "sees only their own people" profile, their Edit page lists everyone with tick-boxes. Tick the people they manage. The Users list shows who manages whom.
- **Reset password**: a new temporary password, shown once. There is no "forgot password" email.
- **Disable**: signed out at once and cannot sign in; their past submissions stay.

### The master account

One account is the master. It always has every permission whatever the profiles say, and nobody else can edit it, reset its password, disable it or change what it can do. It is the first admin account ever created. If the Master badge is on the wrong person, set `MASTER_USERNAME` in the host's environment settings and restart.

### Limits that stop access creeping upward

- Nobody can give out more than they have: you can only assign profiles, and tick boxes, that are within your own permissions. Boxes you do not hold are shown locked.
- You cannot edit, reset or disable someone whose profile allows more than yours.
- You cannot change your own profile or disable yourself.
- A manager given the "manage people" box can edit, reset and disable their own people only; they cannot add accounts or change anyone's profile.

## How anonymous the complaints are

What the site does:

- The complaint is stored with a category, the text, an optional "when/where", and the **date**. It is not stored with a user, an IP address, a device or a time of day. The table has no column for any of those.
- Complaint ids are random and the table is not kept in arrival order, so a complaint cannot be lined up against the parts log or sign-in times.
- Complaint pages are left out of the server's request log.
- The tracking code is shown once and only a scrambled (hashed) copy is kept. Nobody, including an admin with the database file, can look up a code. A lost code cannot be recovered.
- Checking a code does not record who checked.
- A cap of 5 complaints per account per day stops flooding. The count is held in memory only and is never saved.

What it cannot do:

- In a small branch, the **content** of a complaint can give the writer away. The form tells people this.
- A reviewer who watches the complaints list all day could notice roughly when a new one appears.
- Your hosting company's own network logs are outside this app's control. They record which addresses visited the site, though not what was typed.

## Status values

- Parts **requests**: New, Ordered, Fulfilled, Declined. Take and return entries are a log and have no status.
- Training requests: New, Reviewed, Scheduled, Completed, Declined.
- Complaints: New, Under review, Resolved, Closed.

A reply typed with a status change is shown to the submitter (under My submissions, or via the tracking code for complaints).

## Where things are

```
app/server.js        starts the site
app/app.js           security headers, sessions, routes
app/db.js            database tables
app/routes/          one file per area: auth, home, parts, training, complaints, admin, catalog, backups
app/permissions.js   profiles, permission list, manager scoping, master account
app/backup.js        nightly backups
app/changes.js       edit/cancel rules and history
app/views/           the pages
public/              stylesheet, scripts, and the home-screen app files (manifest, sw.js, icons)
scripts/create-admin.js
test/portal.test.js  automated tests
```

Not in this prototype: Microsoft/Outlook sign-in, stock counts, importing the old Microsoft Forms history.
