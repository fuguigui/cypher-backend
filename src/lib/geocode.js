/**
 * Turns a submitted address into { lat, lng }. Swap the implementation for a
 * real provider (Mapbox, Google Maps Geocoding, OpenCage, etc.) — the routes
 * that call this only care about the { lat, lng } shape, so this is a safe
 * seam to replace without touching route code.
 */
async function geocodeAddress(address, city, country) {
  const apiKey = process.env.GEOCODING_API_KEY;
  if (!apiKey) {
    // No provider configured yet — fail loudly rather than silently writing
    // bad coordinates that would misplace a pin on the map.
    throw new Error(
      "GEOCODING_API_KEY is not set. Configure a geocoding provider in .env before accepting Location submissions."
    );
  }

  // Example shape for a Mapbox-style forward geocoding call. Replace with
  // whichever provider you choose.
  const query = encodeURIComponent(`${address}, ${city}, ${country}`);
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${query}.json?access_token=${apiKey}&limit=1`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding request failed: ${res.status}`);
  const data = await res.json();
  const feature = data.features && data.features[0];
  if (!feature) throw new Error("No geocoding match for that address.");

  const [lng, lat] = feature.center;
  return { lat, lng };
}

module.exports = { geocodeAddress };
