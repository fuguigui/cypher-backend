// Fixed city enum — must stay in sync with the frontend's CITIES list in
// dance-app/js/data.js (see 01-data-model-spec.md "City List" section).
// Location submissions are validated against this list rather than accepting
// free text, per the earlier product decision to launch with a curated set.
const CITIES = [
  "Seoul", "Tokyo", "Osaka", "Shanghai", "Chengdu", "Beijing", "Guangzhou", "Taipei",
  "Singapore", "New York", "Los Angeles", "San Francisco", "Chicago", "London",
  "Paris", "Munich", "Berlin", "Amsterdam", "Toronto", "Sydney", "Hong Kong", "São Paulo",
];

module.exports = { CITIES };
