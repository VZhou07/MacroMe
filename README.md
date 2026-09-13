# MacroMe

A macro-aware DoorDash ordering agent with a web onboarding wizard and a live dashboard.

You describe your macro goals, meal times, budget, delivery addresses and food
preferences once. The agent then searches DoorDash, reads menus, picks the dish
that best fits your macros for that meal, and waits for you to approve the cart
before anything is charged.

## How the two halves connect

```
ui/ (wizard)  ──POST /api/config──▶  macrome-config.json  ──▶  doordash-macro-agent/src/plan.ts
                                     (the saved plan)              │
                                                                   ├─▶ UserConfig   → menu scraping, budget filter
                                                                   └─▶ brief (prose) → the meal-picker's LLM prompt
```

`macrome-config.json` is the single source of truth. `plan.ts` validates it and
derives two things:

- a **structured config** the scraper uses (search query, per-cart budget, macro
  targets, days and order times), and
- a **natural-language brief** injected into the meal-picker's system prompt, so
  details that don't fit in numbers — delivery time, address, drop-off,
  preferred cuisines, dietary constraints, ingredients to avoid — reach the model.

## Setup

```bash
npm install
npm install --prefix doordash-macro-agent
npm run join-nutrition-db --prefix doordash-macro-agent             # restore the bundled nutrition database
cp doordash-macro-agent/.env.example doordash-macro-agent/.env   # add your keys
npm run setup-profile                                            # log into DoorDash once
```

`setup-profile` opens a live browser you log into by hand, then saves a reusable
Steel profile id into `.env`. Every later run reuses that login.

The bundled nutrition database is stored as three `nutrition.db.part-NN` files
to keep each file below GitHub's file-size limit. The join command combines them
in order into `doordash-macro-agent/data/nutrition.db`, which is gitignored.
Run it after cloning or pulling updated chunks. No USDA download or database
rebuild is needed. The agent uses matching food records for per-serving macros
and falls back to model estimates when no match is found. Name matches and
database serving sizes may differ from the actual restaurant dish and portion.

## Running

```bash
npm run dev     # http://localhost:3000
```

- **No plan saved yet** → `/` serves the onboarding wizard.
- **A plan exists** → `/` serves the dashboard: your plan, the next scheduled
  orders, a **Run now** button, and the agent's live browser in an iframe.
  `/setup` always reopens the wizard to edit the plan.

**Run now** takes the next dated order from **Next scheduled orders**. Once the
agent reports it placed, that occurrence is removed; future repetitions stay
scheduled. Completion history is saved in the gitignored
`macrome-queue-state.json`, survives server restarts, and is also checked by the
scheduler. Declining, failing, or running in dry-run mode does not mark it complete.

At checkout, the dashboard and terminal list every scraped cart line, quantities,
prices and available modifiers, alongside DoorDash's full checkout total. The
recommended dish and its macros are labeled **Agent pick**. **Place order**
approves the entire cart, including any leftovers. Unreadable carts stop approval;
a changed cart or total after approval stops placement. Uncertain adds are
inspected before further changes. Before approval, the model can recover by
reducing quantities, removing cart lines, replacing the cart with a cheaper
candidate (including another restaurant), or retrying inspection. Every edit
uses verified cart controls and is followed by a fresh read. The actual checkout
total must fit the saved all-in budget; if fees are excluded from the budget,
the cart's food line totals must fit instead. Recovery stops after eight steps
or four minutes and explains the unresolved problem without placing an order.

Restaurant discovery scrolls the search results and compares up to 30 restaurants
by default, with a four-minute search budget. `MACROME_MAX_STORES` can set a cap
between 1 and 30. Slow or unreadable menus are skipped so other restaurants can
still be considered.

Development checks: `npm test` covers the order queue and server behavior;
`npm run test:checkout --prefix doordash-macro-agent` exercises checkout and the
dashboard in local Chromium. The latter requires a Playwright Chromium install
and its system libraries; `CHROMIUM_PATH` can select an existing executable.
`npm run test:recovery --prefix doordash-macro-agent` tests budget enforcement,
validated model actions, restaurant replacement and bounded retries.

Other entry points:

| Command | What it does |
| --- | --- |
| `npm run dev` | Web wizard + dashboard |
| `npm run agent` | One ordering run in the terminal (approval is a yes/no prompt) |
| `npm run schedule` | Cron loop that fires each meal at its order time |
| `MACROME_DRY_RUN=1 npm run dev` | Dashboard runs against a mock menu, no browser, no order |

## Environment

| Variable | Purpose |
| --- | --- |
| `STEEL_API_KEY` | Steel remote browser |
| `OPENROUTER_API_KEY` | The model that picks the meal |
| `STEEL_PROFILE_ID` | Saved DoorDash login, written by `setup-profile` |
| `MACROME_CONFIG` | Override the plan file path |
| `MACROME_MAX_STORES` | Restaurants to compare per run (default 30, max 30) |

`macrome-config.json` holds your home address and is gitignored.
