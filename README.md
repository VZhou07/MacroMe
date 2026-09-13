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

server.js ──every minute──▶ scheduler-core.cjs
                              ├─▶ order-queue.cjs   → what is due, what was missed
                              ├─▶ the agent          → one run, approved in the dashboard
                              ├─▶ day-log.cjs        → what actually happened, meal by meal
                              └─▶ digest.cjs         → one saved summary per day
```

`macrome-config.json` is the source of truth. `plan.ts` validates it and derives:

- a **structured config** the scraper uses (search query, per-cart budget, macro targets, days and order times), and
- a **natural-language brief** injected into the meal-picker's system prompt, so details that don't fit in numbers — delivery time, address, drop-off, preferred cuisines, dietary constraints, ingredients to avoid — reach the model.

Per-item macros come from LLM estimates and, when available, a local USDA SQLite nutrition database.

## Why localhost right now

Ordering needs a long-lived Node process, Steel browser sessions, secrets, and local persistent state. Serverless hosts (e.g. Vercel free) are a poor fit for multi-minute browser automation and a large local nutrition DB. For the hackathon and early product, running on your machine is the honest and reliable path.

### Keep it “24/7” on your laptop

1. Leave `npm run dev` running — do not close the terminal or suspend the machine if you want scheduled meals to fire. **That one process is enough:** the minute cron runs inside it, so it fires orders, records missed slots and writes the end-of-day digest.
2. Open http://localhost:3000 for the wizard/dashboard.
3. When the DoorDash/Steel login goes stale, re-run `setup-profile` / log in again in the live browser (sessions expire; relogin is expected).
4. Devs who prefer the CLI can run agent/schedule scripts directly from the repo without living in the UI.

`npm run schedule` still exists for anyone who would rather keep the clock in its own terminal. Running both is safe: whichever starts first takes `macrome-scheduler.lock` and the other stands by (and takes over if the holder exits), so a meal is never ordered twice. `MACROME_NO_CRON=1 npm run dev` opts the web process out of the clock entirely.

An MCP server is separate again, and optional. Keeping localhost:3000 up runs the app *and* the jobs; MCP is for IDE/agent tool calls, not a replacement for that always-on Node process.

## Developers vs non-developers

**Developers**

- Clone the repo, install deps, set `.env` keys, join/build nutrition data, run `setup-profile` once, then `npm run dev` and/or schedule/agent scripts.
- Easy path: run the documented scripts from the project root; keep the process open for automation.
- Optional: `npm run mcp` exposes “today’s macro summary” and “send the EOD digest” as MCP tools, so Cursor (or any MCP client) can reach MacroMe without importing our TypeScript. Devs can also just run a script; MCP is the agent-integration surface, not required for core use.

**Non-developers (or UI-first users)**

- Use the website: complete onboarding, see next scheduled orders, Run now, approve in the dashboard, watch the live browser.
- Today's totals, past end-of-day summaries and “a meal was missed” notices all appear on the website, so they never need a terminal or MCP.

## Persistent state (JSON “database” for now)

We intentionally keep early persistence as JSON files on disk (gitignored where they hold personal data), not a hosted SQL database yet.

Goals:

- Survive restart: every `npm run dev` should still know what you already did — placed orders, fast-forwarded/completed queue items, and which meals are still coming up.
- Same for digests: EOD summaries saved so previous days remain visible after restart.

The files, all gitignored:

| File | What it holds |
| --- | --- |
| `macrome-config.json` | Your plan: macros, meals, schedule, budget, addresses, timezone. |
| `macrome-queue-state.json` | The order queue's lifecycle — which occurrences are `completed`, `missed` or already `attempted`, plus `lastSeenAt`, the timestamp of the last cron tick. |
| `macrome-day-log.json` | One row per meal outcome: placed, declined, failed or missed, with the agent pick, cart lines, checkout total and macros. |
| `macrome-digests.json` | One saved end-of-day summary per date, keyed by plan-timezone day. |
| `macrome-scheduler.lock` | Which process currently owns the minute cron. |

**Pending orders are not a list anyone maintains.** They are recomputed from the plan's schedule and timezone every minute and on every boot, minus the occurrences recorded as completed, missed or attempted, and minus anything whose order time has already gone. That is why a restart is cheap: only the lifecycle is stored, the schedule is derived.

Old ids and rows age out — 60 days for queue ids, 90 for day-log rows — so the files the dashboard reads on every poll stay small. Digests are kept indefinitely.

This is our lightweight database until we scale.

### What happens to a meal you were offline for

On the first boot, elapsed slots from today in the plan timezone are recorded as missed. Every tick records `lastSeenAt`. On the next boot, any occurrence whose order time fell between that timestamp and now, and that was never completed or attempted, is marked **missed** and written to the day log with the reason.

Missed means *recorded*, not retried: MacroMe will not quietly order lunch at 4pm because your laptop was shut at 11:45. Missed slots drop out of “Next scheduled orders”, show up in today's card and in that day's digest, and raise a notification when they are noticed. The look-back is capped at 14 days, so a machine that was off for a month doesn't wake up and declare a hundred missed meals.

A slot that comes due while another order is still awaiting approval is recorded the same way, with its own reason — two runs would fight over one DoorDash cart.

## How we plan to scale

**Frontend:** evolve the wizard + dashboard (onboarding, live run, approvals, notifications, EOD history).

**Backend:** always-on Node (or container) host — not serverless — for Steel sessions, cron, and long jobs (e.g. Railway, Fly, Render, or a VPS). Scheduling already lives in the main server, so one process owns “site + jobs”; deploying is moving that one process somewhere that stays up.

**Database:** graduate from JSON files to a real database (orders, users, digests, queue) while keeping the same product semantics: persistence across restarts and clear history of what was ordered.

**MCP server (for developers / agents):** MacroMe's capabilities are already exposed as MCP tools (JSON-RPC under the hood) so coding agents can call summary/digest helpers from the IDE without custom glue per editor. When larger, a 24/7 service with a real DB powers the app; MCP is how developer tools and agents plug into that platform — not what keeps the service online by itself.

## Setup

```bash
npm install
npm install --prefix doordash-macro-agent
npm run join-nutrition-db --prefix doordash-macro-agent   # restore the bundled nutrition database
cp doordash-macro-agent/.env.example doordash-macro-agent/.env
# edit doordash-macro-agent/.env (and optionally a repo-root .env) — see below
npm run setup-profile                                      # log into DoorDash once
npm run dev                                                # http://localhost:3000
```

### Environment files — what to fill in

The server loads **both** (later file wins on duplicate keys):

1. repo-root `.env`
2. `doordash-macro-agent/.env`

Copy the example and fill real values. Never commit `.env` files.

#### Required for live ordering

| Variable | Where | How to get it |
| --- | --- | --- |
| `STEEL_API_KEY` | `doordash-macro-agent/.env` | [steel.dev](https://steel.dev) API key — cloud browser for DoorDash |
| `OPENROUTER_API_KEY` | `doordash-macro-agent/.env` | [openrouter.ai](https://openrouter.ai) key — meal picker + checkout recovery |
| `STEEL_PROFILE_ID` | `doordash-macro-agent/.env` | **Do not invent this.** Run `npm run setup-profile`, log into DoorDash in the live browser, then paste the printed id into `.env` |

Without these three, the dashboard wizard still works, but **Run now** / scheduled live orders will fail.

#### Optional: email digests (Resend)

Leave unset if you only want digests on the dashboard. To email each new Final:

| Variable | Required? | Notes |
| --- | --- | --- |
| `RESEND_API_KEY` | yes, to send | From [resend.com](https://resend.com) |
| `DIGEST_EMAIL` | yes, to send | Inbox(es) to notify; comma-separate for several |
| `MACROME_EMAIL_FROM` | no | Default: `MacroMe <onboarding@resend.dev>`. Until you verify a domain, Resend only delivers to **the email your Resend account was created with**. For other recipients, verify a domain and set this to an address on that domain. |

Example (root `.env` or agent `.env`):

```bash
RESEND_API_KEY=re_...
DIGEST_EMAIL=you@example.com
# MACROME_EMAIL_FROM="MacroMe <digest@yourdomain.com>"
```

#### Optional: use Claude (or another paid model) instead of the free default

Meal picking goes through **OpenRouter**, not a raw Anthropic `ANTHROPIC_API_KEY`. A Claude API key alone is not enough unless that key is on OpenRouter (or you route Claude via OpenRouter credits).

```bash
# in doordash-macro-agent/.env
OPENROUTER_API_KEY=sk-or-...          # must be able to call the model you pick
MACROME_MODEL=anthropic/claude-sonnet-4
```

There is no “Claude Sonnet 5” id in this stack — use a current OpenRouter slug such as `anthropic/claude-sonnet-4` (check [openrouter.ai/anthropic](https://openrouter.ai/anthropic) for the latest). The same `MACROME_MODEL` is used for meal selection and checkout recovery.

**Cost:** the default free model costs $0. Claude Sonnet-class models are paid per token (on the order of a few dollars per million input tokens). MacroMe only calls the model a couple of times per order with a capped menu and short JSON reply, so personal use is usually **cents per meal**, not dollars — still far more than free, and recovery retries add a little. For demos, free is fine; switch to Sonnet if the free model times out or picks poorly.

#### Optional: speed / session / digest timing

| Variable | Default | Purpose |
| --- | --- | --- |
| `MACROME_MAX_STORES` | `1` | How many successful menus to compare (max 30) |
| `MACROME_SEARCH_BUDGET_SECONDS` | `240` | Total discovery + scrape budget (`120` for shorter demos) |
| `MACROME_MAX_MENU_ITEMS` | `20` | Items sent to the picker across stores (max 60) |
| `MACROME_SESSION_TIMEOUT_MINUTES` | `15` | Requested Steel browser lifetime (plan limits still apply) |
| `MACROME_DIGEST_TIME` | last meal + 90m | Force EOD time as `HH:MM` in the plan timezone |
| `MACROME_NO_CRON` | unset | `1` = this `npm run dev` process does not own the minute clock |
| `MACROME_DRY_RUN` | unset | `1` = mock menu, no Steel / no real order |
| `PORT` | `3000` | Web server port |
| `MACROME_CONFIG` | `./macrome-config.json` | Override plan path |
| `MACROME_QUEUE_STATE` / `MACROME_DAY_LOG` / `MACROME_DIGESTS` / `MACROME_SCHEDULER_LOCK` | repo defaults | Override state file paths |

Steel session notes: Launch is typically capped at **15 minutes**; Scale/Enterprise can go longer ([Steel limits](https://docs.steel.dev/overview/pricinglimits)). MacroMe requests the minutes you set, verifies the granted lifetime, and releases the session when a run finishes. Lifetime cannot be extended on a live session.

#### Nutrition database

The bundled DB is split into `nutrition.db.part-NN` files. `npm run join-nutrition-db --prefix doordash-macro-agent` builds gitignored `doordash-macro-agent/data/nutrition.db`. Run after clone/pull. No USDA download needed. Matches may differ from real restaurant portions; the agent falls back to model estimates when there is no match.

`setup-profile` opens a live browser you log into by hand, then prints a reusable `STEEL_PROFILE_ID`. Every later run reuses that login until it goes stale (re-run setup when DoorDash logs you out).

## Running

```bash
npm run dev     # http://localhost:3000
```

- **No plan saved yet** → `/` serves the onboarding wizard.
- **A plan exists** → `/` serves the dashboard: your plan, the next scheduled orders, a **Run now** button, and the agent's live browser in an iframe. `/setup` always reopens the wizard to edit the plan.

**Run now** takes the next dated order from **Next scheduled orders**. Once the agent reports it placed, that occurrence is removed; future repetitions stay scheduled. Completion history is saved in the gitignored `macrome-queue-state.json`, survives server restarts, and is also checked by the scheduler. Each started occurrence is saved as attempted before the agent launches. Declining, failing, or running in dry-run mode does not mark it complete, but does consume that occurrence so a restart cannot automatically retry it.

Scheduled meals fire from this same process, at each meal's order time, and land in the dashboard the same way — including the approval step. Nothing is charged without someone pressing **Place order**.

### Your day, and the end-of-day digest

**Today** on the dashboard is a **live summary** until a Final digest has been saved. It is built from the day log and shows macro targets, meals, and spend so far. Macro totals cover the agent pick in placed orders, not every line in the cart. The tag reads **Live · digest at …**. Reading the summary never saves or finalizes anything; an empty day shows zero meals and zero totals and remains live.

Leaving `npm run dev` running automatically saves one **Final EOD digest** per date when due, provided that date has activity. Activity means at least one meal outcome with status **placed, declined, failed, or missed**; all four count, including days when no order was placed. Empty days produce no Final, email, or “digest ready” notification, including during boot catch-up.

The default EOD time is the last meal in that date's schedule plus 90 minutes in the plan timezone: 8:00 PM for a 6:30 PM dinner. The buffer can cross midnight. Finals are saved in `macrome-digests.json` keyed by date. Today then shows **Final**; previous dates appear under **Earlier days** and survive restarts. If the machine was asleep, catch-up saves due digests for dates with logged activity within its look-back window. A saved Final is returned unchanged on repeated requests, even if the day log later changes.

- `MACROME_DIGEST_TIME=21:30` (or `"digestTime": "21:30"` in the plan) overrides when EOD runs.
- **Save today’s digest (finalize)** is optional early finalization. It is disabled for empty days and already saved Finals. Saving early freezes that summary; it is not a live-status refresh.
- `GET /api/digests` reads today's live summary or saved Final (`final: false` or `true`) plus saved history. Empty live reads are allowed and write nothing.
- `POST /api/digests` saves a Final if activity exists, or returns the existing Final unchanged. An empty unsaved date returns HTTP **422** with “Nothing logged for YYYY-MM-DD yet — no digest to save.” Optional `email: true` uses the existing email receipt rules; repeated finalization does not repeat the ready toast.
- `npm run seed-demo -- --digest` fills a day with one placed, one declined and one missed meal and saves its Final for a demo.

**No button, MCP, or email setup is required:** users who simply leave `npm run dev` running still get automatic Final digests on the dashboard for days with activity.

**Notifications** appear as toasts when a run finishes, when a digest is written, and when slots are marked missed on reconnect. **Desktop alerts** asks the browser for permission so the same messages arrive when the tab isn't in front.

### Optional: email the digest

Covered under **Setup → Optional: email digests (Resend)** above. Set `RESEND_API_KEY` and `DIGEST_EMAIL` (and optionally `MACROME_EMAIL_FROM`) in either `.env` file.

### Optional: MCP server (Cursor, Claude Code, Codex)

```bash
npm run mcp     # stdio; for MCP clients, not for humans
```

One server (`mcp-server.cjs`) — each agent just needs its own config pointing at it:

| Client | Config file | Notes |
| --- | --- | --- |
| **Cursor** | `.cursor/mcp.json` | Reload MCP / restart Cursor after changes |
| **Claude Code** | `.mcp.json` (repo root) | Approve project MCP on first use |
| **Codex** | `.codex/config.toml` | Project must be **trusted** or Codex ignores this file |

| Tool | What it returns |
| --- | --- |
| `get_today_summary` | Read-only: the saved Final if present, otherwise a live summary, including empty days. Never saves a Final. |
| `list_digests` | Only saved Final EOD digests, newest first, one line per day |
| `send_eod_digest` | Email the saved Final, or save an early Final if activity exists and then email it. Empty unsaved days return `isError` without writing or sending. Email receipts still prevent duplicate sends. |

Example shape (all three clients use the same command):

```json
{
  "mcpServers": {
    "macrome": {
      "command": "node",
      "args": ["mcp-server.cjs"]
    }
  }
}
```

It reads the same files the dashboard does, so it reports whatever the app already knows. It does not order food, and it does not keep anything running — the app works without it.

At checkout, the dashboard and terminal list every scraped cart line, quantities, prices and available modifiers, alongside DoorDash's full checkout total. The recommended dish and its macros are labeled **Agent pick**. **Place order** approves the entire cart, including any leftovers. Unreadable carts stop approval; a changed cart or total after approval stops placement. Uncertain adds are inspected before further changes. Before approval, the model can recover by reducing quantities, removing cart lines, replacing the cart with a cheaper candidate (including another restaurant), or retrying inspection. Every edit uses verified cart controls and is followed by a fresh read. The actual checkout total must fit the saved all-in budget; if fees are excluded from the budget, the cart's food line totals must fit instead. Recovery stops after eight steps or four minutes and explains the unresolved problem without placing an order.

For demos, the current default is one successfully scraped restaurant (`MACROME_MAX_STORES=1`); discovery keeps at least three restaurant links so a failed first store has fallbacks. Menus are read sequentially, capped at 20 items per store and 45 seconds per tab. `MACROME_SEARCH_BUDGET_SECONDS` sets the total discovery/scrape budget (default 240; try 120 for demos), with time reserved for checkout inside the Steel lifetime. Navigation gets two bounded attempts; unreadable menus are skipped and their tabs closed.

`MACROME_MAX_MENU_ITEMS` caps the picker input across all restaurants (default 20, maximum 60), distributed across stores. It returns up to three meal choices, each containing one or two distinct items from one restaurant. Prices and estimated macros are summed; every selected component must be in the cart before approval. A partial add is inspected before retrying. Dietary constraints remain hard requirements; macro targets are approximate goals, not a promise of exact restaurant nutrition.

`MACROME_MODEL` selects the OpenRouter model for both picking and recovery; see **Setup** for Claude / paid-model notes. The free model remains the default. The picker makes at most two 45-second requests, disables SDK retries, caps output at 1,200 tokens, and requests reasoning off. Logs identify model, menu count, prompt size, elapsed time and HTTP failures. An empty model selection reports tight constraints separately from API timeouts.

Development checks: `npm test` covers the order queue, missed-slot reconciliation, the minute tick, digests and server behavior; `npm run test:checkout --prefix doordash-macro-agent` exercises checkout and the dashboard in local Chromium. The latter requires a Playwright Chromium install and its system libraries; `CHROMIUM_PATH` can select an existing executable. `npm run test:recovery --prefix doordash-macro-agent` tests budget enforcement, validated model actions, restaurant replacement and bounded retries.

| Command | What it does |
| --- | --- |
| `npm run dev` | Web wizard + dashboard |
| `npm run agent` | One ordering run in the terminal (approval is a yes/no prompt) |
| `npm run schedule` | Standalone cron, if you'd rather not run it inside the web process |
| `npm run mcp` | MCP server on stdio (optional) |
| `npm run seed-demo -- --digest` | Fill today with fake placed/declined/missed meals and write the digest |
| `MACROME_DRY_RUN=1 npm run dev` | Dashboard runs against a mock menu, no browser, no order |

## Environment quick reference

Full setup instructions are under **Setup** above. Short list:

| Variable | Required? | Purpose |
| --- | --- | --- |
| `STEEL_API_KEY` | for live orders | Steel remote browser |
| `OPENROUTER_API_KEY` | for live orders | Meal picker + recovery (OpenRouter) |
| `STEEL_PROFILE_ID` | for live orders | Saved DoorDash login from `setup-profile` |
| `MACROME_MODEL` | no | OpenRouter model id (default: free). e.g. `anthropic/claude-sonnet-4` |
| `RESEND_API_KEY` | to email | Resend API key |
| `DIGEST_EMAIL` | to email | Recipient(s), comma-separated |
| `MACROME_EMAIL_FROM` | no | Sender; needs a verified Resend domain for non-account inboxes |
| `MACROME_SESSION_TIMEOUT_MINUTES` | no | Requested browser lifetime (default 15) |
| `MACROME_MAX_STORES` | no | Successful menus to compare (default 1, max 30) |
| `MACROME_SEARCH_BUDGET_SECONDS` | no | Discovery + menu budget (default 240) |
| `MACROME_MAX_MENU_ITEMS` | no | Items sent to the picker (default 20, max 60) |
| `MACROME_DIGEST_TIME` | no | EOD time `HH:MM` in plan timezone |
| `MACROME_NO_CRON` | no | `1` = web process does not run the minute clock |
| `MACROME_DRY_RUN` | no | `1` = mock run, no browser / no charge |
| `MACROME_CONFIG` | no | Override plan file path |
| `MACROME_QUEUE_STATE` / `MACROME_DAY_LOG` / `MACROME_DIGESTS` / `MACROME_SCHEDULER_LOCK` | no | Override state file paths |
| `PORT` | no | Web port (default 3000) |

`macrome-config.json` holds your home address and is gitignored, along with the queue state, day log, digests, email receipts and scheduler lock.

Gitignored `macrome-digests.json.*.email.json` receipts prevent repeated digest emails for the same date and recipients (including MCP). Mail is best-effort and never blocks a run.
