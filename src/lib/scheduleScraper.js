const ical = require("node-ical");
const cheerio = require("cheerio");

/**
 * Turns a studio's class-schedule link into a list of class objects.
 *
 * This is an **extractor registry**, not a single parser: different booking
 * platforms (and custom studio sites) render their schedule completely
 * differently, so "one generic HTML scraper" can never be reliable across
 * all of them. Each extractor below has a `canHandle(url)` test and an
 * `extract(studio, url)` function; the first one that matches the URL runs.
 * Order matters — most specific/reliable first:
 *
 * 1. **iCalendar (.ics) feed** — the gold-standard path. Almost every
 *    booking platform (Bookwhen, Mindbody, Acuity, Calendly, Google
 *    Calendar itself...) publishes a public .ics feed alongside the
 *    human-facing schedule page. It's a real structured format (RFC 5545),
 *    parsed with `node-ical`, with recurring events (RRULE) correctly
 *    expanded into individual future occurrences. Detected by URL shape.
 *
 * 2. **Bookwhen HTML table** — Bookwhen's public schedule page (the plain
 *    `bookwhen.com/<slug>` URL, not a feed) turns out to server-render its
 *    schedule as a real `<table>` for SEO/crawlers, even though it also
 *    shows a "Javascript must be enabled" notice (that's a `<noscript>`
 *    fallback message, not evidence the table itself needs JS — confirmed
 *    by fetching the page with plain HTTP, no browser). So a dedicated
 *    structural table parser (cheerio, not regex) works here without
 *    needing the studio owner to find their .ics feed link.
 *
 * 3. **Generic HTML fallback** — for anything else with a plain server-
 *    rendered page. Tries to find date/time-shaped text near short titles.
 *    Every studio formats a plain page differently, so this is inherently
 *    a stopgap; it also detects likely JS-rendered single-page apps (very
 *    little text in the raw HTML) and reports that explicitly instead of
 *    silently returning zero classes, which looks identical to "checked,
 *    there's nothing on" otherwise.
 *
 * What this does NOT handle yet, on purpose (see README "What's stubbed"):
 * - **Instagram-image schedules** (a photo of a timetable posted as a
 *   feed image). This needs OCR/vision-based extraction, a materially
 *   different pipeline (fetch image -> vision model -> structured JSON)
 *   that isn't built yet. Reported as `method: "unsupported"`.
 * - **Client-rendered custom sites** (e.g. a Next.js/React timetable page
 *   that ships an empty HTML shell and fills it in via JS after load,
 *   like themanorldn.com/timetable). A plain fetch can't see that content;
 *   the real fix is a headless-browser fetch (Playwright/Puppeteer) before
 *   parsing, which isn't wired in yet. Reported as `method: "unsupported"`
 *   with `note` explaining why, rather than guessing.
 *
 * @param {{ id: string, scheduleUrl: string }} studio
 * @returns {Promise<{
 *   items: Array<{ externalId, title, danceStyle, datetime, duration, level, bookingLink, price?, currency? }>,
 *   method: "ics" | "bookwhen_html" | "generic_html" | "unsupported" | "none",
 *   note: string | null,
 * }>}
 */
async function scrapeStudioSchedule(studio) {
  if (!studio.scheduleUrl) return { items: [], method: "none", note: "No schedule link set." };

  const url = studio.scheduleUrl.trim().replace(/^webcal:\/\//i, "https://");

  for (const extractor of EXTRACTORS) {
    if (!extractor.canHandle(url)) continue;
    const result = await extractor.extract(studio, url);
    // An extractor matching the URL but finding nothing (e.g. an .ics URL
    // that 404s, or turns out to require auth) falls through to the next
    // one rather than giving up immediately.
    if (result.items.length > 0 || result.method !== "__retry__") return result;
  }

  return { items: [], method: "unsupported", note: "No extractor could read this URL. See admin panel guidance." };
}

// ---- 1. iCalendar (.ics) feed --------------------------------------------

function looksLikeIcsUrl(url) {
  return /\.ics(\?|$)/i.test(url) || /feeds\.bookwhen\.com/i.test(url);
}

async function scrapeIcs(studio, url) {
  let events;
  try {
    events = await ical.async.fromURL(url);
  } catch (err) {
    return { items: [], method: "__retry__", note: `.ics fetch failed: ${err.message}` };
  }

  const now = new Date();
  const windowEnd = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000); // 90 days ahead
  const items = [];

  for (const ev of Object.values(events)) {
    if (ev.type !== "VEVENT" || !ev.start) continue;

    const instances = ev.rrule
      ? ical.expandRecurringEvent(ev, { from: now, to: windowEnd })
      : [ev];

    for (const inst of instances) {
      const start = inst.start;
      if (!start || start < now || start > windowEnd) continue;

      const durationMinutes = inst.end
        ? Math.max(15, Math.round((inst.end - start) / 60000))
        : 60;

      const rawTitle = (inst.summary || "Class").toString();
      const { title, danceStyle, level } = parseStyleAndLevel(rawTitle);

      items.push({
        externalId: `${ev.uid || rawTitle}:${start.toISOString()}`.slice(0, 190),
        title,
        danceStyle,
        datetime: start.toISOString(),
        duration: durationMinutes,
        level,
        bookingLink: inst.url || studio.scheduleUrl,
      });
    }
  }

  if (items.length === 0) return { items: [], method: "__retry__", note: "Feed parsed but had no upcoming events." };
  return { items, method: "ics", note: null };
}

