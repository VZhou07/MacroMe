# MacroMe

A macro-aware DoorDash ordering agent with a web onboarding wizard and a live dashboard.

You set daily calorie/protein/carb/fat goals, meal times, budget, delivery preferences, and food constraints once. The agent searches DoorDash in a Steel cloud browser, reads menus, picks dishes that best match your macros for that meal, shows a live browser view, and waits for you to approve the full cart before anything is charged.

**In one paragraph:** MacroMe helps gym-conscious builders hit macros via DoorDash with human approval. Today it runs locally 24/7 if you leave the process up, remembers progress in JSON across restarts, and gives non-devs a website while devs can script or (later) call an MCP server. As we scale, the UI and always-on backend grow up behind a real database; MCP remains the clean agent-facing API for developers who live in the terminal and IDE.

## Who it targets

**Primary:** developers and technical builders who go to the gym and care about nutrients — people who already live in a terminal or IDE, want food that fits their macros without manually hunting DoorDash every meal, and are fine running a local always-on process for a hackathon or personal setup.

**Also:** the same product has a website UI so non-developers (or devs who prefer a UI) can onboard, click Run now, approve orders, and later read end-of-day summaries without touching MCP or scripts.

## How the two halves connect

```
ui/ (wizard)  ──POST /api/config──▶  macrome-config.json  ──▶  doordash-macro-agent/src/plan.ts
                                     (the saved plan)              │
                                                                   ├─▶ UserConfig   → menu scraping, budget filter
                                                                   └─▶ brief (prose) → the meal-picker's LLM prompt
```

`macrome-config.json` is the source of truth. `plan.ts` validates it and derives:

- a **structured config** the scraper uses (search query, per-cart budget, macro targets, days and order times), and
- a **natural-language brief** injected into the meal-picker's system prompt, so details that don't fit in numbers — delivery time, address, drop-off, preferred cuisines, dietary constraints, ingredients to avoid — reach the model.

Per-item macros come from LLM estimates and, when available, a local USDA SQLite nutrition database.

## Why localhost right now

Ordering needs a long-lived Node process, Steel browser sessions, secrets, and local persistent state. Serverless hosts (e.g. Vercel free) are a poor fit for multi-minute browser automation and a large local nutrition DB. For the hackathon and early product, running on your machine is the honest and reliable path.

### Keep it “24/7” on your laptop

1. Leave `npm run dev` (and/or the scheduler) running — do not close the terminal or suspend the machine if you want scheduled meals to fire.
2. Open http://localhost:3000 for the wizard/dashboard.
3. When the DoorDash/Steel login goes stale, re-run `setup-profile` / log in again in the live browser (sessions expire; relogin is expected).
4. Devs who prefer the CLI can run agent/schedule scripts directly from the repo without living in the UI.

The website process and any MCP server are separate. Keeping localhost:3000 up runs the app and (once cron lives in that process, or you also run the scheduler) the jobs. MCP is for IDE/agent tool calls, not a replacement for that always-on Node process.

## Developers vs non-developers

**Developers**

- Clone the repo, install deps, set `.env` keys, join/build nutrition data, run `setup-profile` once, then `npm run dev` and/or schedule/agent scripts.
- Easy path: run the documented scripts from the project root; keep the process open for automation.
- Optional later: an MCP server so tools like “today’s macro summary” or “send/show EOD digest” can be called from Cursor (or any MCP client) via JSON-RPC — useful when agents need a standard way to reach MacroMe without importing our TypeScript. Devs can also just run a script; MCP is the agent-integration surface, not required for core use.

**Non-developers (or UI-first users)**

- Use the website: complete onboarding, see next scheduled orders, Run now, approve in the dashboard, watch the live browser.
- End-of-day (and historical) summaries should appear on the website so they never need a terminal or MCP.

## Persistent state (JSON “database” for now)

We intentionally keep early persistence as JSON files on disk (gitignored where they hold personal data), not a hosted SQL database yet.

Goals:

- Survive restart: every `npm run dev` should still know what you already did — placed orders, fast-forwarded/completed queue items, and which meals are still coming up.
- Same for digests: EOD summaries saved so previous days remain visible after restart.

