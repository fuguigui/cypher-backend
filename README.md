# Cypher API

Backend for Cypher, implementing the data model and moderation rules from
`01-data-model-spec.md`. Node.js + Express + Prisma + Postgres, JWT-based auth.

## Setup

```bash
npm install
cp .env.example .env      # fill in DATABASE_URL, JWT_SECRET, GEOCODING_API_KEY
npm run prisma:migrate    # creates tables from prisma/schema.prisma
npm run dev                # starts on :4000 (or PORT from .env)
```

For quick local dev without standing up Postgres, switch the datasource in
`prisma/schema.prisma` to `sqlite` and set `DATABASE_URL="file:./dev.db"`.

## Auth

Email/password with bcrypt + JWT (30-day expiry), matching the earlier product
decision (email/password + Google OAuth later — Google sign-in isn't wired up
yet, this ships the baseline). Every new account is `role: "submitter"`;
promoting someone to `role: "admin"` is a manual database update, never
self-service. `middleware/auth.js` is the actual security boundary for admin
routes — the frontend hiding the Admin nav link for non-admins is UX only.

```
POST /auth/register   { name, email, password, city? }
POST /auth/login      { email, password }
GET  /auth/me         (auth)
PATCH /auth/me        { name?, city? }  (auth)
```

## Core resources

| Resource | Notes |
|---|---|
| `GET/POST /studios` | Public list is `approved` only; `?mine=1` (+auth) shows your own pending/rejected too. Studio can have multiple Locations. |
| `GET /studios/popular?city=&limit=` | Ranks approved studios with a location in `city` by Instagram followers — powers the "suggested for new users" group. |
| `POST/GET /locations` | `city` is validated against the fixed enum in `src/lib/cities.js`. Address is geocoded server-side via `src/lib/geocode.js` (plug in a real provider). |
| `GET/POST /classes`, `PATCH /classes/:id` | Filterable by style, studio, teacher, city, level, date range, price range. Price is optional — auto-detected from the booking link via `src/lib/priceDetect.js` if left blank; stays `null` (never a fake `$0`) if detection fails. `PATCH` (owner or admin) always sets `locked: true`, which is what keeps the daily scraper from overwriting a manual correction. |
| `GET /songs/leaderboard` | Ranks songs by how many approved classes use them, filterable by city/date range. |
| `PUT /reviews/studios/:studioId` | Upsert — one review per user per studio, edit-in-place. Recomputes the studio's `avgRating`. |
| `POST /videos` | Publishes immediately (`status: "live"`) — no moderation queue, unlike everything else. 50 MiB upload cap. |
| `POST /videos/:id/block` (admin) | Requires a reason; shown to the uploader. |
| `POST /videos/:id/resubmit` | Uploader edits and goes straight back to live. |
| `POST /follows`, `POST /likes` | Toggle endpoints; polymorphic across Studio/Teacher (Follow) and Studio/Teacher/Class (Like). |
| `GET/POST/DELETE /studio-lists` | User-created named studio collections, selectable as a group in the frontend's studio filter. |

## Moderation

Studio, Location, Teacher, and Class all follow the same lifecycle:
`pending → approved` or `pending → rejected`, admin-only. An owner editing an
already-approved record reverts it to `pending` for re-approval (see the
`PATCH /studios/:id` logic for the pattern).

```
GET  /admin/queue                  everything pending, newest first
POST /admin/:type/:id/approve      type ∈ Studio | Location | Teacher | Class
POST /admin/:type/:id/reject       { feedback? }
GET  /admin/videos                 live videos, for the block workflow
```

## Daily class-schedule scraping

Every Studio submission requires a `scheduleUrl` — a link to the studio's own
class schedule page. `src/scripts/runScrape.js` is a standalone script (not
part of the Express app) that loops every approved studio with a
`scheduleUrl`, parses its schedule via `src/lib/scheduleScraper.js`, and
upserts the results as Class rows, matched across runs by a stable
`(studioId, externalId)` key so re-scraping updates instead of duplicating.

- **Manual corrections always win.** Editing a class (`PATCH /classes/:id`)
  sets `locked: true`, and the scraper skips locked rows forever after.
- **Deployment**: runs as a separate Railway service on a daily cron
  schedule (`node src/scripts/runScrape.js`, exits after one pass) rather
  than inside the API's request/response cycle — see `DEPLOYMENT-NOTES.md`
  in the project root.
- **Manual trigger**: `POST /admin/scrape/run` (admin-only) runs one pass
  immediately, for testing a studio's `scheduleUrl` without waiting a day.
  The admin page has a "Run now" button wired to this.

## What's stubbed vs. real

- **The schedule scraper has two paths**, in `src/lib/scheduleScraper.js`.
  The **.ics calendar feed** path is genuinely reliable — it's a real spec
  (RFC 5545), parsed with the well-established `node-ical` package, with
  weekly/etc. recurring classes correctly expanded into individual future
  occurrences. Almost every booking platform (Bookwhen, Mindbody, Acuity,
  Calendly...) publishes one of these alongside the human-facing schedule
  page; `submit.html` nudges studio owners to paste that link instead of
  the plain webpage. The **generic HTML fallback** (for studios without a
  feed) is the part that's still a stopgap — every studio formats a plain
  page differently, so there's no generic parser that reliably handles all
  of them. It fails silently (`[]`, not a crash) rather than guessing
  wrong. The module's doc comment has the real fix for that path: fetch →
  strip to text → LLM-based structured extraction against a strict schema,
  validated before any DB write. That swap only touches one function.
- **Geocoding** (`src/lib/geocode.js`) and **price detection**
  (`src/lib/priceDetect.js`) have working call signatures but need a real
  provider key / more robust scraping before production.
- **Google OAuth** isn't implemented — email/password works end to end;
  Google sign-in needs a provider (e.g. Passport, Auth.js, or moving auth to
  a managed provider like Supabase/Clerk) wired into `routes/auth.js`.
- **Instagram follower counts** are accepted as submitted fields, not
  auto-fetched — Meta's API access for this is restrictive; revisit if it
  becomes a priority.

## Next up (Phase 7)

Wire the `dance-app/` frontend's `js/data.js` mock `DB` object to real `fetch`
calls against this API — the function signatures in `DB.*` were deliberately
kept close to these routes to make that swap mechanical.