// ---- 2. Bookwhen HTML table -----------------------------------------------

function looksLikeBookwhenUrl(url) {
  return /(^|\/\/)([\w-]+\.)?bookwhen\.com\//i.test(url);
}

// London-only for now (Bookwhen's page shows "Times shown in timezone:
// London" for UK-based accounts) — good enough for the studios this app
// currently targets. UTC offset in minutes for each abbreviation Bookwhen
// prints next to the time.
const UK_TZ_OFFSET_MIN = { BST: 60, GMT: 0, BDT: 60 };

const MONTH_INDEX = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

async function scrapeBookwhenHtml(studio, url) {
  let html;
  try {
    const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; CypherScraper/1.0)" } });
    if (!res.ok) return { items: [], method: "error", note: `Fetch failed: HTTP ${res.status}` };
    html = await res.text();
  } catch (err) {
    return { items: [], method: "error", note: `Fetch failed: ${err.message}` };
  }

  const $ = cheerio.load(html);
  const items = [];

  let currentMonth = null; // { monthIndex, year }
  let lastDay = null;
  let lastWeekday = null;

  const monthHeaderPattern = /^([A-Za-z]+),?\s+(\d{4})$/;
  const timePattern = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*([A-Z]{2,4})?$/i;
  const dayPattern = /^\d{1,2}$/;

  $("table tr").each((_, tr) => {
    const cellTexts = $(tr)
      .find("td, th")
      .map((__, cell) => $(cell).text().replace(/\s+/g, " ").trim())
      .get();
    if (cellTexts.every((t) => !t)) return; // fully blank row

    // A lone "Month, Year" cell (the calendar's section header row).
    const headerCell = cellTexts.find((t) => monthHeaderPattern.test(t));
    if (headerCell && cellTexts.filter(Boolean).length <= 2) {
      const m = headerCell.match(monthHeaderPattern);
      const monthIndex = MONTH_INDEX[m[1].slice(0, 3).toLowerCase()];
      if (monthIndex !== undefined) currentMonth = { monthIndex, year: Number(m[2]) };
      return;
    }
    if (!currentMonth) return; // haven't seen a month header yet — not a data row we can place

    const dayCell = cellTexts.find((t) => dayPattern.test(t));
    if (dayCell) lastDay = Number(dayCell);
    const weekdayCell = cellTexts.find((t) => /^(mon|tue|wed|thu|fri|sat|sun)/i.test(t) && t.length <= 4);
    if (weekdayCell) lastWeekday = weekdayCell;

    const timeCell = cellTexts.find((t) => timePattern.test(t));
    if (!timeCell || lastDay === null) return; // no time on this row, or no date context yet — skip

    const titleCell = cellTexts
      .filter((t) => t && t !== timeCell && t !== dayCell && t !== weekdayCell)
      .sort((a, b) => b.length - a.length)[0];
    if (!titleCell) return;

    const tm = timeCell.match(timePattern);
    const hour12 = Number(tm[1]) % 12;
    const minute = Number(tm[2] || 0);
    const isPM = /pm/i.test(tm[3]);
    const hour24 = hour12 + (isPM ? 12 : 0);
    const tzAbbrev = (tm[4] || "GMT").toUpperCase();
    const offsetMin = UK_TZ_OFFSET_MIN[tzAbbrev] ?? 0;

    const utcMs = Date.UTC(currentMonth.year, currentMonth.monthIndex, lastDay, hour24, minute) - offsetMin * 60000;
    const datetime = new Date(utcMs);
    if (Number.isNaN(datetime.getTime())) return;

    const { title, danceStyle, level } = parseStyleAndLevel(titleCell);
    items.push({
      externalId: `${studio.id}:${datetime.toISOString()}:${title}`.slice(0, 190),
      title,
      danceStyle,
      datetime: datetime.toISOString(),
      duration: 60, // Bookwhen's table doesn't show an end time; 60min is the platform's common default
      level,
      bookingLink: url,
    });
  });

  if (items.length === 0) {
    return {
      items: [],
      method: "no_events",
      note: "Reached the Bookwhen page and read its schedule table, but found zero matching rows — the table markup may have changed, or there's genuinely nothing scheduled right now.",
    };
  }
  return { items, method: "bookwhen_html", note: null };
}

// ---- 3. Generic HTML fallback ---------------------------------------------

