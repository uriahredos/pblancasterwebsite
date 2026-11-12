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
| `/admin/parts`, `/admin/training`, `/admin/users` | Admins only |
| `/admin/complaints` | Complaint reviewers only |

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

**Back up `/data/portal.db` and `/data/uploads`.** That is all the data there is.

## Email notifications

Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM` to an account the site may send from, then:

- `NOTIFY_TO`: who is emailed about each new **parts request** and **training request**. Take and return entries do not send email. A training request marked private sends only "a private request was submitted", without the text or the name.
- `COMPLAINT_NOTIFY_TO`: who gets the complaint notice. This is sent **once a day** (at `COMPLAINT_DIGEST_HOUR`, default 5 pm) and says only how many new complaints there are. It is not sent the moment a complaint arrives, because the arrival time could point to who wrote it.

With no SMTP settings the site works normally and skips email.

## Managing people (`/admin/users`)

- **Add a person**: enter a username and name. The site generates a temporary password and shows it once. Pass it on; the person chooses their own password at first sign-in.
- **Reset password**: generates a new temporary password, shown once. There is no "forgot password" email; people ask an admin.
- **Disable**: the person is signed out at once and cannot sign in. Their past submissions stay.
- **Make admin**: can see every parts and training submission, change status, export, and manage users.
- **Allow complaints**: can read and answer complaints. This is separate from admin. An admin without it cannot open complaints.

Note that any admin can switch "Allow complaints" on for any account, including their own. Keep the number of admins small.

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
app/routes/          one file per area: auth, home, parts, training, complaints, admin
app/views/           the pages
public/              stylesheet and the parts-form script
scripts/create-admin.js
test/portal.test.js  automated tests
```

Not in this prototype: Microsoft/Outlook sign-in, a parts catalog or stock counts, importing the old Microsoft Forms history.
