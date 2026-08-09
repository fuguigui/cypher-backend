const ical = require("node-ical");

/**
 * Turns a studio's class-schedule link into a list of class objects.
 *
 * Two strategies, tried in order:
 *
 * 1. **iCalendar (.ics) feed** — the reliable path. Almost every booking
 *    platform (Bookwhen, Mindbody, Acuity, Calendly, Google Calendar
 *    itself...) publishes a public .ics feed alongside the human-facing
 *    schedule page. It's a real structured format (RFC 5545), so parsing it
 *    is genuinely robust — no guessing at HTML. We detect this by URL shape
 *    (`.ics`, `webcal://`) or by the response's Content-Type, and parse with
 *    `node-ical`, expanding recurring events (RRULE) so a weekly class shows
 *    up as many future occurrences, not one.
 *
 * 2. **Generic HTML fallback** — for anything else. Every studio formats a
 *    plain schedule page differently, so there's no generic parser that
 *    reliably handles all of them; this looks for date/time-shaped lines
 *    near short text and gives up (returns `[]`) rather than guessing wrong.
 *    See the bottom of this file for the realistic production fix for this
 *    path (LLM-based extraction) — the .ics path above doesn't need it.
 *
 * Callers should treat a `[]` return as "couldn't parse this one", not
 * "studio has no classes" — src/scripts/runScrape.js already does this (it
 * just updates `lastScrapedAt` and moves on).
 */

/**
 * @param {{ id: string, scheduleUrl: string }} studio
 * @returns {Promise<Array<{
 *   externalId: string, title: string, danceStyle: string, datetime: string,
 *   duration: number, level: string, bookingLink: string,
 *   price?: number, currency?: string,
 * }>>}
 */
async function scrapeStudioSchedule(studio) {
  if (!studio.scheduleUrl) return [];

  const url = studio.scheduleUrl.trim().replace(/^webcal:\/\//i, "https://");

  if (looksLikeIcsUrl(url)) {
    const viaIcs = await scrapeIcs(studio, url);
    if (viaIcs.length) return viaIcs;
    // Fall through to the HTML fallback in case the URL matched the pattern
    // but wasn't actually an ICS response (e.g. a redirect to a login page).
  }

  return scrapeHtml(studio, url);
}

function looksLikeIcsUrl(url) {
  return /\.ics(\?|$)/i.test(url) || /feeds\.bookwhen\.com/i.test(url);
}

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

async function scrapeIcs(studio, url) {
  let events;
  try {
    events = await ical.async.fromURL(url);
  } catch (err) {
    return [];
  }

  const now = new Date();
  const windowEnd = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000); // 90 days ahead
  const results = [];

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

      results.push({
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

  return results;
}

async function scrapeHtml(studio, url) {
  let html;
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return [];
    html = await res.text();
  } catch (err) {
    return [];
  }

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ");

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

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

  return found;
}

/**
 * ---- Real implementation for the HTML fallback path ----
 * The .ics path above is genuinely reliable — it's a real spec, not a guess.
 * The HTML fallback is the part that's still a stopgap, for studios whose
 * platform doesn't publish a calendar feed. The realistic fix there is
 * LLM-based structured extraction, not more regex:
 *   1. Fetch the page (or render it with a headless browser if the schedule
 *      is JS-rendered — Playwright/Puppeteer).
 *   2. Strip it to visible text (e.g. with `html-to-text` or `cheerio`).
 *   3. Send that text to an LLM with a strict JSON schema — title, danceStyle,
 *      datetime, duration, level, bookingLink, price — and low temperature.
 *   4. Validate the response against the schema before touching the DB (zod
 *      or similar) — never trust model output blindly for writes.
 * That swap only touches `scrapeHtml()` above — the ICS path, the return
 * contract, and everything in src/scripts/runScrape.js stays the same.
 */

module.exports = { scrapeStudioSchedule };