async function scrapeHtml(studio, url) {
  let html;
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return { items: [], method: "error", note: `Fetch failed: HTTP ${res.status}` };
    html = await res.text();
  } catch (err) {
    return { items: [], method: "error", note: `Fetch failed: ${err.message}` };
  }

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ");

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  // A page whose raw HTML has very little visible text almost always means
  // the real content is injected by client-side JS after load (a React/Vue/
  // Next.js single-page app) — a plain fetch can't see it. Flag this
  // distinctly instead of returning [] indistinguishably from "checked,
  // there's nothing scheduled".
  if (lines.length < 25) {
    return {
      items: [],
      method: "unsupported",
      note: "This page looks like it renders its content with JavaScript (very little text in the raw HTML) — a plain fetch can't read it. Options: ask the studio for their booking platform's .ics calendar feed link instead, or add classes manually.",
    };
  }

  const dateTimePattern =
    /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+\w+\s+\d{1,2}[,]?\s+\d{1,2}:\d{2}\s*(?:am|pm)?)\b/i;

  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(dateTimePattern);
    if (!m) continue;
    const titleLine = lines[i + 1] || lines[i - 1];
    if (!titleLine || titleLine.length > 120) continue;

    const parsed = new Date(m[1]);
    if (Number.isNaN(parsed.getTime())) continue;

    const { title, danceStyle, level } = parseStyleAndLevel(titleLine);
    found.push({
      externalId: `${studio.id}:${m[1]}:${titleLine}`.slice(0, 190),
      title,
      danceStyle,
      datetime: parsed.toISOString(),
      duration: 60,
      level,
      bookingLink: url,
    });
  }

  if (found.length === 0) {
    return {
      items: [],
      method: "no_events",
      note: "Fetched the page and found real text content, but no recognizable date/time + class-title pattern. This studio's page format likely needs a dedicated parser, same as Bookwhen got.",
    };
  }
  return { items: found, method: "generic_html", note: null };
}

// ---- Shared helpers ---------------------------------------------------

// Recognizable "[Style Level]" suffix on an event title, e.g. Bookwhen's
// "KATSEYE - 'Iconic' [Kpop All Level]" — when present this is far more
// reliable than any guess, so it's worth specifically checking for.
const LEVELS = ["Beginner", "Intermediate", "Advanced", "All Levels"];
function parseStyleAndLevel(title) {
  const m = title.match(/\[([^\]]+)\]\s*$/);
  if (!m) return { title, danceStyle: "Hip-Hop", level: "All Levels" };

  const tag = m[1].trim();
  const cleanTitle = title.slice(0, m.index).trim();
  const level = LEVELS.find((l) => tag.toLowerCase().endsWith(l.toLowerCase())) || "All Levels";
  const danceStyle = tag.slice(0, tag.length - level.length).trim() || "Hip-Hop";
  return { title: cleanTitle, danceStyle, level };
}

// Extractor registry, most specific/reliable first.
const EXTRACTORS = [
  { canHandle: looksLikeIcsUrl, extract: scrapeIcs },
  { canHandle: looksLikeBookwhenUrl, extract: scrapeBookwhenHtml },
  { canHandle: () => true, extract: scrapeHtml }, // catch-all, always matches
];

/**
 * ---- Adding a new platform-specific extractor ----
 * 1. Write `canHandle(url)` (usually a domain/path check) and
 *    `async extract(studio, url) -> { items, method, note }`.
 * 2. Push `{ canHandle, extract }` into EXTRACTORS *above* the generic
 *    catch-all (order = priority; first match wins).
 * That's the whole integration surface — src/scripts/runScrape.js and the
 * admin scrape-monitoring panel already handle whatever `method`/`note` you
 * return generically.
 *
 * ---- Instagram-image schedules (not implemented) ----
 * Needs a different pipeline entirely: fetch the Instagram post's image
 * (via their Graph API, since plain scraping of instagram.com is blocked
 * for non-logged-in requests), send it to a vision-capable model with a
 * strict prompt ("read this timetable image, return JSON matching this
 * schema"), then validate the response against a schema (zod or similar)
 * before writing anything. Meaningful new surface area — a studio's
 * `scheduleUrl` would need to accept an Instagram post URL and the registry
 * above would gain a `canHandle` for instagram.com/p/... links.
 *
 * ---- Client-rendered custom sites (e.g. themanorldn.com/timetable) ----
 * The realistic fix is a headless-browser fetch (Playwright/Puppeteer) that
 * actually executes the page's JS before handing the resulting HTML to a
 * parser, followed by LLM-based structured extraction (fetch -> render ->
 * strip to text -> LLM with a strict JSON schema -> validate -> write).
 * That's a real infra addition (a browser binary in the scraper's runtime
 * environment) rather than a code-only change, so it's flagged as
 * `unsupported` for now rather than silently guessing wrong.
 */

module.exports = { scrapeStudioSchedule };
