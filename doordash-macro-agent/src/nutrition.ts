import { existsSync } from "fs";
import { DatabaseSync } from "node:sqlite";
import type { MealMacros } from "./types.js";

const DB_PATH = "data/nutrition.db";
const MATCH_THRESHOLD = 0.5;
// A shared flavour is not enough to identify a prepared meal: for example,
// "Thai Peanut Burrito" otherwise matches a 33 g Thai peanut sauce serving.
const DISH_FORMS = [
  /\bburritos?\b/i, /\bwraps?\b/i, /\bbowls?\b/i, /\bsalads?\b/i,
  /\bsandwich(?:es)?\b/i, /\bburgers?\b/i, /\btacos?\b/i,
  /\bpizzas?\b/i, /\bquesadillas?\b/i, /\bpastas?\b/i, /\bnoodles?\b/i,
];

interface NutritionMatch {
  macros: MealMacros;
  matchedName: string;
}

interface FoodRow {
  fdc_id: number;
  description: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

let db: DatabaseSync | null | undefined; // undefined = not yet checked, null = unavailable
let warnedMissing = false;

function getDb(): DatabaseSync | null {
  if (db !== undefined) return db;
  if (!existsSync(DB_PATH)) {
    db = null;
  } else {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
  }
  return db;
}

function tokenize(name: string): Set<string> {
  return new Set(name.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

// Jaccard-style overlap between the item name and a candidate food description.
function similarity(itemName: string, candidateDescription: string): number {
  const a = tokenize(itemName);
  const b = tokenize(candidateDescription);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / new Set([...a, ...b]).size;
}

function matchesDishForm(itemName: string, candidateDescription: string): boolean {
  const forms = DISH_FORMS.filter((form) => form.test(itemName));
  return forms.length === 0 || forms.some((form) => form.test(candidateDescription));
}

// FTS5 MATCH syntax treats bare space-separated terms as AND, which is too
// strict for menu-item phrasing — join with OR so any shared word surfaces a
// candidate, then rank candidates ourselves with the same similarity scorer
// used to decide whether to accept the match at all.
function ftsQuery(itemName: string): string | null {
  const terms = [...tokenize(itemName)].filter((t) => t.length > 1);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

export function lookupNutrition(itemName: string, database: DatabaseSync | null = getDb()): NutritionMatch | null {
  if (!database) {
    if (!warnedMissing) {
      console.warn("[nutrition] data/nutrition.db not found — run `npm run build-nutrition-db` to enable USDA nutrition matching. Falling back to rough estimates.");
      warnedMissing = true;
    }
    return null;
  }

  const query = ftsQuery(itemName);
  if (!query) return null;

  const rows = database
    .prepare(
      `SELECT foods.fdc_id as fdc_id, foods.description as description, calories, protein, carbs, fat
       FROM foods_fts JOIN foods ON foods.fdc_id = foods_fts.rowid
       WHERE foods_fts MATCH ? ORDER BY rank LIMIT 25`
    )
    .all(query) as unknown as FoodRow[];

  let best: { row: FoodRow; score: number } | null = null;
  for (const row of rows) {
    if (!matchesDishForm(itemName, row.description)) continue;
    const score = similarity(itemName, row.description);
    if (score >= MATCH_THRESHOLD && (!best || score > best.score)) best = { row, score };
  }
  if (!best) return null;

  return {
    matchedName: best.row.description,
    macros: { calories: best.row.calories, protein: best.row.protein, carbs: best.row.carbs, fat: best.row.fat },
  };
}
