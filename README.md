# SAO Portal — club sponsors and room booking

Website for the GUC Student Activities Office that records each club's sponsor outreach, stops two clubs
from claiming the same sponsor, and gives SAO Heads full oversight. Built from
*Sponsor Management System Requirements v1.0 (5 Nov 2026)* and the SAO Brand Kit.

## Run it on your computer

Needs **Node.js 22.13 or newer** (it uses Node's built-in SQLite). No `npm install` needed.

```
node server.js
```

Open http://localhost:5174. The first time, create the **SAO Head** account (the clubs and their logos are added for you). Tick "Fill with demo data" to try it:
every club gets a demo rep (`<club>@demo.local`, password `Demo1234`, listed on the sign-in page) and a few sponsors.

Data lives in `data/sponsors.db`. To start again from zero, stop the server and delete `data/`.

Run the acceptance tests (section 11 of the requirements, and more):

```
npm test
```

## The rules

| Rule | How it works |
|---|---|
| One club per sponsor | The database itself allows only one active claim per sponsor, and every change runs one at a time, so two clubs pressing "Reserve" at the same moment can't both win. |
| 20 sponsors per club | A club can hold at most 20 active sponsors at once (Pending SAO Review counts). SAO can change the number in Admin > Rules, and can still assign to a full club. |
| 14-day reservation | Ends at the same Cairo clock time 14 calendar days later. Logging the first-contact date stops the clock. Reminders 3 days and 1 day before. |
| Automatic expiry | Checked on every request and every hour (GitHub Actions). History is never deleted. |
| Privacy | Other clubs only see "This sponsor is currently unavailable." Nothing in any club page, search or error names the owning club. |
| Exact match | Same name ignoring case, spaces, punctuation and accents; a registered other name; or the same Instagram account → blocked. If either the name or the Instagram account belongs to a sponsor a club holds, it is "unavailable". |
| Instagram link | Required when a club adds a new sponsor: the profile link (https://www.instagram.com/name), not just the @name, a post or a story. Any form of the same account counts as the same sponsor. |
| Possible match | A typo, an added "Egypt"/"Group", or one name inside another → held as *Pending SAO Review*. It blocks other clubs while SAO decides. |
| Access | Club reps only ever receive their own club's records; SAO pages and data are refused on the server for anyone else. |

Statuses: Reserved → Contacted → In Negotiation → Confirmed, or Rejected (sponsor declined) / Released (club let go) / Expired.

## Who can do what

**Club Representative** — **Home** shows what needs attention (sponsors about to be released, SAO reviews, the 20 limit, SAO replies), the club's upcoming room bookings and its sponsor numbers. A **+ New** button (the big + in the phone's bottom bar) adds a sponsor, books a room or asks SAO. My sponsors (own list, filters, deadlines), Add sponsor (live suggestions showing
Available / Unavailable, category, required Instagram profile link), update status and first-contact date, notes,
history, and *Ask SAO to review* for an unavailable sponsor. In-site notifications.
**Delete** (bin icon on the list, or on the sponsor's page) erases the club's sponsor completely — its notes, history
and log entries, for everyone including SAO — and frees the sponsor for other clubs. A club can only delete its own.

**SAO Head** — Dashboard (rooms in use today and this week, all clubs with their logos, counts by status, ending soon, stalled, recent activity), All claims with
filters and CSV export, Reviews (possible duplicates and club requests), Sponsor registry (rename, other names, Instagram,
merge, assign/reassign to a club), Admin (people, clubs, categories, the stalled-claim rule, full audit log).
Release, reassign and extend always need a reason, which is logged.
SAO can **delete anything** for good: any claim, a sponsor (with all claims on it), an account, a club (with its claims and
rep accounts — turn a club off instead to keep its history), a category (its sponsors move to "Other") and review items.
Each delete asks for confirmation and leaves one line in the audit log.

On phones the menu is a tab bar at the bottom, and lists show as cards.

Accounts:
- SAO adds a person in **Admin > People** with just their email (and club). They open the site, tap
  **First time signing in?**, enter that email and choose their own password. (SAO can still give a starting password instead.)
- If the email isn't added, the same screen asks for their name, club and an optional message, and sends an
  **access request** to SAO (a notification, a count on Admin, and a card at the top of Admin > People). SAO approves
  (the account is created; they then choose their password the same way) or declines with an optional reason they will see.
- Forgotten password: SAO edits the account and ticks "let them choose a new one"; the person goes through
  First time signing in? again. All their sessions are signed out.
- Note: until a person chooses their password, anyone who knows their email could do it first. Tell people to
  sign in soon after SAO adds them; the account shows "Not set up yet" in Admin > People until they do.
- 8 wrong passwords lock that email for 15 minutes.

## Rooms (club room booking)

Built from *Club Room Booking Platform — Requirements (6 Nov 2026)*; it replaces the "After Hours and booths" sheet.

| Rule | How it works |
|---|---|
| Slots | **After hours** (whole block, at most **2** rooms per club per day) and **Fifth slot** (custom start/end inside it allowed, at most **5** per club per day). Counted separately, per day. |
| One club per room per slot | Checked when booking and backed by a unique index, so two reps clicking at once can't both win. |
| Days | Term dates and weekdays (Sunday–Wednesday) set in Admin > Rooms. Past days are read-only. |
| Club | Taken from the rep's account, never typed. |
| SAO | Books for any club, can tick **Admin override** past a limit (marked on the calendar and sheet), cancels anything, blocks rooms or whole days (bookings there are cancelled and the club is notified). |

- **Calendar** (`#/rooms`): day view as a box per room (phone default), week view, month view; day buttons for this week and next plus a calendar date picker; free / booked / your club / blocked colours;
  filters by slot, building and club; "only free". Updates by itself every few seconds. **Public:** anyone can open it
  from the link without signing in (club names shown; who booked is only shown to SAO).
- **Weekly repeats:** tick "Repeat every week" and choose until when (up to 20 weeks). Weeks that are taken, blocked or over the limit are skipped and listed; a repeat can be cancelled for one week or for that week and the following ones.
- **Booking:** tap a free room; the dialog shows the club's remaining quota and, if a room is taken or blocked, says by whom/why
  and suggests free rooms. **My club's bookings** lists upcoming bookings with cancel and edit (purpose, fifth-slot times).
- **Admin > Rooms:** term, slot times and limits, rooms (add, edit, archive), blocks, CSV export in the old sheet's layout,
  and the security Google Sheet.
- Slot times: after hours 17:30–20:00 (shown first), fifth slot 15:15–17:30; SAO can change them in Admin > Rooms.
- Notifications are inside the site (email would need an email service).

### Security Google Sheet

Every booking, cancellation and block is copied to a Google Sheet within seconds (and the sheet refreshes itself every
5 minutes). It has two easy-to-read tabs, each with a black title band, a yellow date band and a colour key:
**Today** (or the next booking day): only the rooms in use, After hours and Fifth slot side by side;
**This week**: the next 4 booking days, two columns per day. After hours is blue, Fifth slot yellow, blocked rooms grey with the reason.
Setup, once, in Admin > Rooms:

1. Create a new Google Sheet. 2. Extensions › Apps Script: paste the script from **Copy the script** (it has the site's
address and the sheet key filled in) and save. 3. Run **setup** once and allow access. 4. Deploy › New deployment › Web app,
Execute as *Me*, access *Anyone*; copy the Web app URL. 5. Paste it in the site and press **Save and sync**.
Share the sheet with security as *Viewer*. The script template is `assets/sheet/security-sheet.gs.txt`; the whole term is in the CSV export.

## Put it online (free: GitHub Pages + Supabase)

Same setup as the SAO Portal, on its own Supabase project (all tables here start with `sp_`).
The project ref `lojfwwmddjarzgnxzyzi` is in `config.js` and `.github/workflows/*.yml` — change it in those places to use another project.

1. GitHub repository > **Settings > Pages** > Source: **Deploy from a branch**, branch `main`, folder `/ (root)`.
2. **Settings > Secrets and variables > Actions** > New secret `SUPABASE_ACCESS_TOKEN` (from supabase.com/dashboard/account/tokens).
3. In Supabase > **Edge Functions > Secrets**, add `SP_SETUP_CODE` with a code only you know.
4. Push to `main`: GitHub publishes the pages. Deploy the server with Actions > Deploy server (Supabase) > Run workflow, or from a computer (see the comment at the top of `.github/workflows/deploy-supabase.yml`).
5. Open `https://saoofficeguc.github.io/sponsors-approve/`, enter the setup code and create the SAO Head account.
6. Remove the `SP_SETUP_CODE` secret afterwards (setup is refused once any account exists anyway).

## Files

| Path | What |
|---|---|
| `index.html`, `app.js`, `styles.css`, `config.js`, `assets/` | The website |
| `supabase/functions/_shared/core/` | The server: rules, matching, dates, sign-in, database |
| `supabase/functions/sponsors/index.ts` | Runs the server on Supabase (Postgres) |
| `server.js`, `scripts/sqlite-driver.js` | Runs the server on a computer (SQLite) |
| `test/acceptance.mjs` | Acceptance tests |

## Still to decide (section 13 of the requirements)

- Final club names and category list — both editable in Admin, no code change needed. The 23 starting clubs include the 18 from the Student Activities Guide cover with their logos (`assets/clubs/`); SAO can upload or replace any logo in Admin > Clubs.
- The long-term rule for stalled Contacted / In Negotiation claims — for now they are only flagged after 30 days (changeable in Admin > Rules), never released automatically.
- Whether SAO may ever let two clubs share a sponsor — this build allows only reassign or release.
- Whether contact needs evidence — this build takes a dated status update, no upload.
- Phase 2 / later: Instagram API lookup is not included; the form links to an Instagram search instead.
