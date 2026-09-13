import { createWriteStream, readdirSync } from "fs";
import { createReadStream } from "fs";
import { pipeline } from "stream/promises";

// Reassembles data/nutrition.db from the checked-in data/nutrition.db.part-NN
// chunks (each kept under GitHub's 100MB file limit). Run this after cloning
// instead of npm run build-nutrition-db if you just want the prebuilt data.
const DIR = "data";
const OUT = `${DIR}/nutrition.db`;

async function main(): Promise<void> {
  const parts = readdirSync(DIR)
    .filter((f) => /^nutrition\.db\.part-\d+$/.test(f))
    .sort();
  if (parts.length === 0) {
    console.error(`No ${DIR}/nutrition.db.part-* files found.`);
    process.exit(1);
  }

  const out = createWriteStream(OUT);
  for (const part of parts) {
    console.log(`[join-nutrition-db] appending ${part}`);
    await pipeline(createReadStream(`${DIR}/${part}`), out, { end: false });
  }
  out.end();
  console.log(`[join-nutrition-db] wrote ${OUT} from ${parts.length} parts.`);
}

await main();
