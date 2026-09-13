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
cp doordash-macro-agent/.env.example doordash-macro-agent/.env   # add your keys
npm run setup-profile                                            # log into DoorDash once
```

`setup-profile` opens a live browser you log into by hand, then saves a reusable
Steel profile id into `.env`. Every later run reuses that login.

## Running

```bash
npm run dev     # http://localhost:3000
```

- **No plan saved yet** → `/` serves the onboarding wizard.
- **A plan exists** → `/` serves the dashboard: your plan, the next scheduled
  orders, a **Run now** button, and the agent's live browser in an iframe.
  `/setup` always reopens the wizard to edit the plan.

When the agent reaches checkout it pauses and the dashboard shows the item,
its macros and the checkout total with **Place order** / **Don't order**. Nothing
is ever charged without that click.

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
| `MACROME_MAX_STORES` | Restaurants to scrape per run (default 2) |

`macrome-config.json` holds your home address and is gitignored.
