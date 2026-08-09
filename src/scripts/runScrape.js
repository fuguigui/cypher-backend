/**
 * Daily schedule scraper — run standalone (not part of the Express app), one
 * pass per invocation, then exits. Deployed as a separate Railway service
 * with a cron schedule (see DEPLOYMENT-NOTES.md), so "every studio, every
 * day" is a scheduling config, not logic in this file.
 *
 * For every approved Studio with a scheduleUrl set, fetches its schedule via
 * scheduleScraper.js and upserts the results into Class rows, matched by the
 * (studioId, externalId) unique key so re-running doesn't create duplicates.
 * Rows a human has since locked (see routes/classes.js PATCH) are left
 * untouched — manual corrections always win over the next scrape.
 *
 * Run manually with:  node src/scripts/runScrape.js
 * (needs the same DATABASE_URL as the API — reads/writes the real DB, not
 * the MOCK_DB stand-in, since there's nothing to test-scrape in-memory.)
 */
const prisma = require("../lib/prisma");
const bcrypt = require("bcryptjs");
const { scrapeStudioSchedule } = require("../lib/scheduleScraper");

const SCRAPER_BOT_EMAIL = "scraper@cypher.internal";

// Scraped classes need a `submittedById` like every other Class row, but
// there's no human submitter — this is a fixed system account that owns all
// of them. Its password hash is a random, unshared value; nothing should
// ever try to log in as it.
async function getOrCreateScraperUser() {
  const existing = await prisma.user.findUnique({ where: { email: SCRAPER_BOT_EMAIL } });
  if (existing) return existing;
  const passwordHash = await bcrypt.hash(require("crypto").randomUUID(), 12);
  return prisma.user.create({
    data: { name: "Schedule Scraper", email: SCRAPER_BOT_EMAIL, passwordHash, role: "submitter" },
  });
}

async function runScrape() {
  const bot = await getOrCreateScraperUser();

  const studios = await prisma.studio.findMany({
    where: { status: "approved", scheduleUrl: { not: null } },
    include: { locations: { where: { status: "approved" }, take: 1 } },
  });

  console.log(`[scrape] ${studios.length} approved studio(s) with a schedule link.`);

  let created = 0, updated = 0, skippedLocked = 0, skippedNoLocation = 0, failed = 0;

  for (const studio of studios) {
    const defaultLocation = studio.locations[0];
    if (!defaultLocation) {
      // Nowhere to attach a scraped class yet — Location is a required field
      // on Class. Common right after a studio is approved but before its
      // first branch is. Skip quietly; next run picks it up once one exists.
      skippedNoLocation++;
      await prisma.studio.update({ where: { id: studio.id }, data: { lastScrapedAt: new Date() } });
      continue;
    }

    let found;
    try {
      found = await scrapeStudioSchedule({ id: studio.id, scheduleUrl: studio.scheduleUrl });
    } catch (err) {
      console.error(`[scrape] ${studio.name}: ${err.message}`);
      failed++;
      await prisma.studio.update({ where: { id: studio.id }, data: { lastScrapedAt: new Date() } });
      continue;
    }

    for (const item of found) {
      const existing = await prisma.class.findUnique({
        where: { studioId_externalId: { studioId: studio.id, externalId: item.externalId } },
      });

      if (existing) {
        if (existing.locked) { skippedLocked++; continue; }
        await prisma.class.update({
          where: { id: existing.id },
          data: {
            title: item.title,
            danceStyle: item.danceStyle,
            datetime: new Date(item.datetime),
            duration: item.duration,
            level: item.level,
            bookingLink: item.bookingLink,
            price: item.price ?? existing.price,
            currency: item.currency ?? existing.currency,
            lastScrapedAt: new Date(),
          },
        });
        updated++;
      } else {
        await prisma.class.create({
          data: {
            studioId: studio.id,
            locationId: defaultLocation.id,
            submittedById: bot.id,
            source: "scraped",
            locked: false,
            externalId: item.externalId,
            title: item.title,
            danceStyle: item.danceStyle,
            datetime: new Date(item.datetime),
            duration: item.duration,
            level: item.level,
            bookingLink: item.bookingLink,
            price: item.price ?? null,
            currency: item.price ? item.currency || "USD" : null,
            // Trusted source: the studio itself supplied this schedule link
            // at submission time, so scraped classes publish immediately
            // rather than sitting in the moderation queue — re-approving
            // every class on every daily run isn't workable in practice.
            status: "approved",
            approvedAt: new Date(),
            lastScrapedAt: new Date(),
          },
        });
        created++;
      }
    }

    await prisma.studio.update({ where: { id: studio.id }, data: { lastScrapedAt: new Date() } });
  }

  const summary = { studios: studios.length, created, updated, skippedLocked, skippedNoLocation, failed };
  console.log(`[scrape] done. ${JSON.stringify(summary)}`);
  return summary;
}

module.exports = { runScrape };

// Only run immediately (and exit) when invoked directly as a script — not
// when required by routes/admin.js for the manual-trigger endpoint below.
if (require.main === module) {
  runScrape()
    .then(() => process.exit(0))
    .catch((err) => { console.error("[scrape] fatal:", err); process.exit(1); });
}
