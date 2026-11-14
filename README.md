# Pye-Barker Lancaster Office Portal

A small website for the Pye-Barker Lancaster Office: parts sign-out (take / return / request), training requests, and anonymous complaints. Everyone signs in with a username and password that an admin creates.

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

On a phone's browser the site shows a small **Get the app** bar at the bottom of the page: an **Install** button on Android, the two taps to use on an iPhone. It does not show inside the installed app, and **Not now** hides it for two weeks.

**QR code sign:** `/poster` (also under **Setup > QR code sign**) is a printable sign with a QR code that opens the site. It uses `BASE_URL`, or the address the page was opened at when that is not set.

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

- **Sort:** oldest first, newest first, or by name A to Z. The parts log and training log have the same choice. Sorting is by the entry's date, so imported history sits in its proper place.
- Each entry is one band: date and time, who, each part with its catalog description underneath, quantity, and where it went. Entries brought in from the old form carry a small "Imported" tag.
- **Checked box:** tick an entry once you have checked it against the shelf or paperwork. It records who ticked it and when. Click again to undo. **Mark all as checked** ticks everything still unticked in that section and date range.
- **Show: Not checked yet** hides entries already ticked.
- Cancelled entries are listed struck through and are not counted in the totals.
- If an entry is edited after it was checked, the tick is removed so it gets checked again.
- **Print** gives a clean printout without menus; **Download CSV** gives one row per part.

## The menu

