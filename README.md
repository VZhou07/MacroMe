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

**Run now** takes the next dated order from **Next scheduled orders**. Once the agent reports it placed, that occurrence is removed; future repetitions stay scheduled. Completion history is saved in the gitignored `macrome-queue-state.json`, survives server restarts, and is also checked by the scheduler. Each started occurrence is saved as attempted before the agent launches. Declining, failing, or running in dry-run mode does not mark it complete, but does consume that occurrence so a restart cannot automatically retry it.

Scheduled meals fire from this same process, at each meal's order time, and land in the dashboard the same way — including the approval step. Nothing is charged without someone pressing **Place order**.

### Your day, and the end-of-day digest

**Today** on the dashboard shows the day so far: one meter per macro against your daily target, and every meal that was ordered, declined, failed or missed, with the agent pick, the restaurant and the exact checkout total. Macro totals cover the agent pick in each placed order, not every line in the cart.

The digest is written once per day, at the last meal's time in that date's schedule plus 90 minutes (even if the buffer crosses midnight) (so 8:00 PM for a 6:30 PM dinner), and saved to `macrome-digests.json` keyed by date. Once written the card is marked **Final** and the day drops into **Earlier days**, which survives restarts. If the machine was asleep at that time, the digest is written on the next boot instead — including for days further back.

- `MACROME_DIGEST_TIME=21:30` (or `"digestTime": "21:30"` in the plan) overrides when it runs.
- **Summarise today** finalizes the digest immediately; repeated requests return the saved copy without changing it, which is also how to demo it without waiting.
- `npm run seed-demo -- --digest` fills a day with one placed, one declined and one missed meal so the card and history have something to show.

**Notifications** appear as toasts when a run finishes, when a digest is written, and when slots are marked missed on reconnect. **Desktop alerts** asks the browser for permission so the same messages arrive when the tab isn't in front.

### Optional: email the digest

Set both and each new digest is mailed as it is written:

```bash
RESEND_API_KEY=re_...          # https://resend.com
DIGEST_EMAIL=you@example.com   # comma-separate for several
MACROME_EMAIL_FROM="MacroMe <digest@yourdomain.com>"   # optional
```

Until you verify a domain, MacroMe sends from Resend's shared `onboarding@resend.dev`, and Resend will only deliver to **the address your Resend account was created with** — any other recipient comes back as a 403 explaining exactly that. That is enough to demo; for anyone else's inbox, verify a domain at resend.com/domains and point `MACROME_EMAIL_FROM` at it.

Gitignored `macrome-digests.json.*.email.json` receipts prevent repeated sends for the same date and recipients, including through MCP and after restart. If delivery times out or the process exits mid-send, the receipt stays unconfirmed and automatic resend is suppressed because delivery may already have happened.

Mail is best-effort and never blocks a run: the digest is already on disk and on the dashboard by the time it is attempted, and a failure is reported as a notification (carrying Resend's own message) rather than an error.

### Optional: MCP server

```bash
npm run mcp     # stdio; for MCP clients, not for humans
```

| Tool | What it returns |
| --- | --- |
| `get_today_summary` | Macros vs target, spend and every meal for a day (defaults to today; running total before the digest is written) |
| `list_digests` | Saved end-of-day digests, newest first, one line per day |
| `send_eod_digest` | Writes a day's digest and emails it, reporting what happened either way |

In Cursor, `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "macrome": {
      "command": "node",
      "args": ["/absolute/path/to/GooseGPT/mcp-server.cjs"]
    }
  }
}
```

It reads the same files the dashboard does, so it reports whatever the app already knows. It does not order food, and it does not keep anything running — the app works without it.

At checkout, the dashboard and terminal list every scraped cart line, quantities, prices and available modifiers, alongside DoorDash's full checkout total. The recommended dish and its macros are labeled **Agent pick**. **Place order** approves the entire cart, including any leftovers. Unreadable carts stop approval; a changed cart or total after approval stops placement. Uncertain adds are inspected before further changes. Before approval, the model can recover by reducing quantities, removing cart lines, replacing the cart with a cheaper candidate (including another restaurant), or retrying inspection. Every edit uses verified cart controls and is followed by a fresh read. The actual checkout total must fit the saved all-in budget; if fees are excluded from the budget, the cart's food line totals must fit instead. Recovery stops after eight steps or four minutes and explains the unresolved problem without placing an order.

Restaurant discovery scrolls the search results and compares up to 30 restaurants by default, with a four-minute search budget. `MACROME_MAX_STORES` can set a cap between 1 and 30. Slow or unreadable menus are skipped so other restaurants can still be considered.

Development checks: `npm test` covers the order queue, missed-slot reconciliation, the minute tick, digests and server behavior; `npm run test:checkout --prefix doordash-macro-agent` exercises checkout and the dashboard in local Chromium. The latter requires a Playwright Chromium install and its system libraries; `CHROMIUM_PATH` can select an existing executable. `npm run test:recovery --prefix doordash-macro-agent` tests budget enforcement, validated model actions, restaurant replacement and bounded retries.

| Command | What it does |
| --- | --- |
| `npm run dev` | Web wizard + dashboard |
| `npm run agent` | One ordering run in the terminal (approval is a yes/no prompt) |
| `npm run schedule` | Standalone cron, if you'd rather not run it inside the web process |
| `npm run mcp` | MCP server on stdio (optional) |
| `npm run seed-demo -- --digest` | Fill today with fake placed/declined/missed meals and write the digest |
| `MACROME_DRY_RUN=1 npm run dev` | Dashboard runs against a mock menu, no browser, no order |

## Environment

| Variable | Purpose |
| --- | --- |
| `STEEL_API_KEY` | Steel remote browser |
| `OPENROUTER_API_KEY` | The model that picks the meal |
| `STEEL_PROFILE_ID` | Saved DoorDash login, written by `setup-profile` |
| `MACROME_CONFIG` | Override the plan file path |
| `MACROME_MAX_STORES` | Restaurants to compare per run (default 30, max 30) |
| `MACROME_NO_CRON` | Set to `1` to stop the web process owning the clock |
| `MACROME_DIGEST_TIME` | When the end-of-day digest runs, `HH:MM` in the plan timezone |
| `RESEND_API_KEY` / `DIGEST_EMAIL` | Both required to email digests; `MACROME_EMAIL_FROM` sets the sender |
| `MACROME_QUEUE_STATE` / `MACROME_DAY_LOG` / `MACROME_DIGESTS` / `MACROME_SCHEDULER_LOCK` | Override where each state file lives |

`macrome-config.json` holds your home address and is gitignored, along with the queue state, day log, digests and scheduler lock.
