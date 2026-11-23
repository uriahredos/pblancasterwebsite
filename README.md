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

Someone who opens a link while signed out is sent to the sign-in page and then straight back to that form (a link to the complaint form goes by way of the home page; see Anonymous complaints).

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

All the data is the database, `/data/portal.db`, and the photos and documents in `/data/uploads`. While the site is running, the newest changes to the database sit in two files beside it (`portal.db-wal` and `portal.db-shm`), so a copy of `portal.db` taken by hand can be missing recent work. Take copies from the Backups page instead. When the site is stopped in the ordinary way (a deploy, a restart) it folds those two files into `portal.db` and closes it before it exits. See Backups below.

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

- **Import**: upload a CSV file. It needs a part number column (for example "Part Code", "Part Number" or "Item"); "Description", "Category", "Manufacturer" and the cost ("Cost", "Unit Cost" or the accounting list's "Cost/Price") are used if present. The cost is what one costs the company; it is shown only on the catalog and inventory pages, to people who manage them, never on the parts form. **A selling price and every other column are ignored and not stored.** A file with no cost column leaves the costs as they were.
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

- **Always in the bar:** Home, Tasks, Social. Discussions is in the Community menu. Announcements sits in the Community menu (and on the home page and the bell); My activity is reached from the home page, the bell and the account links on a phone.
- **Drop-downs:** Community (Company, Offices, Who to contact, Activity feed, Discussions, People, Shout-outs, Events, Daily question, Newsletters), Parts, Trucks, Training, Team and Setup. Each holds the forms first, then the pages for managing that area. **Team** is people and what goes out to them (Anonymous complaint, Users, Profiles, Manage tasks, Post announcements, Newsletters, Complaints); **Setup** is the site itself (QR code sign, Activity log, Backups, Import old data). People only see the items their profile allows; a group with a single item shows as a plain link, so a technician sees "Truck inspection" and "Anonymous complaint" as links.
- **One name for each thing:** Announcements (posting them is "Post announcements"), Tasks (giving them out is "Manage tasks"), Truck inspection, Anonymous complaint (reviewing them is "Complaints"), Certifications, Parts requests, and My activity for a person's own entries and requests.
- **Notification bell** at the top right on a computer: a red number for everything waiting on you, and a list when you press it: your open tasks by name with their due dates, then unread announcements, discussions with new replies, updates on your requests and, for people who manage them, open parts requests, truck problems, expiring certifications and a backup that did not work. **Notification settings** is at the bottom of the list.
- **Light / dark** is in the menu: the moon or sun at the right end of the bar on a computer, near the bottom of More on a phone. On the sign-in page, where there is no menu, it stays at the top right.
- **On a phone** there is a bar of five buttons fixed to the bottom of the screen: **Home**, **Social**, **Parts** (the parts form), **Tasks** (with the number still to do) and **More**, which slides the whole menu up from the bottom with Notification settings, Change password and Sign out at the end. The phone's Back button closes it. Alerts are the **bell at the top right**, the same as on a computer, with the number waiting; its list is also a page of its own at `/alerts`. Someone who cannot send parts entries but can read the log gets the log behind Parts; with neither there is no Parts button.
- A number beside a group is the total of what needs attention inside it (open requests, truck problems, expiring certifications).

## Look and feel

The banner uses the Pye-Barker logo (`public/logo.png`) and the colors are taken from it; they are set at the top of `public/styles.css`. The button at the top right switches between light and dark. The choice is remembered on that device; until someone uses the button, the site follows the device's own light/dark setting.

## Inventory (`/admin/inventory`)

Where an office's parts are. It is being built in steps: locations, movements, exports and the inventory count are here; a layout made for the accounting system's import comes later.

- **Every office has** one **Main warehouse**, one location for **each technician's vehicle**, and any **other locations** it adds for itself (a trailer, a second stockroom, a job site).
- **Vehicles**: one technician each. The first time the page is opened, a vehicle is made for everyone in the office who already has a truck number on file ("Truck 14"). Add others by hand. Handing a vehicle to someone else keeps what is in it.
- **Putting a location away**: a location that is no longer used is put away, not deleted, and only once it is empty. Its history stays, and it can be used again. The main warehouse cannot be put away.
- **What a location holds** is never typed over. It is worked out from the movements in and out of it, so there is always a record of who moved what, and when. Each location's page lists what it holds and its latest movements.
- **The parts form moves the parts.** Each line of a Take or Return whose part number is in the catalog becomes a movement, saved together with the entry:

  | On the form | What moves |
  |---|---|
  | Take, for a job | Out of the person's own vehicle (the main warehouse if they have no vehicle) |
  | Take, van stock | From the main warehouse into their vehicle. This is how a vehicle is restocked |
  | Return, from a job | Back into their vehicle (or the warehouse) |
  | Return, van stock | Out of their vehicle, into the warehouse |

  The vehicle is the one assigned to the person; the form shows which it is and asks nothing. A request moves nothing: it asks whoever orders parts for something the office does not have. A part typed in that is not in the catalog moves nothing. Someone with **Manage inventory locations** (the warehouse manager) gets a **Vehicle** list on the form instead, to sign parts into or out of anybody's vehicle.
- **Taking more than a place has on record is allowed, and marked "To check".** Work is never held up by the numbers; the Inventory page shows how many movements each location has to check, and the next count settles them. Vehicles start empty, so until a vehicle has been counted most of what is taken from it will be marked.
- **Editing an entry** remakes its movements, **cancelling** it takes them away, and so does deleting an entry for good.
- **Each location opens with its figures**: how many items it holds across how many parts, what they are worth (for people who see costs), how many came in and went out in the last 30 days and how many of those were used on jobs, how many movements are to check and how many parts the records have below zero, and the parts most used from it.
- **Move parts** on the Inventory page moves parts by hand between two of the office's locations, or takes a delivery into one.
- **The Stock page is the main warehouse.** Its "on hand" is what the warehouse's movements add up to. A count, a delivery or a correction made there is written as a movement. When this was switched on, what each office's Stock page showed became that office's opening warehouse stock, so the numbers did not change.
- When a person is removed, their vehicle stays, with what is in it, and nobody's name on it until it is handed to someone.

**Exporting the inventory**

- **Export by location** on the Inventory page downloads a spreadsheet of what the office holds right now: one line per part in each place (the main warehouse, each vehicle, any other location), with how many, what one costs and what the lot is worth.
- **Export totals** is one line per part for the whole office, split between the warehouse, the vehicles and other locations.
- **Export this location**, on a location's own page, is that warehouse or vehicle by itself.
- **Export every office** is offered to people who see every office.
- Exports show the records as they stand that moment; no count is needed first. A vehicle the records have gone below zero on shows as a minus figure, which is the sign it wants counting.
- Needs **Export the office's inventory** (given once to profiles that manage inventory locations). Every export is written in the activity log.

**The inventory count (`/admin/inventory/count`, the Inventory count button on the Inventory page)**

For when the office takes inventory, each quarter for example. It is not needed for an export.

- **Starting**: someone with **Start an inventory count...** picks the month it is for and starts it. One count at a time for an office.
- **Counting**: each location has a count sheet that works on a phone. Type how many of each part are really there; leave a box empty for a part not counted; save and come back as often as needed. A part found that is not on the sheet is added at the bottom by its part number. **Scan barcode** jumps to that part's box. The sheet does not show what the records expect, so the count is not steered by them.
- **Who counts**: people with **Count inventory**, for any location of the office. Every technician can count **their own vehicle**: while a count is under way and theirs has not been started, their bell says "vehicle to count".
- **Looking it over**: the count's page shows how far each location has got and every line where the count and the records differ, with the value of the difference for people who see costs.
- **Closing the count** needs the password typed in the last ten minutes. It corrects the records to what was counted (parts that moved after being counted are left as they moved), settles the "To check" marks in the places counted, and keeps a copy of every location's figures with that day's costs. That copy is that count's inventory: nothing done afterwards changes it, and it has its own **Export these figures** button. Locations nobody counted keep the figures the records have, and the page says which they are before you close. A closed count cannot be reopened.
- **Setting a count aside** throws away what was counted and changes nothing else.
- **Who**: anyone who can see the parts log can look. Moving parts by hand, adding, renaming, handing over and putting away need **Manage inventory locations** (given once to profiles that already manage stock). Costs and values show only to people with that permission or who manage the catalog.
- An office sees and changes only its own locations. Inventory lives in the site's own encrypted database, so it is covered by the same backups.

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
- A session can only be scheduled from a request that belongs to the office the session is in, and that the person scheduling it could open on the Training log (for a manager: a request from one of their own people). Someone who sees every office chooses the request's office first.
- A session scheduled from a **private** request is not listed to the office under Coming up, on the Topics page or the home page. On the Topics page the people expected at it still see it. The form does not copy the request's wording into the session's title.
- On the day, tick who came and press **Mark as held**; the linked request becomes Completed.
- Each person sees **Training attended** under My activity. The sessions page can filter by person and export attendance as CSV.
- Managers can tick attendance for their own people only.

## Weekly summary (`/admin/weekly`)

Totals for the last seven days: taken, returned, requested, by person, most-taken parts, open requests and entries not yet checked in the audit. Managers see their own people only. The same summary is emailed on Monday morning to everyone whose profile has **Receive the weekly parts summary email** ticked and who has an email address (needs email set up).

## Forgot password

The sign-in page has a **Forgot your password?** link. It emails a link that works once and expires in an hour. It needs email set up on the site and an email address on the person's account; people add their own on the Change password page (once they have replaced a temporary password with their own), or an admin adds it on their Edit page. Without email set up, the page tells people to ask an admin.

## Activity log (`/admin/activity`)

Linked from the Users page. Records who added or edited a person, reset a password, disabled an account, changed a profile's tick-boxes (listing what was added and removed), imported the catalog, changed stock, ran or downloaded a backup, downloaded the photo archive, checked a saved copy of the database key (only that it was done and whether it matched), or added a training session. A restore is recorded too. Needs the **See the activity log** permission. What a complaint says, who sent it and replies to it are never recorded there; the only complaint event logged is that one was deleted, and by whom.

- **Spreadsheet exports** are recorded: who took which file and how many rows. The export of sales leads (every customer's contact details) also asks for the password again if it was not typed in the last ten minutes, like a backup.
- **Sign-in history** is recorded too: each sign-in with how it was done (password, or Face ID / fingerprint), on what kind of device and the address it came from; a wrong password against a real account, with the address it came from; a wrong password at the lock screen or on a form that asks for it again; the pause after ten wrong passwords; a refused expired temporary password; and changes of password or email address. Unlocks are not recorded. A wrong try against a username that does not exist is not recorded either, because what was typed there may well be a password. Passwords are never recorded.
- **Only people who look after every office see the sign-in entries** (the **Sign-ins** button). An office admin does not get a list of who signed in when: next to the date on an anonymous complaint, that would be a hint about who sent it. For the same reason an office admin does not see when someone changed their password or reset address, or set up or removed Face ID.
- **Removing a person for good** deletes these entries about them (their sign-ins, wrong passwords, and changes of password, reset address and Face ID). What they did for the office stays in the log.

## Certifications (`/admin/certs`)

Record each person's licenses and certifications with an optional issuer, number, issued date and expiry date.

- The list shows **Expired**, **days left** (within 60 days) or **Current**, soonest expiry first, with a filter for the ones needing attention and a CSV download.
- Each person sees their own under My activity. In the last 30 days (and once expired) a warning shows on their home page.
- They are emailed once at 30 days and once at 7 days before expiry (needs email set up and an email address on their account). A reminder that cannot be sent yet (email not set up, no address on the account, or the mail server refused it) is not used up: it goes out once it can.
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
- **Your tasks**, then the form buttons (**What do you need to do?**), today's question, **Coming up** (birthdays, anniversaries, events and training in one list) and **Activity feed** (new hires, latest photos and discussions in one section). A person's own open requests, last truck inspection and certifications sit under **Yours** inside Office at a glance. The newsletter shows its cover only while an issue is new (about three weeks), then shrinks to one line with a Read button. A section with nothing in it shrinks to one line or is left out.

On a phone it is one column in that order. On a wider screen announcements, the newsletter, shout-outs, new hires, photos and discussions are on the left; office at a glance, tasks, the buttons and the rest are on the right.

## Help (`/help`)

Short how-to guides built into the site, reached from **Help** at the right-hand end of the menu bar on a computer (and in the account menu), and at the top of **More** on a phone.

- **Only your own jobs.** A guide is listed only for someone whose profile lets them do the job it describes: a technician sees the everyday guides, a manager also sees the managers' ones. Opening the address of a guide you may not see gives "not here".
- **A "?" on the page.** Any page a guide explains shows a round **?** at the top right that opens that guide, with a Back button that returns to the page.
- **Find a guide.** The box at the top of Help leaves only the guides that mention what is typed.
- **Print.** Every guide has **Print this guide**, which also saves it as a PDF from the print window.
- **Adding or changing a guide** is a matter of editing the files in `app/help/` (one list of guides per area; the layout is described at the top of `app/help.js`). The tests check that every guide is well formed and names real permissions.

## Parts section layout

- **The Parts menu holds five things**: **Take, return or request** (the parts form), **Parts requests**, **Inventory**, **Parts log** and **Catalog**. For a technician, who only has the form, **Parts** is a single link straight to it.
- **Tabs instead of more menu items.** Inventory pages share a strip of tabs: **Warehouse and vehicles**, **Warehouse stock and minimums** (the page that used to be called Stock) and **Inventory count**. The Parts log shares one with **Audit** and **Usage summary**. A tab shows only to someone whose profile allows that page.
- **The Inventory page leads with the list** of places. Moving parts or recording a delivery, adding a vehicle and adding another location are folded away under their own headings until wanted.
- **Every box where a part is typed offers the catalog** (the parts form, starting to track a part, moving parts, adding a part to a count): type a number or a name and pick from the list. Anything else typed is kept as it is, so a part that is not in the catalog can still be entered.

## Inventory count: saving and finishing

- **Saving is not finishing.** A count sheet has two buttons. **Save and come back later** keeps the numbers typed so far and nothing else; the place shows as **In progress** and can be carried on at any time, by the same person or another. **Save and mark as finished** is the only thing that shows the place as **Done**. A finished place can still be changed, or opened again with **Not finished after all**.
- **The technician's reminder stays** in the bell until they mark their own vehicle finished, not just until their first save.
- **Closing** warns about any place not marked finished; it can still be closed, and anything not counted keeps the figures the records have.
- **Adding a part that is not on the sheet** is at the top of the sheet, with its own button. A part typed by hand that the catalog does not have is accepted there and when moving parts: it joins the catalog with no description or cost (noted in the activity log) so it can be kept track of.

## Warehouse stock: levels, figures and alerts

- **Minimum and maximum.** Each warehouse part can have a **minimum** (alert at or below this) and a **maximum** (what an order should bring it back up to). The form on the Warehouse stock page asks only for the part and its levels: how many are on the shelf comes from the records (deliveries, parts taken, counts), so setting levels counts nothing and moves nothing. A part the warehouse has never held starts at 0.
- **Everything in the warehouse is listed**, whether or not it has a level: the page shows every part the main warehouse holds (the same parts and quantities as the Main warehouse line on the Inventory page) plus any part given a level. A part with no minimum shows a **Set** link.
- **Figures at the top:** parts in the warehouse, how many are low or out, how many items to order, items used in the last 30 days, the value on the shelf at catalog cost (only for people who may see costs), and how many are over their maximum. Under them, the five **most used** parts of the last 30 days and the five **running out soonest** at that pace.
- **In the table:** minimum, maximum, used in 30 days, the level (OK, Low, Out, Over) and an **Order** quantity for every low part: enough to reach its maximum, or just past its minimum if it has none.
- **Export what to order** downloads that list as a spreadsheet.
- **Alerts.** When a part goes from above its minimum to at or below it, the people who manage stock in that office get an alert on their phone or computer (if they have alerts on, and have not switched "A part drops to or below its minimum" off), and the home office also gets the email. This now happens however the parts leave the warehouse: the parts form, a move to a vehicle, or a correction. Each part alerts once, not on every further take.

## Fleet (`/fleet`)

The menu group that was called Trucks is **Fleet**. It holds the **Fleet list**, **Sign out equipment**, the **Truck inspection**, and (for people who run them) the inspection log and checklist.

- **Fleet list.** Everything the office runs, by kind: trucks and vans, trailers, lifts and other equipment, each with its details, plate or serial, and whose it is. Everyone in the office can see it. A technician's truck that carries parts (an Inventory location) is listed with the rest. Each office has its own list.
- **Keeping the list** needs **Keep the fleet list** on the profile (given to start with to whoever could manage truck inspections): add something, change it, or put it away. Putting something away keeps its history and it can be brought back.
- **Signing equipment out** (`/fleet/signout`). Anything ticked "People sign it out before using it" (a scissor lift, a shared trailer) is signed out with: which one, the day and time it is taken, the day and time it comes back, where it will be used, and optionally a job number and a note. The site works out how long that is. Needs **Sign out lifts and other shared equipment** (given to start with to everyone who could use the parts form).
- **No double booking.** If someone already has it for any part of that time, the site says who, when and where, and refuses.
- **Who has what.** The Fleet list and the sign-out page both show what is out now, due back, or coming up, with who, where and for how long. The person who signed it out, or whoever keeps the fleet list, marks it **returned** (or cancels it before it has gone out). Each item's own page keeps its sign-out history.

## Search (`/search`)

The magnifying glass at the top right, beside the bell, opens one search for the whole site.

- **What it finds:** pages (by name or by another word for them, so "reset password" finds Users for a manager and Password and Face ID for everyone), how-to guides, people (name or job), offices, and parts from the catalog (number or description).
- **As you type:** results fill in under the box. **Enter** goes straight to the first one.
- **Only what you may open.** A result is never shown for a page or guide the person's profile does not allow. Parts show only to people who work with parts: someone who runs stock lands on Stock for that part, everyone else on the parts form with the part already filled in.
- The list of pages it knows is in `app/search.js`; a test fails if a link is added to the menu without adding it there.

## Home page: Manage panel and first-time checklist

- **Manage.** Anyone whose profile lets them run something sees a **Manage** panel near the top of the home page: the jobs they do most (add a person, assign a task, post an announcement, the on-call schedule, parts requests, low stock, inventory, truck problems, certifications and so on, each only if their profile allows it), with a red number on any that have something waiting, and a link to the how-to guides.
- **First-time checklist.** A new person sees "A few things to set up": add a photo, turn on alerts, set up Face ID or fingerprint, and put the site on the phone's home screen, each ticked as it is done, plus a link to the "find your way around" guide. Managers also get links to the main managers' guides. It goes away once the first three are done, or for good with **Done, hide this**. While it shows, the separate photo and Face ID reminders stay hidden so there is one card, not three.

## Social (`/social`)

The company's own feed, in the bar beside Tasks. Everyone in every office sees every post.

- **Posting**: the top of the page shows your picture beside "What's on your mind?". Tapping it opens a larger box to write in, with an **Add photos** button. A post is a few words, up to six photos, or both. Photos are shrunk on the phone first and lose their hidden details, like every photo on the site. Videos are not taken yet (the disk is small); they can be added once it is larger.
- **Reactions**: the same five as elsewhere (like, love, funny, congratulations, thanks). Giving one again takes it back.
- **Comments**: the newest three show under a post; **See all** opens the post by itself with every comment. With alerts on, the person who posted gets a notification when someone else comments (it can be switched off under Notification settings).
- **Removing**: people remove their own posts and comments, and comments under their own posts. Moderators remove their own office's people's, as in Discussions; what they remove is written in the activity log. A removed post takes its photos, reactions and comments with it.
- Posting and commenting need **Read and post in Discussions**; everyone signed in can read and react.
- **Edit and delete** sit behind the three dots at the top right of a post. The dots show only to the person who posted it and to moderators. **Edit** (the poster only) changes the words and can take photos off; the post is then marked "Edited". **Delete** takes the whole post down; a moderator can delete someone else's post, which is noted in the activity log, but can never reword it.
- **Comments** have the same three dots: the person who wrote a comment can **Edit** or **Delete** it (an edited comment is marked "Edited"); the owner of the post and moderators can delete it but not reword it.
- **Who reacted.** On a phone, holding a finger on a reaction shows who gave it, most recent first, without giving it yourself. On a computer, resting the mouse on it shows the names.
- **Laid out by day.** Posts sit under **Today**, **Yesterday** or the date, newest first, each with its time. The last page ends with "That's the end of the feed. Say something!" (or "The feed is empty.") and a link that opens the box.
- **The photo wall is now part of this.** Its pictures became posts when Social was switched on (pictures put up together became one post) and kept their likes; `/photos` goes to Social.

## Discussions (`/discussions`)

- Three sections to start: **Tech support**, **General** and **Introductions**. Anyone with **Read and post in Discussions** can start a thread, reply, add up to four photos to a post, and search.
- **Following**: starting or replying to a thread follows it; anyone can follow or stop from the thread page. When someone else replies to a thread you follow, the Discussions link in the menu shows a count and the reply is listed at the top of your home page until you open the thread. With alerts switched on, the reply also comes as a phone notification.
- In Tech support the person who asked (or a moderator) can mark a thread **Solved**.
- People can remove their own replies, and their own thread while nobody has answered it. **Remove other people's posts and threads; lock, pin and move threads** is the moderator permission; what moderators remove is recorded in the activity log.
- **Moderating stays inside the office.** Someone who sees every office (a corporate admin) can moderate anything. Everyone else with the permission can only act on what their own office's people wrote (or, for a "sees only their own people" profile, their own team): a thread is theirs to lock, pin, move, rename or remove when one of their people started it, and a reply when one of their people wrote it. The same rule covers shout-outs, photos and comments under announcements; whoever posted an announcement can also clear the comments under it.
- After an update, posting is given once to every profile that can send parts forms, and moderating to profiles that manage people.
- Photos live in `/data/uploads` with the others.

## Newsletters (`/newsletters`, `/admin/newsletters`)

- Anyone with **Upload and remove the monthly newsletters** uploads a PDF (up to 25 MB) under **Team > Newsletters**, choosing its month. A title and up to four highlight lines are optional.
- Each page (up to 12) is turned into a picture so it reads well on a phone; **Open the PDF** gives the original. This uses `pdftoppm` from poppler-utils, which the `Dockerfile` installs. Without it, people open the PDF itself. The tool is started without any of the site's settings, so it cannot see the database key.
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
- **Following up**: the Manage tasks page shows open, overdue and done tasks, who each is for, and any note left when it was done. You can edit, reassign, mark done on someone's behalf, reopen or remove a task. The page holds 1000 tasks, open ones first; when there are more it says so, and choosing a person shows all of that person's.
- The person is emailed when a task is assigned if they have an email address and email is set up.

## Push alerts (`/settings/notifications`)

Alerts that pop up on a phone or computer even when the site is closed. Reached from **Notification settings** at the bottom of the bell, or at the bottom of Alerts or More on a phone.

- **The site offers alerts by itself.** Someone signed in on a device where alerts have not been asked about yet sees a **Turn on alerts** bar at the bottom of the page. Tapping **Turn on** is what makes the phone or browser ask "Allow notifications?" (a phone only lets a site ask after a tap). **Not now** hides the bar for two weeks. It does not show on complaint pages, or while the "Get the app" bar is showing.
- **Each person can also turn alerts on or off per device** under Notification settings, with "Turn on alerts on this device"; the phone or browser asks them to allow notifications. The page lists their devices and can send a test alert.
- **A device gets alerts only while it is signed in.** Signing out stops them on that device at once. So does anything that signs the person out: a disabled account, an admin resetting the password, being stood down as a corporate admin, "sign out everyone", or 30 days without opening the site. (A device that had alerts on before this rule came in is quiet until its owner next opens the site on it.) When the same person signs in on that device again, their alerts carry on by themselves, with nothing to press. Someone else who signs in on that device does not get them, and does not get the previous person's either, unless they turn alerts on for themselves there.
- **iPhone and iPad**: alerts only work once the site has been added to the Home Screen (Safari > Share > Add to Home Screen) and opened from there. Android and computers work from the browser.
- **What sends an alert**

  | Alert | Goes to |
  |---|---|
  | A task is assigned | The person it is for |
  | A critical announcement is posted | Everyone it is addressed to |
  | A parts or training request is updated | The person who asked |
  | A reply in a discussion | Everyone following that thread |
  | A task is marked done | Whoever assigned it |
  | A nightly backup does not work | People who can open Backups (once a day) |
  | Someone requests parts | People who manage parts (and can see that person) |
  | A truck problem is reported | People who can see inspections (and that person) |
  | A part drops to its minimum | People who manage stock |

- **Each person chooses** which of these they want, with tick-boxes on the same page. They only see the kinds that apply to their profile. Everything is on to begin with. The bell on the site shows everything regardless.
- An alert carries a short title and one line of text, and tapping it opens the right page. Anonymous complaints never send alerts.
- Nothing needs configuring: the site makes its own signing keys on first use and keeps them in the database. The server must be able to reach the internet to send (Render can).

## Looking at photos

Tapping a photo (in a discussion, a truck inspection or a parts return) opens it in a viewer on top of the page, with a **Close** button and arrows when there is more than one. The phone's Back button closes the viewer and leaves you on the page you were on, so the installed app is never left on a bare image with no way back.

## What happens to a photo when it is uploaded

- **Saved small.** Before a photo leaves the phone or computer it is redrawn no larger than the form needs (1600 pixels on the long side for Social) and saved as WebP, which makes the same picture roughly a quarter to a third smaller than JPEG. A browser that cannot write WebP (Safari on an iPhone) sends a JPEG instead. Either way the picture that is stored is a fraction of what the camera took, so the disk goes much further.

- **It is redrawn on the phone first.** Every photo box (parts, truck inspections, discussions, the photo wall, office pages, profiles) redraws the picture before sending it, the right way up. That makes it small enough to send on a weak signal, and leaves behind what a phone hides inside a photo: where and when it was taken, and on which phone.
- **The site takes those hidden details out as well.** When a JPEG photo arrives the site removes them itself (the position, the time, the phone, comments, the editing history, and anything attached after the picture), so nothing depends on the phone having done it. The picture is not changed or compressed again, and it stays the right way up. If a file is not laid out the way a JPEG should be, it is stored exactly as it came. PNG, WebP and GIF pictures are stored as they arrive. Photos that were on the site before this was added are not changed.
- **A form that is refused keeps nothing.** If a form with photos or a file is not accepted (it expired, something in it was wrong, the connection dropped part-way), what came with it is deleted straight away.
- **When the disk is nearly full**, new photos and files are refused with one sentence asking the person to tell their admin. Signing in, and forms sent without a photo, keep working. "Nearly full" means less than about 5% of the disk free (about 50 MB on the 1 GB disk). The cure is a larger disk: in Render, open the service, then **Disks**. A disk can be made larger at any time, but never smaller.

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

- A copy of the database is made every night (after `BACKUP_HOUR`, default 2 am) and the newest 14 are kept in `/data/backups`. **Back up now** makes one on the spot. Those are kept apart from the nightly ones (the newest 5), so pressing the button cannot push a night out.
- **A copy only counts once it has been checked.** It is written under a working name, opened with the key in use, checked by SQLite and compared table by table with the database, and only then given its name. A night that fails leaves nothing behind and is tried again every half hour. Unfinished copies and empty files are cleared away when the site starts. Old copies are only removed to make room for good ones: a file that does not open never pushes out one that does.
- **When a night fails**, the people who can open Backups see "backup did not work" on their bell and get a push alert if they have alerts on (once a day; it can be switched off under Notification settings). The Backups page and the Security check say why.
- **Corporate > Security check** opens the newest backup with the key in use and checks it, instead of trusting that a file with the right date exists. It also shows how much room is left on the disk, and asks for attention when less than 15% is free or less than three times the size of the database: a backup needs as much free room as the database itself, so backups are the first thing to stop when the disk fills.
- **Backups leave out sign-in sessions.** Bringing one back signs everyone out.
- **These copies are on the same disk as the site.** They protect against mistakes, not against losing the disk. To get copies off the server, either set `BACKUP_EMAIL_TO` (needs the email settings below) so each night's copy is emailed, or download one from the Backups page now and then.
- The Backups page also has **Download all photos**. Taking it is written to the activity log, like downloading a backup.
- A backup contains everything except sign-in sessions, including anonymous complaints, so it has its own permission, and `BACKUP_EMAIL_TO` should only name someone trusted with that. With `DB_KEY` set, backups are encrypted like the database itself.
- **Going back to the previous version of the site** (Render's Rollback): if the data should go back as well, first bring back the copy marked "Made before an update" with `RESTORE_BACKUP` while the new version is still running, and only then roll back. An older version does not know `RESTORE_BACKUP`, does not list the "before an update" copies, and keeps 14 copies in all, so download any copy you want to keep first. Its complaint email will not mention complaints sent since the last notice: open Corporate > Complaints that day.
- **Before an update.** The first time a new version of the site starts, it keeps a checked copy of the database as the last version left it, before changing anything. The Backups page marks these "Made before an update" and the newest two are kept. (It goes by the version Render reports; on a host that reports none, no such copy is made.)

## Bringing a backup back (restore)

Use this when the database is damaged, or when something was changed or deleted that has to be undone. It puts one backup in place of the whole database.

What it does, and does not do:

- **Work entered since that backup was made will not be in the site afterwards.** It is not merged in. The database from before is set aside on the disk, not deleted.
- **Photos and documents are not part of a backup.** They stay as they are now. Ones added since the backup are still on the disk, but nothing in the restored site points to them; ones deleted since do not come back.
- **The key must match.** An encrypted backup opens only with the key it was made under. For a backup on the server that is the key in `DB_KEY` today. For a copy that left the server before a key change, put that earlier key in `DB_KEY_OLD` as well.
- Everyone is signed out and signs in again.

Steps:

1. Open **Corporate > Backups** and note the exact name of the backup to go back to, for example `portal-2026-11-18.db`. If the site is closed, its closed page names the newest backup that opens.
2. In Render, open the service, then Environment. Add a variable named `RESTORE_BACKUP` with that name as its value, and save. The site restarts.
3. On that start the site checks that the name is one of its own backups, that it opens with the key and that it passes SQLite's check. It then sets the current database aside as `/data/portal-before-restore-<date and time>.db`, together with the files that go with it, and copies the backup into place. If anything is wrong it changes nothing and shows a closed page that says why.
4. Sign in and look round. **Corporate > Security check** now says which backup was restored and that `RESTORE_BACKUP` can be removed. Delete it in Render. While it stays it is ignored: the same backup is not restored a second time.

Also worth knowing:

- **A backup kept off the server** (a download, an emailed copy with the `.gz` taken off) has to be put in `/data/backups` under its original name first, through the Render Shell.
- **The database that was set aside** stays in `/data` until someone removes it, and is as big as the database. Once the restore is known to be right it can be deleted through the Render Shell. Going back to it is a job for whoever maintains the site: it has to be put back together with the files beside it.
- **A lost or damaged disk.** The service's Disk page in Render lists Render's own daily snapshots of the whole disk. If they are there, putting one back restores the database, the backups and the photos together, so try that first. On a brand-new empty disk: let the site start once, put the backup in `/data/backups` and the photos in `/data/uploads`, then follow the steps above.
- **If the database file is damaged or missing** while backups are on the disk, the site does not quietly start as an empty site. It shows its closed page, which says what is wrong, names the newest backup that opens and gives step 2 above. To start a new, empty site on purpose where old backups exist, add `NEW_SITE` with the value `yes` for that one start, then delete it (the Security check reminds you).

## Database encryption (`DB_KEY`)

- **With `DB_KEY` set in the hosting settings, the database is kept encrypted** in SQLCipher 4 format (AES-256, with a check on every page). A copy of it, whether the file itself, a downloaded backup or an emailed one, cannot be read without the key. Without `DB_KEY` the database is an ordinary SQLite file.
- **Turning it on.** Corporate > Security check shows whether the database is encrypted and, when it is not, offers a freshly made key to copy. Add it in Render (the service, then Environment) as `DB_KEY`, at least 20 characters. On the next start the site sets a complete copy aside, encrypts the database where it stands, checks that it opens with the key, passes SQLite's own check and holds exactly the rows it held before, and only then removes the copy. If anything fails, or the server stops half-way, the copy is put back and the site runs as before. Existing backups are encrypted on the same start, each as a copy that takes the original's place only once it has been checked, so a start that is cut short cannot damage one. A backup that does not open with the key in use is marked on the Backups page and counted on the Security check.
- **Keep a second copy of the key somewhere that is not Render**: a password manager, or printed and locked away. The key is never written to the disk, the log or the database. **If it is lost, nobody can open the database or its backups again.**
- **Check that the saved copy is right.** Corporate > Security check has a box for it, shown after the password has been typed again: paste the copy you keep, and the site answers yes or no. What is pasted is compared and forgotten; it is never stored, logged or shown, and nor is any part of the real key. Five tries are allowed in 15 minutes. Only the day of the last match is kept, and the page asks for a fresh check when there has never been one or the last was more than six months ago. Changing the key, or bringing a backup back, clears it: the copy has to be checked again against the key now in use.
- **A missing or wrong key does not harm anything.** The site refuses to open the database and shows a plain "closed for the moment" page that says to put `DB_KEY` right. Putting the right value back brings everything back. If the key in the settings opens the newest backup but not the database, the page says the file is damaged instead, and points to the restore steps above.
- **Changing the key.** Put the new key in `DB_KEY` and the current one in `DB_KEY_OLD`, and save. The next start moves the database and every backup to the new key in the same careful way. Photos and documents follow in the background and need the old key until the last one has moved, so **leave `DB_KEY_OLD` in place until the Security check says it can be deleted**. Then **keep the old key on record**, with the dates it was in use, for as long as you keep any backup or photo archive downloaded in that time: those open only with it. The Backups page shows the day of the last key change as a reminder.
- **Turning it off again.** Leave `DB_KEY` in place, add `DB_DECRYPT` with the value `yes`, and save. The next start decrypts the database and its backups, again with a copy set aside until the result is checked. Photos and documents are opened a few at a time after that, and cannot be opened without the key: **leave both settings in place until the Security check says no photos or documents are still encrypted**, then delete both, and keep the key on record as above. **Do this before going back to a release from before encryption was added**: that older code cannot open an encrypted database and will not start.
- **Opening a backup elsewhere.** `DB_KEY=<the key> npm run decrypt-backup -- <backup file>` writes an unencrypted copy. Any SQLCipher 4 tool (DB Browser for SQLite, the `sqlcipher` command) also opens a backup directly with the same key.
- **Photos and documents.** With the key set, the files in `/data/uploads` are encrypted too: AES-256-GCM, each file with its own random nonce and bound to its own name, under a key worked out from `DB_KEY` (nothing extra to keep safe). A new file is sealed as soon as its form has been accepted, however long it took to arrive; files that were already there when the key was set are sealed a few at a time in the background. A file is opened only as it is sent to someone allowed to see it. The **Download all photos** archive therefore holds encrypted files; `DB_KEY=<the key> npm run decrypt-photos -- <folder>` opens an unpacked copy somewhere else. After a key change the files move to the new key in the background, so **leave `DB_KEY_OLD` in place until the Security check says it can go**; a file sealed under a key that is no longer in the settings is not lost, it opens again when that key is put back.
- **What is not covered.** Someone who can reach the hosting account can read the key, so that account needs its own strong sign-in. Encryption does not change what a signed-in person can see through the site.

## Email notifications

Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM` to an account the site may send from, then:

- `NOTIFY_TO`: who is emailed about each new **parts request**, **training request** and **low stock** crossing. Take and return entries do not send email. A training request marked private sends only "a private request was submitted", without the text or the name.
- **The complaint notice** is sent **once a day** (at `COMPLAINT_DIGEST_HOUR`, default 7 in the morning) and says only how many new complaints there are. It is not sent the moment a complaint arrives, because the arrival time could point to who wrote it. For the same reason it counts whole days: a complaint is in the notice of the morning after it was written.
  - Every office is counted. An office's notice goes to the people in that office whose profile lets them read complaints and who have an email address on their account, and to people who read complaints for every office. Each person gets one email with their own total.
  - `COMPLAINT_NOTIFY_TO`: an extra mailbox for the first office's notice.

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
- **Temporary passwords last 14 days** (`TEMP_PASSWORD_DAYS`). After that the password is refused even when typed correctly, any sign-in started with it ends, and the Users list shows **Temporary password expired**. **Send sign-in details** or **Reset password** gives the person a new one and a new 14 days. A password someone chose themselves never expires, and the master account is left out so it cannot be shut out.
- **Edit**: name, username, email and profile.
- **Managers**: when a person's profile is a "sees only their own people" profile, their Edit page lists everyone with tick-boxes. Tick the people they manage. The Users list shows who manages whom.
- **Reset password**: a new temporary password, shown once. People can also use "Forgot your password?" if email is set up.
- **Disable**: signed out at once and cannot sign in; alerts to their phone or computer stop; their past submissions stay.
- **Remove for good**: their sign-in, contact details, profile photo (the file too) and sign-in history are erased, and they leave every list. What they recorded for the office (parts, inspections, posts, tasks they gave) stays with their name on it. Someone who recorded nothing is deleted outright; having signed in does not count as a record. Backups made before the removal still hold the person: the nightly copies on the server for up to 14 nights, the newest five "Back up now" copies and the two copies made before updates until newer ones replace them, and any copy that was emailed or downloaded for as long as it is kept.

### Looking at the site as another profile

The master account and anyone who sees every office have **View the site as** in their account menu (under their name; in More on a phone). Choosing a profile shows the site exactly as that profile sees it: its menu, its pages, its forms. A bar across the top says so, with **Back to my own view** on every page.

- It only ever takes things away. Someone who is not the master is offered only profiles that can do no more than their own.
- Nothing about the account changes, and it lasts until they go back or sign out. What they do while looking is still done by them and recorded under their name.
- A "sees only their own people" profile shows only the people assigned to the person looking, which for most admins is nobody but themselves.
- Each time is written in the activity log.

### The master account

One account is the master. It always has every permission whatever the profiles say, and nobody else can edit it, reset its password, disable it or change what it can do. It is the first admin account ever created. If the Master badge is on the wrong person, set `MASTER_USERNAME` in the host's environment settings and restart.

### Limits that stop access creeping upward

- Nobody can give out more than they have: you can only assign profiles, and tick boxes, that are within your own permissions. Boxes you do not hold are shown locked.
- You cannot edit, reset or disable someone whose profile allows more than yours. The contact list upload and **Announce as a new hire** follow the same rule: they leave those accounts, and the master account, as they are.
- You cannot change your own profile or disable yourself.
- A manager given the "manage people" box can edit, reset and disable their own people only; they cannot add accounts or change anyone's profile.

## How anonymous the complaints are

What the site does:

- The complaint is stored with a category, the text, an optional "when/where", and the **date**. It is not stored with a user, an IP address, a device or a time of day. The table has no column for any of those.
- Complaint ids are random and the table is not kept in arrival order, so a complaint cannot be lined up against the parts log or sign-in times.
- Complaint pages are left out of the server's request log. So is what every open page does by itself (checking for news in the background, locking, showing the lock screen), so a request that is missing from the log says nothing about what it was.
- Opening the form, sending a complaint or checking on one leaves the person's sign-in record exactly as it was: the request for the page writes no "last seen" time, no new expiry and no page name. (Like any open page, it checks for news in the background every half minute, which keeps the sign-in from running out; that looks the same from every page.) Someone who follows a link to the form while signed out, or while the site is locked, lands on the home page after signing in or unlocking, like anyone else, and their own browser takes them on to the form; the site keeps no note of where they were heading.
- The once-a-day notice counts by date and marks nothing on the complaint, so nothing stored shows whether a complaint arrived before or after that day's notice.
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
- The list shows 500 people at a time in name order. When there are more, the line above it says so ("Showing 1 to 500 of 3005 people") and **Next** and **Previous** go through the rest. A search or an office filter with many answers works the same way.
- Each person fills in their own profile under **My profile** (`/profile`): photo, job title, start date, about me, and "what I know about" (skills, separated by commas). All optional. The photo is shrunk on the phone before it is sent.
- A profile also lists the person's certifications on file, by name only (no dates).
- Phone and email show on a profile only if the person ticks the box for each.
- The home page reminds people with an empty profile to fill it in.

**Contact list (Setup > Import)**
- Upload the office contact list as a CSV (in Excel: File > Save As > CSV) with a Name column and, optionally, Title, Email and Phone. A row with only a name in it (MANAGEMENT, SERVICE...) is a department heading for the rows under it.
- People who already have an account are matched by email, by the "first.last" in the email, or by name, and keep the name they have on the site. Their job title, department, work email and phone are set from the list.
- The phone and email are shown on the profile of anyone who has not signed in yet. For someone who already uses the site, whether they are shown stays as that person has it under My profile; an upload never switches it back on.
- An upload only changes accounts the person uploading could change on Edit person. The master account (unless the master uploads the list) and anyone whose profile allows more than the uploader's are left exactly as they are, and are named on the result page.
- The activity log names each existing account whose email or phone the upload changed.
- Everyone else is added with sign-in switched off: they are on the People page, but cannot sign in until an admin presses Enable and Reset password under Users.
- Names and titles typed in capitals are tidied ("JANE MCDONALD" becomes "Jane McDonald"). Uploading a newer list updates titles, departments and phones; nobody is removed. Disabling an account by hand takes that person off the People page.
- The People page can be filtered by department.

**New hires**
- **Sales (only for profiles with the sales permission):** a lead board per office with stages (New, Contacted, Quote sent, Won, Lost), one owner per lead, follow-up dates that count on the owner's bell, notes, hand-over to a colleague and passing a lead to another office. Adding a lead checks for the same customer and says who already has it. Inside the person's own office, part of the name or the same address is enough. A customer of another office is found only by the whole name, the whole phone number or the whole email address, and the answer is only that office and who is working it, never the customer's name or details. While typing, each person can look up 60 different customers in 15 minutes (carrying on typing the same customer does not count again); past that the lookups stop being answered until the 15 minutes are up, the activity log notes it once, and the check made when the lead is saved still runs. The `Sales` and `Sales manager` profiles are created once. The **Admin** and **Corporate admin** profiles hold the sales permissions too, so an office's admin sees and can export that office's leads, and a corporate admin every office's; untick them on the Profiles page if that is not wanted. No other profile has them unless someone ticks them. Sales managers can edit anyone's leads, export and remove them. Removing a lead is written to the activity log by its number and office, not the customer's name.
- **Sales tools:** *My day* (follow-ups due, quotes unanswered for 7 days, repeat work due within 45 days, leads quiet for 14 days, unowned leads); quote amount and date on a lead; a date won work comes round again, with one press to start the repeat lead; a lead quiet for 30 days can be taken by a colleague; the person who passed a lead from another office is named and told when it is won; *Team summary* for sales managers (per person, win rate, quote-to-decision time, sources, loss reasons); and a shared *Library* of files and links that sales managers add.
- **Community first on the home page:** a strip under the greeting shows the company in numbers (offices, people, shout-outs this month, new discussions) and a "Meet an office this week" spotlight that changes weekly. **Activity feed** is one list, newest first, of people joining, photos, new discussions and events from every office, each tagged with the office it came from (other offices stand out). On a phone it sits straight after Shout-outs and On call.
- **Comments on announcements:** anyone an announcement is for can ask a question or comment under it on the Announcements page; the poster is alerted. People remove their own comments; anyone who posts announcements can remove any.
- **On call:** an On call page for everyone shows who is on call now (with Call buttons) and the schedule ahead, for the person's office and any other office in the same market. Several people can be on call and several can be backups for the same days. People with the `oncall.manage` permission (given once to profiles that can assign tasks) load the year from the office's on-call spreadsheet saved as CSV, add people to a shift, swap one person for another and remove them. The hand-over day belongs to the next person. Who is on call now also shows on the home page.
- **Picking who is on call:** in **Add someone to the schedule** (and when swapping someone), the Name box is a search of the people in that office: start typing and pick a name, and the phone number on their account fills in beside it. A name that is not on the list (a contractor, say) can still be typed in by hand with a number.
- **On-call rates:** the On call page has an **On-call rates** list for the office: a line each, saying what the rate is for (Weeknight, Weekend day, Holiday) and the rate, typed as the office says it ("$50", "$25 an hour"). People with **Keep the on-call schedule** add, change and remove lines for the office they are looking at; each change is written in the activity log. Every office has its own list, and its people see only their own. Until a rate is added, only the people who can add one see the section.
- **Vehicle inspection as a task:** in Manage tasks, choose "A vehicle inspection" as the kind of task. The person gets a **Do the vehicle inspection** button; the task cannot be ticked off by hand and finishes only when the inspection is sent with six required photos (front, rear, driver side, passenger side, front interior, rear interior). The finished task links to the inspection. It can only be given to people whose profile lets them send inspections.
- **Task status and notes:** the person doing a task sets where it stands (Not started, In progress, Waiting) and can leave notes without closing it; choosing Finished closes it. The manager sees the status and latest note in Manage tasks, the full thread on the task's Edit page, and can add a note back. Updates send an alert to whoever assigned the task.
- **Team > Positions** lists everyone in the office with their job title and department in one table; change as many as needed and save once. Someone looking at all offices at once gets the first 1000 people and a line saying so; choosing one office shows everyone in it. A department box suggests the departments already in use. People who manage users also get an **Edit job title and department** button on a person's page and an **Edit positions** button on People. Each change is written to the activity log.
- On **Edit person** (Team > Users), **Announce as a new hire** takes a job title, start date and a few words. The person then appears under **Welcome aboard** (in the Activity feed) on everyone's home page for 14 days.
- Everyone can press **Say welcome**, and add a short message from the person's profile. The messages stay on the profile afterwards.

**Daily question (`/daily`)**
- One light question a day on weekdays (the weekend keeps Friday's), the same for everyone, on the home page. Results, with who picked what, show once you have answered. You can change your answer during the day.
- The site starts with 120 built-in questions. Anyone can suggest one; it waits for approval.
- People whose profile has **Run the daily question** approve or decline suggestions, add their own, and can set a question for a particular day. Approved suggestions and added questions come up before the built-in list.

**Shout-outs (`/shoutouts`)**
- Anyone can thank a coworker by name with a short note. The latest show on the home page and all of a person's shout-outs stay on their profile. Others can applaud. The person gets a push alert if they have alerts on.
- **Who is it for?** lists the people in your own office first. While no more than 500 people are on the site, everyone else follows under "Other offices". Past that, the list is your own office only: for someone elsewhere, open their page from People and press **Give a shout-out** there.
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

An office page also shows its market, its product lines, its address (a link to a map) and its phone. The finder's search box looks in all of these and in the name an office goes by (which is not printed), so "Naples" finds Bonita Springs and "Genetec" finds the offices that carry it.

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
- **Email**: the `NOTIFY_TO` and `COMPLAINT_NOTIFY_TO` mailboxes are the first office's. Other offices rely on the site's own alerts (the bell and push alerts) for new requests, truck problems and low stock. The daily complaint notice is different: every office's reviewers get it, at the email address on their own account.


## The lock, and Face ID / fingerprint sign-in

- **A page left open does not stay readable.** Once the site has locked, a page that is still on the screen goes to the lock screen by itself (within seconds of the time running out, and even with no connection), instead of waiting for the next tap.
- **Signing out leaves nothing behind on the device:** half-written forms saved on it are removed, and the browser is told to drop the photos and files it kept from the site.
- **The site locks itself** when it is closed and reopened, and when it is left unused: after 10 minutes on a phone or tablet (`LOCK_AFTER_MINUTES_PHONE`) and 20 minutes on a computer (`LOCK_AFTER_MINUTES_DESKTOP`); 0 switches that timer off, closing still locks. Only what a person does counts as using it: a key, a tap or click, the mouse wheel, a finger on the screen. A page that moves by itself (the banner on the home page) or checks for news in the background does not keep the site open. A device counts as a phone or tablet when its browser says so or when it has a touch screen and no mouse (which is how an iPad is recognized); anything that is not plainly a desk computer gets the shorter time. Corporate > Security check shows both times and which kind the device in front of you counts as. A locked site shows only a lock screen with the person's name: nothing else opens, and forms sent while locked are not accepted, until they confirm who they are.
- **To get back in**: Face ID, a fingerprint, Windows Hello or the device's screen-lock code if that is set up on the device, or the password. On a device where it is set up the phone asks for the face or fingerprint straight away.
- **Setting it up**: each person does it once per phone or computer under **Password and Face ID** (More on a phone, their name at the top on a computer), with **Set up on this device**. The home page offers it until they have. Devices are listed there and can be removed.
- **Signing in from scratch** (after Sign out, or on the sign-in page) also works with **Sign in with Face ID or fingerprint**, with no username or password typed.
- The face or fingerprint never leaves the device and the site never sees it. The device holds a key made for this site alone (a "passkey") and the site stores only the matching public key. It works only on the site's real address, so a look-alike site cannot use it.
- **Lost phone**: an admin presses **Reset password** for that person. That signs them out everywhere, stops alerts going to their devices, and removes all their Face ID / fingerprint devices; they set it up again after signing in with the temporary password.
- People stay remembered on a device for 30 days, so the lock screen knows who they are; **Sign out** on the lock screen is for a shared device.
- Short trips out of the site (taking a photo for a form, checking a text) do not lock it unless they last longer than the limit. Unsent parts, training and inspection forms keep their draft.
- Changing the site's address (for example to a custom domain) means everyone sets up Face ID again; passwords are not affected.

## Security notes

- **Signing in**: passwords are stored only as bcrypt hashes. Wrong guesses are limited two ways: 10 per connection per 15 minutes, and 10 per username per 15 minutes wherever they come from. Resetting the password by email lifts the wait.
- **Signed out everywhere**: changing a password signs that person out on every other device; an admin resetting a password or disabling an account signs them out on all of them. Push alerts stop on every device that was signed out.
- **Sessions** last 30 days on a device, in a cookie the page's scripts cannot read, sent only over HTTPS in production.
- **Visitors who are not signed in** leave nothing in the database, except on the pages that have a form for them (sign-in, forgot password, a working reset link), and that record is dropped after two hours. A sign-in page that has sat open longer than that still works: it collects what it needs again when the form is sent.
- **A flood from one address**: visitors who are not signed in get 600 requests per address in five minutes (sixty times the sign-in limit, `LOGIN_RATE_LIMIT`), which is enough for a whole office to sign in several times over; after that they are asked to wait. People who are signed in are never counted, and neither is the hosting company's health check.
- **The reset email** can only be set or changed by someone who has already replaced their temporary password with their own.
- **Every form** carries a one-time-per-session token, so another website cannot submit forms as a signed-in person.
- **Every page** except sign-in and password reset needs a sign-in; every management page and action checks the profile's permission, and a manager's reach stops at their own people.
- **Uploads** are stored outside the public folder under random names, checked to really be images (or a PDF for newsletters), and only served to people allowed to see the entry they belong to.
- **Push alerts** are only ever sent to Google's, Apple's, Mozilla's or Microsoft's alert services, and only for a device that is still signed in.
- **Password-reset links** work once, expire in an hour, are stored hashed, and are left out of the server log.
- **The lock**: see above. A phone left on a desk or a browser left open does not leave the site open.
- Not included: a required second step on top of the password. Face ID / fingerprint is offered, not forced, so the site is still as strong as people's passwords.