- **Always in the bar:** Home, Announcements, Tasks, My activity.
- **Drop-downs:** Community (Company, Offices, Who to contact, People, Shout-outs, Events, Photos, Discussions, Daily question, Newsletters), Parts, Trucks, Training, Team and Setup. Each holds the forms first, then the pages for managing that area. **Team** is people and what goes out to them (Anonymous complaint, Users, Profiles, Manage tasks, Post announcements, Newsletters, Complaints); **Setup** is the site itself (QR code sign, Activity log, Backups, Import old data). People only see the items their profile allows; a group with a single item shows as a plain link, so a technician sees "Truck inspection" and "Anonymous complaint" as links.
- **One name for each thing:** Announcements (posting them is "Post announcements"), Tasks (giving them out is "Manage tasks"), Truck inspection, Anonymous complaint (reviewing them is "Complaints"), Certifications, Parts requests, and My activity for a person's own entries and requests.
- **Notification bell** at the top right on a computer: a red number for everything waiting on you, and a list when you press it: your open tasks by name with their due dates, then unread announcements, discussions with new replies, updates on your requests and, for people who manage them, open parts requests, truck problems and expiring certifications. **Notification settings** is at the bottom of the list.
- **Light / dark** is in the menu: the moon or sun at the right end of the bar on a computer, near the bottom of More on a phone. On the sign-in page, where there is no menu, it stays at the top right.
- **On a phone** there is a bar of five buttons fixed to the bottom of the screen: **Home**, **Parts** (the parts form), **Tasks** (with the number still to do), **Alerts** (the bell's list as a page, `/alerts`, with the number waiting) and **More**, which slides the whole menu up from the bottom with Notification settings, Change password and Sign out at the end. The phone's Back button closes it. Someone who cannot send parts entries but can read the log gets the log behind Parts; with neither there is no Parts button.
- A number beside a group is the total of what needs attention inside it (open requests, truck problems, expiring certifications).

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

When someone else changes the status or reply on a person's request (parts or training), that person sees an **Updated** marker and a number beside "My activity" until they look, and is emailed if they have an email address and email is set up.

## Trucks, usual parts and barcode scanning

- **Truck**: an optional field on the parts form. It is remembered for that person, and shown in the parts log, audit, exports and a "By truck" table in the usage summary. Admins can set someone's usual truck on their Edit page.
- **Usual parts**: the form shows the person's most-used parts as buttons; tapping one adds it.
- **Scan barcode**: opens the phone camera and puts the scanned code into the next part row. The barcode must contain the part number as it appears in the catalog. It needs camera permission and a secure (https) address.

## Training topics, sessions and attendance

- **Topics** (`/training/topics`): everyone who can send training requests sees the open, non-private requests and can tap **I want this too**. People who manage training also see **Edit wording** on each one; the original text stays in that request's history. The most wanted rise to the top, and the admin training log shows the count.
- **Sessions** (`/admin/training/sessions`, from the Training log): schedule a session with a date, time and place. Scheduling one from a training request lists the requester and everyone who added their name, and sets the request to Scheduled.
- On the day, tick who came and press **Mark as held**; the linked request becomes Completed.
- Each person sees **Training attended** under My activity. The sessions page can filter by person and export attendance as CSV.
- Managers can tick attendance for their own people only.

## Weekly summary (`/admin/weekly`)

Totals for the last seven days: taken, returned, requested, by person, most-taken parts, open requests and entries not yet checked in the audit. Managers see their own people only. The same summary is emailed on Monday morning to everyone whose profile has **Receive the weekly parts summary email** ticked and who has an email address (needs email set up).

## Forgot password

The sign-in page has a **Forgot your password?** link. It emails a link that works once and expires in an hour. It needs email set up on the site and an email address on the person's account; people add their own on the Change password page, or an admin adds it on their Edit page. Without email set up, the page tells people to ask an admin.

## Activity log (`/admin/activity`)

Linked from the Users page. Records who added or edited a person, reset a password, disabled an account, changed a profile's tick-boxes (listing what was added and removed), imported the catalog, changed stock, ran or downloaded a backup, or added a training session. Needs the **See the activity log** permission. What a complaint says, who sent it and replies to it are never recorded there; the only complaint event logged is that one was deleted, and by whom.

## Certifications (`/admin/certs`)

Record each person's licenses and certifications with an optional issuer, number, issued date and expiry date.

- The list shows **Expired**, **days left** (within 60 days) or **Current**, soonest expiry first, with a filter for the ones needing attention and a CSV download.
- Each person sees their own under My activity. In the last 30 days (and once expired) a warning shows on their home page.
- They are emailed once at 30 days and once at 7 days before expiry (needs email set up and an email address on their account).
- When something is renewed, edit the record and change the expiry date; reminders start again.
- The menu shows a count of records expired or expiring within 30 days.
- Needs the **Record and edit people's licenses and certifications** permission. Managers keep records for their own people only.

## Truck inspections (`/inspection`, `/admin/inspections`)

- **The form**: truck number (remembered), optional odometer, then each checklist item marked **OK** or **Problem**. A problem needs a short description. Up to four photos and an optional note. Answers are saved on the phone while filling it in; photos are not.
- **Problems** are emailed to `NOTIFY_TO` (needs email set up) and counted in the menu until someone marks them fixed, with an optional reply the sender sees under My activity.
- **Inspections page**: filter by date, person, truck or open problems; download a CSV with one row per checklist item.
- **Who is due**: everyone with a truck, longest since their last inspection first.
- **Edit the checklist**: add, reword, reorder or remove items. Inspections already sent keep the wording they were answered with.
- Sending needs **Send truck inspections**; viewing needs **See truck inspections**; marking fixed and editing the checklist need **Mark inspection problems as fixed**.

## Home page

The home page, from the top:

- **Critical announcements**: always first and shown every time, read or not.
- **Announcements**: unread ones first, marked New, each with its **I have read this** button; then the latest ones already read.
- **The Monthly Barker**: the newest newsletter and the three before it.
- **Shout-outs**: the latest three, with a button to give one.
- **Office at a glance**: a few quick facts about the person's own office that suit anyone (how many people are in it, announcements still to read, birthdays and anniversaries there this week, events and training coming up, new people to welcome), followed by anything waiting on that person because of what they run: open parts requests, truck problems, low stock, overdue tasks they gave out, certifications running out, entries not yet checked in the audit. Those only appear when the number is above zero, so someone with nothing to chase is not shown empty boxes. A manager's numbers cover their own people.
- **Your tasks**, then the form buttons (**What do you need to do?**), today's question, new hires, this week's birthdays and anniversaries, what is coming up, latest photos, **My status** and discussions.

On a phone it is one column in that order. On a wider screen announcements, the newsletter, shout-outs, new hires, photos and discussions are on the left; office at a glance, tasks, the buttons and the rest are on the right.

## Discussions (`/discussions`)

- Three sections to start: **Tech support**, **General** and **Introductions**. Anyone with **Read and post in Discussions** can start a thread, reply, add up to four photos to a post, and search.
- **Following**: starting or replying to a thread follows it; anyone can follow or stop from the thread page. When someone else replies to a thread you follow, the Discussions link in the menu shows a count and the reply is listed at the top of your home page until you open the thread. There is no phone notification or email yet.
- In Tech support the person who asked (or a moderator) can mark a thread **Solved**.
- People can remove their own replies, and their own thread while nobody has answered it. **Remove other people's posts and threads; lock, pin and move threads** is the moderator permission; what moderators remove is recorded in the activity log.
- After an update, posting is given once to every profile that can send parts forms, and moderating to profiles that manage people.
- Photos live in `/data/uploads` with the others.

## Newsletters (`/newsletters`, `/admin/newsletters`)

- Anyone with **Upload and remove the monthly newsletters** uploads a PDF (up to 25 MB) under **Team > Newsletters**, choosing its month. A title and up to four highlight lines are optional.
- Each page (up to 12) is turned into a picture so it reads well on a phone; **Open the PDF** gives the original. This uses `pdftoppm` from poppler-utils, which the `Dockerfile` installs. Without it, people open the PDF itself.
- Everyone signed in can read every issue at `/newsletters`. Nothing is visible signed out.
- After an update, the permission is given once to profiles that already manage people. Tick it on any other profile that should have it.
- The files live in `/data/uploads` with the photos, so **Download all photos** on the Backups page includes them.

## Announcements (`/notices`, `/admin/announcements`)

- Anyone with **Post announcements** can post a title and message, with an optional "show until" date.
- Someone who sees everyone posts to **everyone**. A manager posts to **their own people**.
- It is marked New in the Announcements panel of each person's home page until they press **I have read this**, then stays in that panel's list and on their Announcements page. The menu shows how many are unread.
- **Critical** keeps it at the very top of everyone's home page, even after they have read it, until its "show until" date passes or it is switched off from the announcement's own page. Use it for things like open enrollment.
- **About** adds a small label (HR, Training, Safety or Event). **Pin** keeps it at the top of the list; pin or unpin later from the announcement's own page.
- The poster sees "7 of 12 read", and a page listing who has read it (with the time) and who has not.

## Tasks (`/tasks`, `/admin/tasks`)

Something one person asks another to do, with an optional due date.

- **Assigning** (Team > Manage tasks): say what needs doing, add details and a due date if you like, then choose who it is for. Tap a group button to give it to **Everyone** or to everyone on a profile (for example all Technicians), or type a name in the search box to pick particular people; you can mix both. Each person gets their own copy, and the form says how many people that will be before you send it. Needs the **Assign tasks** permission; a manager can assign to their own people only.
- **For the person**: every open task appears at the top of their home page and in their notification bell (Alerts on a phone) by name with when it is due ("Due tomorrow", "Overdue by 2 days"), overdue first, and counts toward the bell's number. **Tasks** in the menu lists them with the details and a **Mark as done** button with an optional note.
- **Following up**: the Manage tasks page shows open, overdue and done tasks, who each is for, and any note left when it was done. You can edit, reassign, mark done on someone's behalf, reopen or remove a task.
- The person is emailed when a task is assigned if they have an email address and email is set up.

## Push alerts (`/settings/notifications`)

Alerts that pop up on a phone or computer even when the site is closed. Reached from **Notification settings** at the bottom of the bell, or at the bottom of Alerts or More on a phone.

- **Each person turns alerts on per device** with "Turn on alerts on this device"; the phone or browser asks them to allow notifications. The page lists their devices and can send a test alert.
- **iPhone and iPad**: alerts only work once the site has been added to the Home Screen (Safari > Share > Add to Home Screen) and opened from there. Android and computers work from the browser.
- **What sends an alert**

  | Alert | Goes to |
  |---|---|
  | A task is assigned | The person it is for |
  | A critical announcement is posted | Everyone it is addressed to |
  | A parts or training request is updated | The person who asked |
  | A reply in a discussion | Everyone following that thread |
  | A task is marked done | Whoever assigned it |
  | Someone requests parts | People who manage parts (and can see that person) |
  | A truck problem is reported | People who can see inspections (and that person) |
  | A part drops to its minimum | People who manage stock |

- **Each person chooses** which of these they want, with tick-boxes on the same page. They only see the kinds that apply to their profile. Everything is on to begin with. The bell on the site shows everything regardless.
- An alert carries a short title and one line of text, and tapping it opens the right page. Anonymous complaints never send alerts.
- Nothing needs configuring: the site makes its own signing keys on first use and keeps them in the database. The server must be able to reach the internet to send (Render can).

## Looking at photos

Tapping a photo (in a discussion, a truck inspection or a parts return) opens it in a viewer on top of the page, with a **Close** button and arrows when there is more than one. The phone's Back button closes the viewer and leaves you on the page you were on, so the installed app is never left on a bare image with no way back.

## Deleting records

People whose profile has **Permanently delete...** ticked see a delete button at the bottom of a parts entry, training request or truck inspection. Deleting a complaint needs that permission **and** complaint access.

- Deleting is permanent. There is no undo, and a deleted record is not in later backups. For a mistake that should stay on the record, use **Cancel** instead.
- Deleting a parts entry removes its photo and returns stock to what it would be without it.
- Deleting a training request keeps any session held for it and its attendance.
- Deleting a complaint means its tracking code no longer finds anything.
- Each deletion is written to the activity log with who did it. For a complaint the log says only that one was deleted; for a private training request it leaves out the wording.

## Importing the old Microsoft Forms history (`/admin/import`)

Under **Setup > Import**. It takes an import file (`.json`) prepared from the two Forms exports and adds each old parts entry and training request under the person who sent it, with its original date.

- **People**: someone is matched to an existing account by email address or by full name. Anyone not found gets a new account that is switched off, on the Technician profile, so their history has a name on it. To let them in, press Enable and Reset password on the Users page.
- **Parts and quantities**: the old form was free typing ("(7) SIGA-CT2", "5x 12-7", "3 Cases (15) batteries"). Each line was read into a part and a quantity. Where that needed a judgment call, the entry's note keeps the original wording after "As typed:". A line with no quantity counts as 1. Something counted in cases with no total given is recorded as, for example, "3 x SLA12-7F batteries (cases)".
- **Van stock or job**: an eight-digit number or an LPF number is taken as the job number; "Truck 309" or "309" as the truck; anything else is van stock, with unusual wording kept in the note.
- **Old parts requests** can be brought in as Fulfilled (the default, since the old form never recorded an outcome) or as open requests.
- Importing the same file twice adds nothing the second time. Old entries do not change stock levels, and nobody is notified.
- **Remove everything that was imported** (needs the delete permission) takes the imported entries back out, for starting over with a corrected file. Accounts are left alone.

The import file contains people's names and emails, so it is not kept in the code repository.

## Editing and cancelling

- A person can edit or cancel their own parts entry or training request from **My activity** for 24 hours (`EDIT_WINDOW_HOURS`), as long as nobody has acted on it (a request that is no longer "New" is locked).
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

- In a small office, the **content** of a complaint can give the writer away. The form tells people this.
- A reviewer who watches the complaints list all day could notice roughly when a new one appears.
- Your hosting company's own network logs are outside this app's control. They record which addresses visited the site, though not what was typed.

## Status values

- Parts **requests**: New, Ordered, Fulfilled, Declined. Take and return entries are a log and have no status.
- Training requests: New, Reviewed, Scheduled, Completed, Declined.
- Complaints: New, Under review, Resolved, Closed.

A reply typed with a status change is shown to the submitter (under My activity, or via the tracking code for complaints).

## Where things are

```
app/server.js        starts the site
app/app.js           security headers, sessions, routes
app/db.js            database tables
app/routes/          one file per area: auth, home, parts, training, complaints, admin, catalog, backups, newsletters, forum
app/permissions.js   profiles, permission list, manager scoping, master account
app/backup.js        nightly backups
app/changes.js       edit/cancel rules and history
app/views/           the pages
public/              stylesheet, scripts, and the home-screen app files (manifest, sw.js, icons)
scripts/create-admin.js
test/portal.test.js  automated tests
```

Not in this prototype: Microsoft/Outlook sign-in.

## Community: people, new hires and the daily question

The **Community** menu holds People, Discussions, Daily question and Newsletters.

**People (`/people`) and profiles**
- Everyone with an active account is listed, with a search over names, job titles, skills and "about me".
- Each person fills in their own profile under **My profile** (`/profile`): photo, job title, start date, about me, and "what I know about" (skills, separated by commas). All optional. The photo is shrunk on the phone before it is sent.
- A profile also lists the person's certifications on file, by name only (no dates).
- Phone and email show on a profile only if the person ticks the box for each.
- The home page reminds people with an empty profile to fill it in.

**Contact list (Setup > Import)**
- Upload the office contact list as a CSV (in Excel: File > Save As > CSV) with a Name column and, optionally, Title, Email and Phone. A row with only a name in it (MANAGEMENT, SERVICE...) is a department heading for the rows under it.
- People who already have an account are matched by email, by the "first.last" in the email, or by name, and keep the name they have on the site. Their job title, department, work email and phone are set from the list, and the phone and email are shown on their profile (each person can untick that under My profile).
- Everyone else is added with sign-in switched off: they are on the People page, but cannot sign in until an admin presses Enable and Reset password under Users.
- Names and titles typed in capitals are tidied ("MIKE MCDONNELL" becomes "Mike McDonnell"). Uploading a newer list updates titles, departments and phones; nobody is removed. Disabling an account by hand takes that person off the People page.
- The People page can be filtered by department.

**New hires**
- On **Edit person** (Team > Users), **Announce as a new hire** takes a job title, start date and a few words. The person then appears in a **Welcome aboard** panel on everyone's home page for 14 days.
- Everyone can press **Say welcome**, and add a short message from the person's profile. The messages stay on the profile afterwards.

**Daily question (`/daily`)**
- One light question a day on weekdays (the weekend keeps Friday's), the same for everyone, on the home page. Results, with who picked what, show once you have answered. You can change your answer during the day.
- The site starts with 120 built-in questions. Anyone can suggest one; it waits for approval.
- People whose profile has **Run the daily question** approve or decline suggestions, add their own, and can set a question for a particular day. Approved suggestions and added questions come up before the built-in list.

**Shout-outs (`/shoutouts`)**
- Anyone can thank a coworker by name with a short note. The latest show on the home page and all of a person's shout-outs stay on their profile. Others can applaud. The person gets a push alert if they have alerts on.
- Whoever wrote one, or a moderator, can remove it.

**Birthdays and work anniversaries**
- A birthday is a month and a day only, set by the person under My profile (never a year, and optional). Anniversaries come from the start date, from one year on.
- The home page shows a **This week** panel for every office, today first and your own office first within a day, with a button to wish them well (one wish per person).

**Events (`/events`)**
- People whose profile has **Post events** add an event with a date, time, place and details, and can tick "ask people what they are bringing" for a potluck. Everyone presses **I'm in**, can say what they are bringing, and can back out.
- Every office sees and can join every event. An event is hosted by the poster's office, or (from people who can see every office) by the whole company. Events appear with training sessions under **Coming up** on the home page.

**Photos (`/photos`)**
- Anyone who can use Discussions can post up to six photos at a time with a caption; others can like them. Photos are shrunk on the phone before they are sent. The poster or a moderator can remove one. The wall is shared by every office.

**Office pages (`/branches`)**
- Each office has a page with a photo, address, phone, a few words about it, its people grouped by department, its upcoming events, and its latest shout-outs and photos.
- The page is edited by people who manage accounts in that office, or anyone who can see every office.

## The company: offices, services and who to contact

**Company (`/company`)** is the main page for getting to know the business: how many offices in how many states, a search box, every service with the number of offices that offer it, each region with its vice president and directors, and the departments on the "Who to contact" list. Everyone signed in can see it.

**Offices (`/branches`)** is the finder: every office with its number, town, street, region and what it does. Filter by service, state or region, or search by town or office number. Each office opens to its own page.

**What an office does** is a set of tick-boxes on the office's page (**Edit this page**), set by that office's admin or a corporate admin. The services are the company's own: Fire Alarms & Detection, Fire Sprinklers, Fire Extinguishers, Fire Suppression Systems, Security, Proactive Video Monitoring, Life Safety Equipment and Mass Notification. Corporate admins can add, rename or remove services under **Corporate > Offices and admins > Services offices can offer**.

An office page also shows the name the office goes by when that differs from its town ("Lancaster" for the Ephrata office), its market, its product lines, its address (a link to a map) and its phone. The finder's search box looks in all of these, so "Naples" finds Bonita Springs and "Genetec" finds the offices that carry it.

**Who to contact (`/contacts`)** is the company-wide contact list by department, with search.

Corporate admins load the company information under **Corporate > Offices and admins > Company information**:
- **Office list**: one button adds every office on the company list (233 offices). `app/office_list.txt` holds each office's number, town, street and region, and `app/office_details.json` holds what the company's branch finder says about each: services, the name it goes by, market, product lines, address and phone. Accounting systems, old codes and acquisition notes from the branch finder are deliberately left out. An office already on the site under another name is matched to its entry first (it is offered automatically when its name is the one a listed office goes by), so it is not added twice; it keeps its name and everything in it. Each new office gets its own truck checklist and no stock. Pressing the button again adds only what is missing and fills in details an office does not have yet; it never overwrites what an office's admin has entered.
- **Office details in bulk**: a CSV with a Number column and any of Services, Address, Phone, About. Services are codes or names separated by commas ("FE, KH").
- **Who to contact**: the `.json` file prepared from the "Who To Contact" spreadsheet. Uploading a new one replaces the list.

With hundreds of offices, the Corporate page shows in full only the offices that have people on the site; the rest are in a searchable list, and opening one shows its card for appointing an admin. The office box beside a corporate admin's name lists only offices in use.

## Corporate and office admins

There are two levels of admin.

- **Corporate admins** see and manage every office. They have a **Corporate** menu: **Offices and admins**, **Profiles** and **Backups**. The master account is always one; others are people on a profile with **See and manage every office** ticked (the site starts with one called **Corporate admin**).
- **Office admins** do everything an admin can inside their own office only: they add and manage that office's people, and never see another office's parts, trucks, tasks, training, announcements or complaints. They are people on a profile that can manage accounts but cannot see every office (the starting **Admin** profile).

On **Corporate > Offices and admins** a corporate admin can:
- add an office, or rename one;
- appoint an admin for an office: either someone already in that office, or a new person, who is created in that office and given a temporary password shown once;
- stand an office admin down (they go back to the Technician profile);
- make an existing person a corporate admin, or stand one down (they become an admin of their own office and are signed out so the change takes hold at once). Nobody can stand themselves or the master account down.

## Offices

One site for every office. Each person belongs to one office; everything that existed before offices belongs to Lancaster.

**Shared by everyone:** People and profiles, Discussions, the daily question, new-hire welcomes, newsletters, and the parts catalog (the list of part numbers).

**Private to each office:** the parts log, requests, audit and usage; stock counts and minimums (the same part number has its own count in each office); truck inspections and each office's own checklist; tasks; training requests, topics, sessions and attendance; certifications; announcements; anonymous complaints; the Users page and the activity log.

- **Everyone sees only their own office**, whatever their profile. An Admin in one office can do everything an Admin can, inside that office.
- **Seeing every office** is the master account, plus any profile with the tick-box **See and manage every office**. Those people get a office box beside their name (in More on a phone) to choose which office the pages show, or **All offices** together. Stock, the checklist and new training sessions always belong to one office: the one chosen, or their own when looking at all.
- **Setup > Offices** (for the same people): add or rename offices. A new office starts with a copy of the first office's truck checklist and no stock.
- **Adding people to an office**: choose it in the office box, then add them under Team > Users (or upload its contact list under Setup > Import). A office admin's new people always join that admin's own office. Moving someone to another office is on Edit person, for people who can see every office.
- **Announcements** go to the office they were posted in. People who can see every office can choose **Every office** when posting.
- **Complaints** record which office they came from (still nothing about who sent them) and go to that office's reviewers.
- **Profiles (permission sets), backups and the Forms history import** cover the whole site, so they are only for people who can see every office.
- **Email**: the `NOTIFY_TO` and `COMPLAINT_NOTIFY_TO` mailboxes are the first office's. Other offices rely on the site's own alerts (the bell and push alerts) for new requests, truck problems and low stock.


## The lock, and Face ID / fingerprint sign-in

- **The site locks itself** when it is closed and reopened, and after 5 minutes without use (`LOCK_AFTER_MINUTES`; 0 switches the timer off, closing still locks). A locked site shows only a lock screen with the person's name: nothing else opens, and forms sent while locked are not accepted, until they confirm who they are.
- **To get back in**: Face ID, a fingerprint, Windows Hello or the device's screen-lock code if that is set up on the device, or the password. On a device where it is set up the phone asks for the face or fingerprint straight away.
- **Setting it up**: each person does it once per phone or computer under **Password and Face ID** (More on a phone, their name at the top on a computer), with **Set up on this device**. The home page offers it until they have. Devices are listed there and can be removed.
- **Signing in from scratch** (after Sign out, or on the sign-in page) also works with **Sign in with Face ID or fingerprint**, with no username or password typed.
- The face or fingerprint never leaves the device and the site never sees it. The device holds a key made for this site alone (a "passkey") and the site stores only the matching public key. It works only on the site's real address, so a look-alike site cannot use it.
- **Lost phone**: an admin presses **Reset password** for that person. That signs them out everywhere and removes all their Face ID / fingerprint devices; they set it up again after signing in with the temporary password.
- People stay remembered on a device for 30 days, so the lock screen knows who they are; **Sign out** on the lock screen is for a shared device.
- Short trips out of the site (taking a photo for a form, checking a text) do not lock it unless they last longer than the limit. Unsent parts, training and inspection forms keep their draft.
- Changing the site's address (for example to a custom domain) means everyone sets up Face ID again; passwords are not affected.

## Security notes

- **Signing in**: passwords are stored only as bcrypt hashes. Wrong guesses are limited two ways: 10 per connection per 15 minutes, and 10 per username per 15 minutes wherever they come from. Resetting the password by email lifts the wait.
- **Signed out everywhere**: changing a password signs that person out on every other device; an admin resetting a password or disabling an account signs them out on all of them.
- **Sessions** last 30 days on a device, in a cookie the page's scripts cannot read, sent only over HTTPS in production.
- **Every form** carries a one-time-per-session token, so another website cannot submit forms as a signed-in person.
- **Every page** except sign-in and password reset needs a sign-in; every management page and action checks the profile's permission, and a manager's reach stops at their own people.
- **Uploads** are stored outside the public folder under random names, checked to really be images (or a PDF for newsletters), and only served to people allowed to see the entry they belong to.
- **Push alerts** are only ever sent to Google's, Apple's, Mozilla's or Microsoft's alert services.
- **Password-reset links** work once, expire in an hour, are stored hashed, and are left out of the server log.
- **The lock**: see above. A phone left on a desk or a browser left open does not leave the site open.
- Not included: a required second step on top of the password. Face ID / fingerprint is offered, not forced, so the site is still as strong as people's passwords.
