# SAO Sponsors — Sponsor Management System

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
| Exact match | Same name ignoring case, spaces, punctuation and accents; a registered other name; or the same Instagram account → blocked. |
| Possible match | A typo, an added "Egypt"/"Group", or one name inside another → held as *Pending SAO Review*. It blocks other clubs while SAO decides. |
| Access | Club reps only ever receive their own club's records; SAO pages and data are refused on the server for anyone else. |

Statuses: Reserved → Contacted → In Negotiation → Confirmed, or Rejected (sponsor declined) / Released (club let go) / Expired.

## Who can do what

**Club Representative** — My sponsors (own list, filters, deadlines), Add sponsor (live suggestions showing
Available / Unavailable, category, optional Instagram with link check), update status and first-contact date, notes,
history, and *Ask SAO to review* for an unavailable sponsor. In-site notifications.
**Delete** (bin icon on the list, or on the sponsor's page) erases the club's sponsor completely — its notes, history
and log entries, for everyone including SAO — and frees the sponsor for other clubs. A club can only delete its own.

**SAO Head** — Dashboard (all clubs with their logos, counts by status, ending soon, stalled, recent activity), All claims with
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
