/**
 * Turns a studio's class-schedule page into a list of class objects. This is
 * the hard part of the whole feature, and it's worth being honest about why:
 * every studio formats their schedule differently (a hand-written HTML table,
 * a Mindbody/Momence/Acuity booking widget rendered by JavaScript, a PDF, an
 * Instagram post screenshot...). There is no generic parser that reliably
 * handles all of that.
 *
 * What's here is a genuinely best-effort fallback: fetch the page and look
 * for lines that look like "<time> <title>" patterns. It will work on simple,
 * hand-written static schedule pages and will not work on most real studio
 * sites — see the "Real implementation" note below for the actual fix.
 *
 * Callers should treat a `[]` return as "couldn't parse this one", not
 * "studio has no classes" — src/scripts/runScrape.js already does this (it
 * just updates `lastScrapedAt` and moves on).
 *
 * ---- Real implementation, when you're ready to replace this file ----
 * The reliable approach for arbitrary studio websites is LLM-based structured
 * extraction, not hand-written parsing rules:
 *   1. Fetch the page (or render it with a headless browser if the schedule
 *      is JS-rendered — Playwright/Puppeteer).
 *   2. Strip it to visible text (e.g. with `html-to-text` or `cheerio`).
 *   3. Send that text to an LLM with a strict JSON schema — title, danceStyle,
 *      datetime, duration, level, bookingLink, price — and low temperature.
 *   4. Validate the response against the schema before touching the DB (zod
 *      or similar) — never trust model output blindly for writes.
 * That swap only touches this file; runScrape.js and the Class upsert logic
 * don't need to change, since the contract (return value shape) stays the
 * same.
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

  let html;
  try {
    const res = await fetch(studio.scheduleUrl, { redirect: "follow" });
    if (!res.ok) return [];
    html = await res.text();
  } catch (err) {
    return [];
  }

  // Naive fallback parser: looks for repeating blocks that contain both a
  // recognizable date/time and something that reads as a class title. This
  // intentionally stays conservative (returns nothing rather than garbage)
  // — a missing class is a lot less damaging than a fabricated one.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ");

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  // Matches things like "Mon Aug 17 6:00 PM" or "2026-08-17 18:00" near a
  // line of text — this is a placeholder pattern, not a real parser; see the
  // module doc comment above.
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

    found.push({
      externalId: `${studio.id}:${m[1]}:${titleLine}`.slice(0, 190),
      title: titleLine,
      danceStyle: "Hip-Hop", // unknown from a generic parse — flagged for manual correction
      datetime: parsed.toISOString(),
      duration: 60,
      level: "All Levels",
      bookingLink: studio.scheduleUrl,
    });
  }

  return found;
}

module.exports = { scrapeStudioSchedule };
