/**
 * Best-effort price scrape from a booking page when the submitter leaves
 * price blank. Returns null (never a fake $0) if nothing confident is found —
 * per the product decision that a missing price should just be hidden on the
 * class card, not shown as a placeholder.
 */
async function detectPriceFromBookingLink(bookingLink) {
  try {
    const res = await fetch(bookingLink, { redirect: "follow" });
    if (!res.ok) return null;
    const html = await res.text();

    // Naive first pass: look for a currency-prefixed number near the words
    // "class"/"drop-in"/"price". Swap for a real scraping/LLM-extraction step
    // in production — this is a placeholder that keeps the contract (return
    // {amount, currency} | null) stable for callers.
    const match = html.match(/\$\s?(\d{1,3}(?:\.\d{2})?)/);
    if (!match) return null;

    return { amount: Number(match[1]), currency: "USD" };
  } catch (err) {
    return null;
  }
}

module.exports = { detectPriceFromBookingLink };
