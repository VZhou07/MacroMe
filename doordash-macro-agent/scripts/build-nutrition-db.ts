import { createReadStream, existsSync, mkdirSync, statSync, unlinkSync } from "fs";
import { createInterface } from "readline";
import { DatabaseSync } from "node:sqlite";

// Builds a local, offline nutrition lookup from the USDA FoodData Central
// full CSV export (https://fdc.nal.usda.gov/download-datasets) — no API key,
// no rate limit, richer coverage than the live search API.
//
// Usage: npm run build-nutrition-db [path-to-extracted-csv-folder]
// Default folder: data/fdc-raw/ (must contain food.csv, branded_food.csv,
// food_nutrient.csv, food_portion.csv, survey_fndds_food.csv)

const RAW_DIR = process.argv[2] ?? "data/fdc-raw";
const DB_PATH = "data/nutrition.db";

// nutrient.csv ids (stable across FDC releases; confirmed against this snapshot):
// 1008 Energy (kcal), 1003 Protein (g), 1005 Carbohydrate by difference (g), 1004 Total lipid/fat (g)
const NUTRIENT_IDS = new Set([1008, 1003, 1005, 1004]);
const NUTRIENT_KEY: Record<number, "calories" | "protein" | "carbs" | "fat"> = {
  1008: "calories",
  1003: "protein",
  1005: "carbs",
  1004: "fat",
};

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { fields.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

async function forEachRow(path: string, onRow: (cols: Record<string, string>, header: string[]) => void): Promise<number> {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let header: string[] | null = null;
  let count = 0;
  for await (const line of rl) {
    if (!line) continue;
    const fields = parseCsvLine(line);
    if (!header) { header = fields; continue; }
    const cols: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) cols[header[i]] = fields[i] ?? "";
    onRow(cols, header);
    count++;
    if (count % 2_000_000 === 0) console.log(`  ...${count.toLocaleString()} rows`);
  }
  return count;
}

async function main(): Promise<void> {
  for (const f of ["food.csv", "branded_food.csv", "food_nutrient.csv", "food_portion.csv", "survey_fndds_food.csv"]) {
    if (!existsSync(`${RAW_DIR}/${f}`)) {
      console.error(`Missing ${RAW_DIR}/${f}. Extract the USDA FoodData Central CSV download there first ` +
        `(https://fdc.nal.usda.gov/download-datasets), or pass the folder as an argument.`);
      process.exit(1);
    }
  }

  mkdirSync("data", { recursive: true });
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);

  console.log("[1/5] Reading food.csv (branded + survey foods only)...");
  const foodMeta = new Map<number, { description: string; isSurvey: boolean }>();
  await forEachRow(`${RAW_DIR}/food.csv`, (r) => {
    if (r.data_type !== "branded_food" && r.data_type !== "survey_fndds_food") return;
    foodMeta.set(Number(r.fdc_id), { description: r.description, isSurvey: r.data_type === "survey_fndds_food" });
  });
  console.log(`  ${foodMeta.size.toLocaleString()} candidate foods`);

  console.log("[2/5] Reading branded_food.csv for serving sizes (grams only)...");
  const servingGrams = new Map<number, number>();
  await forEachRow(`${RAW_DIR}/branded_food.csv`, (r) => {
    if (r.serving_size_unit !== "g") return;
    const fdcId = Number(r.fdc_id);
    const grams = parseFloat(r.serving_size);
    if (foodMeta.has(fdcId) && grams > 0) servingGrams.set(fdcId, grams);
  });
  console.log("[3/5] Reading food_portion.csv for survey-food serving sizes...");
  await forEachRow(`${RAW_DIR}/food_portion.csv`, (r) => {
    const fdcId = Number(r.fdc_id);
    if (servingGrams.has(fdcId)) return; // first portion wins
    const meta = foodMeta.get(fdcId);
    if (!meta?.isSurvey) return;
    const grams = parseFloat(r.gram_weight);
    if (grams > 0) servingGrams.set(fdcId, grams);
  });
  console.log(`  ${servingGrams.size.toLocaleString()} foods have a usable serving size`);

  console.log("[4/5] Reading food_nutrient.csv (this is the big one, ~27M rows)...");
  const macros = new Map<number, Partial<Record<"calories" | "protein" | "carbs" | "fat", number>>>();
  await forEachRow(`${RAW_DIR}/food_nutrient.csv`, (r) => {
    const fdcId = Number(r.fdc_id);
    if (!servingGrams.has(fdcId)) return; // skip foods we can't scale to a serving anyway
    const nutrientId = Number(r.nutrient_id);
    if (!NUTRIENT_IDS.has(nutrientId)) return;
    const amount = parseFloat(r.amount);
    if (!Number.isFinite(amount)) return;
    const entry = macros.get(fdcId) ?? {};
    entry[NUTRIENT_KEY[nutrientId]] = amount; // per 100g
    macros.set(fdcId, entry);
  });

  console.log("[5/5] Writing SQLite database...");
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE foods (
      fdc_id INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      serving_grams REAL NOT NULL,
      calories REAL NOT NULL,
      protein REAL NOT NULL,
      carbs REAL NOT NULL,
      fat REAL NOT NULL
    );
  `);
  const insert = db.prepare(
    "INSERT INTO foods (fdc_id, description, serving_grams, calories, protein, carbs, fat) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );

  let written = 0;
  db.exec("BEGIN");
  for (const [fdcId, grams] of servingGrams) {
    const n = macros.get(fdcId);
    if (!n || n.calories == null || n.protein == null || n.carbs == null || n.fat == null) continue;
    const scale = grams / 100;
    insert.run(
      fdcId,
      foodMeta.get(fdcId)!.description,
      grams,
      Math.round(n.calories * scale),
      Math.round(n.protein * scale),
      Math.round(n.carbs * scale),
      Math.round(n.fat * scale)
    );
    written++;
    if (written % 200_000 === 0) {
      db.exec("COMMIT");
      db.exec("BEGIN");
      console.log(`  ...${written.toLocaleString()} written`);
    }
  }
  db.exec("COMMIT");
  console.log(`  ${written.toLocaleString()} foods with complete per-serving macros`);

  console.log("Building full-text search index...");
  db.exec(`CREATE VIRTUAL TABLE foods_fts USING fts5(description, content='foods', content_rowid='fdc_id');`);
  db.exec(`INSERT INTO foods_fts(rowid, description) SELECT fdc_id, description FROM foods;`);

  console.log("Compacting database...");
  db.exec("VACUUM");
  db.close();

  const sizeMb = (statSync(DB_PATH).size / (1024 * 1024)).toFixed(1);
  console.log(`\nDone. ${DB_PATH} (${sizeMb} MB, ${written.toLocaleString()} foods).`);
}

await main();
