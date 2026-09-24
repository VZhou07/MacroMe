import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { lookupNutrition } from '../src/nutrition.ts';

test('a restaurant burrito never inherits a condiment serving from USDA', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE foods (
      fdc_id INTEGER PRIMARY KEY, description TEXT NOT NULL,
      calories REAL NOT NULL, protein REAL NOT NULL,
      carbs REAL NOT NULL, fat REAL NOT NULL
    );
    CREATE VIRTUAL TABLE foods_fts USING fts5(description, content='foods', content_rowid='fdc_id');
  `);
  const insert = db.prepare('INSERT INTO foods VALUES (?, ?, ?, ?, ?, ?)');
  insert.run(1, 'THAI PEANUT SAUCE, THAI PEANUT', 80, 2, 7, 5);
  insert.run(2, 'CHICKEN BURRITO', 250, 11, 38, 7);
  db.exec('INSERT INTO foods_fts(rowid, description) SELECT fdc_id, description FROM foods');

  assert.equal(lookupNutrition('Thai Peanut Burrito', db), null);
  assert.deepEqual(lookupNutrition('Thai Peanut Sauce', db)?.macros,
    { calories: 80, protein: 2, carbs: 7, fat: 5 });
  assert.deepEqual(lookupNutrition('Chicken Burrito', db)?.macros,
    { calories: 250, protein: 11, carbs: 38, fat: 7 });
});
