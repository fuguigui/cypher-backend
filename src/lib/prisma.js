// Single shared instance across the app — avoids exhausting DB connections
// under dev hot-reload and keeps every route importing the same client.
//
// MOCK_DB=1 swaps in an in-memory stand-in (src/lib/mockPrisma.js) used only
// by the smoke test — see that file for why it exists. Never set MOCK_DB in
// a real deployment; nothing persists.
let prisma;
if (process.env.MOCK_DB === "1") {
  prisma = require("./mockPrisma");
} else {
  const { PrismaClient } = require("@prisma/client");
  prisma = new PrismaClient();
}

module.exports = prisma;