Examples already / planned:

- `macrome-config.json` — your plan (macros, meals, preferences, schedule).
- `macrome-queue-state.json` — completion history for the dated order queue so completed or fast-forwarded occurrences do not reappear as “next” after restart; upcoming ones still show.
- Future day-log / digest JSON (or similar) — per-day meals, macros, spend, for dashboard history and optional email.

This is our lightweight database until we scale.

## How we plan to scale

**Frontend:** evolve the wizard + dashboard (onboarding, live run, approvals, notifications, EOD history).

**Backend:** always-on Node (or container) host — not serverless — for Steel sessions, cron, and long jobs (e.g. Railway, Fly, Render, or a VPS). Fold scheduling into the main server where it makes sense so one process owns “site + jobs.”

**Database:** graduate from JSON files to a real database (orders, users, digests, queue) while keeping the same product semantics: persistence across restarts and clear history of what was ordered.

**MCP server (for developers / agents):** expose MacroMe capabilities as MCP tools (JSON-RPC under the hood) so coding agents can call summary/digest helpers from the IDE without custom glue per editor. When larger, a 24/7 service with a real DB powers the app; MCP is how developer tools and agents plug into that platform — not what keeps the service online by itself.

## Setup

```bash
npm install
npm install --prefix doordash-macro-agent
npm run join-nutrition-db --prefix doordash-macro-agent             # restore the bundled nutrition database
cp doordash-macro-agent/.env.example doordash-macro-agent/.env   # add your keys
npm run setup-profile                                            # log into DoorDash once
```

`setup-profile` opens a live browser you log into by hand, then saves a reusable Steel profile id into `.env`. Every later run reuses that login.

The bundled nutrition database is stored as three `nutrition.db.part-NN` files to keep each file below GitHub's file-size limit. The join command combines them in order into `doordash-macro-agent/data/nutrition.db`, which is gitignored. Run it after cloning or pulling updated chunks. No USDA download or database rebuild is needed. The agent uses matching food records for per-serving macros and falls back to model estimates when no match is found. Name matches and database serving sizes may differ from the actual restaurant dish and portion.

## Running

```bash
npm run dev     # http://localhost:3000
```

- **No plan saved yet** → `/` serves the onboarding wizard.
- **A plan exists** → `/` serves the dashboard: your plan, the next scheduled orders, a **Run now** button, and the agent's live browser in an iframe. `/setup` always reopens the wizard to edit the plan.

**Run now** takes the next dated order from **Next scheduled orders**. Once the agent reports it placed, that occurrence is removed; future repetitions stay scheduled. Completion history is saved in the gitignored `macrome-queue-state.json`, survives server restarts, and is also checked by the scheduler. Declining, failing, or running in dry-run mode does not mark it complete.

At checkout, the dashboard and terminal list every scraped cart line, quantities, prices and available modifiers, alongside DoorDash's full checkout total. The recommended dish and its macros are labeled **Agent pick**. **Place order** approves the entire cart, including any leftovers. Unreadable carts stop approval; a changed cart or total after approval stops placement. Uncertain adds are inspected before further changes. Before approval, the model can recover by reducing quantities, removing cart lines, replacing the cart with a cheaper candidate (including another restaurant), or retrying inspection. Every edit uses verified cart controls and is followed by a fresh read. The actual checkout total must fit the saved all-in budget; if fees are excluded from the budget, the cart's food line totals must fit instead. Recovery stops after eight steps or four minutes and explains the unresolved problem without placing an order.

Restaurant discovery scrolls the search results and compares up to 30 restaurants by default, with a four-minute search budget. `MACROME_MAX_STORES` can set a cap between 1 and 30. Slow or unreadable menus are skipped so other restaurants can still be considered.

Development checks: `npm test` covers the order queue and server behavior; `npm run test:checkout --prefix doordash-macro-agent` exercises checkout and the dashboard in local Chromium. The latter requires a Playwright Chromium install and its system libraries; `CHROMIUM_PATH` can select an existing executable. `npm run test:recovery --prefix doordash-macro-agent` tests budget enforcement, validated model actions, restaurant replacement and bounded retries.

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
