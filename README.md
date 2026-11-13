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

## Stock (`/admin/stock`)

Tracks how many of a part are on the shelf. A part is tracked once you give it a count.

- **On hand** = the last count, plus deliveries and returns, minus parts taken since that count. Requests do not move stock. Cancelling an entry puts its parts back.
- **Start tracking**: enter a part number, how many are on the shelf now, and optionally a minimum. Or **upload a count**: a CSV with Part Number, On hand and optionally Minimum.
- Open a part to record a **delivery or correction** (20 for a delivery, -2 for damaged), do a **recount**, or change the **minimum**.
- A part at or below its minimum shows **Low**; at zero it shows **Out**. "Low stock only" filters to those.
- When taking parts pushes one to or below its minimum, an email goes to `NOTIFY_TO` once (needs email set up).
- Entries are matched to stock by part number, ignoring upper/lower case. A part typed differently from its catalog number is not counted, which is one reason the form suggests catalog numbers.
- Viewing needs the parts log permission; changing counts needs **Manage stock**.

## Parts requests queue (`/admin/requests`)

Open requests (New or Ordered), soonest needed-by first, with overdue ones marked. **Ordered**, **Fulfilled** and **Decline** buttons change the status in one tap; use "Open / add a reply" to write a note. The menu shows how many are open. Managers see only their own people's requests.

When someone else changes the status or reply on a person's request (parts or training), that person sees an **Updated** marker and a number beside "My submissions" until they look, and is emailed if they have an email address and email is set up.

## Trucks, usual parts and barcode scanning

- **Truck**: an optional field on the parts form. It is remembered for that person, and shown in the parts log, audit, exports and a "By truck" table in the usage summary. Admins can set someone's usual truck on their Edit page.
- **Usual parts**: the form shows the person's most-used parts as buttons; tapping one adds it.
- **Scan barcode**: opens the phone camera and puts the scanned code into the next part row. The barcode must contain the part number as it appears in the catalog. It needs camera permission and a secure (https) address.

## Training topics, sessions and attendance

- **Topics** (`/training/topics`): everyone who can send training requests sees the open, non-private requests and can tap **I want this too**. The most wanted rise to the top, and the admin training log shows the count.
- **Sessions** (`/admin/training/sessions`, from the Training log): schedule a session with a date, time and place. Scheduling one from a training request lists the requester and everyone who added their name, and sets the request to Scheduled.
- On the day, tick who came and press **Mark as held**; the linked request becomes Completed.
- Each person sees **Training attended** under My submissions. The sessions page can filter by person and export attendance as CSV.
- Managers can tick attendance for their own people only.

## Weekly summary (`/admin/weekly`)

Totals for the last seven days: taken, returned, requested, by person, most-taken parts, open requests and entries not yet checked in the audit. Managers see their own people only. The same summary is emailed on Monday morning to everyone whose profile has **Receive the weekly parts summary email** ticked and who has an email address (needs email set up).

## Forgot password

The sign-in page has a **Forgot your password?** link. It emails a link that works once and expires in an hour. It needs email set up on the site and an email address on the person's account; people add their own on the Change password page, or an admin adds it on their Edit page. Without email set up, the page tells people to ask an admin.

## Activity log (`/admin/activity`)

Linked from the Users page. Records who added or edited a person, reset a password, disabled an account, changed a profile's tick-boxes (listing what was added and removed), imported the catalog, changed stock, ran or downloaded a backup, or added a training session. Needs the **See the activity log** permission. Anonymous complaints are never recorded there.

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

- `NOTIFY_TO`: who is emailed about each new **parts request**, **training request** and **low stock** crossing. Take and return entries do not send email. A training request marked private sends only "a private request was submitted", without the text or the name.
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
- **Reset password**: a new temporary password, shown once. People can also use "Forgot your password?" if email is set up.
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

Not in this prototype: Microsoft/Outlook sign-in, importing the old Microsoft Forms history.
