# MacroMe

## Flow Chart
![FlowChart](/diagram.png)

DoorDash ordering that actually respects your macros.

Tell MacroMe your calorie and protein goals, meal times, budget, and food prefs once. When a meal is due, it opens a real browser, hunts nearby restaurants, builds a cart that fits the slot, and waits for you to approve before anything is charged. Leave it running and it’ll kick off meals on schedule.

**2nd place** in the WebAgent track at [Battle of the Schools](https://www.utwat.ca) (UTMIST × Wat.ai, UofT vs Waterloo). [View Devpost](https://devpost.com/software/macrome-xm5c3r#updates)

Built with a Node web app, Steel cloud browser, Playwright, OpenRouter for meal picking, a local USDA nutrition DB, and plain JSON files on disk.

## What you get

- Setup wizard for macros, meals, schedule, budget, addresses, and preferences
- Dashboard with upcoming orders, **Run now**, live browser view, and cart approval
- Scheduler that fires meals at each order time from the same `npm run dev` process
- Live **Today** macro/spend summary, plus **Final** end-of-day digests (dashboard and optional email)
- Missed meals recorded when the laptop was asleep — never ordered late
- Optional MCP tools so Cursor, Claude Code, or Codex can read today’s summary or email a digest

Nothing is charged until you press **Place order** (unless demo place mode is on).

## How it fits together

```
Browser UI (wizard / dashboard)
        │
        ▼
   server.js  ── cron every minute ──▶ order queue, agent run, day log, digests
        │
        ▼
 macrome-config.json  ──▶  plan (macros, times, budget, prefs)
        │
        ▼
 doordash-macro-agent  ──▶  Steel session → scrape menus → pick meal → cart → approval
```

`macrome-config.json` is your plan. Queue state, day log, and digests live in separate files so a restart still knows what already happened.

## Local setup

This is the supported path today. MacroMe wants a long-lived Node process on your machine.

### 1. Install

```bash
npm install
npm install --prefix doordash-macro-agent
npm run join-nutrition-db --prefix doordash-macro-agent   # builds local nutrition.db
cp doordash-macro-agent/.env.example doordash-macro-agent/.env
```

### 2. Fill in secrets

The server loads **both**:

1. repo-root `.env`
2. `doordash-macro-agent/.env` (wins on duplicate keys)

Don’t commit `.env` files.

**Required for live DoorDash ordering**

| Variable | Purpose |
| --- | --- |
| `STEEL_API_KEY` | Cloud browser ([steel.dev](https://steel.dev)) |
| `OPENROUTER_API_KEY` | Meal picking + checkout recovery ([openrouter.ai](https://openrouter.ai)) |
| `STEEL_PROFILE_ID` | Saved DoorDash login from `npm run setup-profile` |

Without these three you can still edit the plan, but **Run now** / scheduled live orders will fail.

**Optional**

| Variable | Purpose |
| --- | --- |
| `RESEND_API_KEY` + `DIGEST_EMAIL` | Email Final digests ([resend.com](https://resend.com)) |
| `MACROME_EMAIL_FROM` | Custom From (needs a verified Resend domain for non-account inboxes) |
| `MACROME_MODEL` | OpenRouter model id (default: free Nemotron). Example: `anthropic/claude-sonnet-4` |
| `MACROME_DEMO_PLACE` | Demo place without charging (default **on**; set `0` for real payment) |
| `MACROME_MAX_STORES` | Menus to compare (default `3`; use `1` for faster demos) |
| `MACROME_SEARCH_BUDGET_SECONDS` | Discovery time budget (default `240`; try `120` for demos) |
| `MACROME_MAX_MENU_ITEMS` | Items sent to the picker (default `20`) |
| `MACROME_SESSION_TIMEOUT_MINUTES` | Steel session length (Launch is usually capped at 15) |
| `MACROME_DIGEST_TIME` | Force EOD as `HH:MM` in the plan timezone |
| `MACROME_DRY_RUN` | `1` = mock menu, no Steel / no real order |
| `MACROME_NO_CRON` | `1` = this process does not own the minute clock |
| `PORT` | Web port (default `3000`) |

### 3. Log into DoorDash once

```bash
npm run setup-profile
```

Log in in the live browser, then paste the printed `STEEL_PROFILE_ID` into `.env`. Re-run when DoorDash logs you out.

### 4. Run

```bash
npm run dev
```

Open http://localhost:3000.

1. Leave that process running if you want scheduled meals to fire (don’t sleep the machine).
2. Finish the wizard, or go straight to the dashboard if a plan already exists.
3. Use **Run now** or wait for a scheduled slot; approve in the dashboard.

### Local checklist

- [ ] Node deps installed (root + agent)
- [ ] `nutrition.db` joined
- [ ] Steel + OpenRouter keys set
- [ ] `setup-profile` done and `STEEL_PROFILE_ID` saved
- [ ] `npm run dev` left running
- [ ] For real charges: `MACROME_DEMO_PLACE=0` and a valid DoorDash payment method
- [ ] For email digests: Resend key + `DIGEST_EMAIL`

## Using the product

### Dashboard

| State | What you see |
| --- | --- |
| No plan yet | Onboarding wizard (macros, meals, budget, days, addresses, prefs) |
| Plan saved | Dashboard: plan, next orders, **Run now**, live browser, Today / digests |

Open **/setup** anytime to edit the plan.

**Run now** starts the next upcoming meal. Scheduled meals use the same approval flow.

### Approving an order

You’ll see cart lines, prices, DoorDash’s checkout total, and the **Agent pick**. **Place order** confirms the whole cart. **Don’t order** cancels without charging.

**Demo place mode** (default): approving records the meal as placed for Today and digests **without** charging DoorDash. Set `MACROME_DEMO_PLACE=0` for real checkout.

### Today and digests

**Today** is a live summary until a Final is saved. A Final is written when:

- end-of-day time hits (default: ~90 minutes after your last meal), or
- every planned meal for that day is placed (for example 3/3)

Empty days with no meal outcomes don’t get a Final. Earlier days stay under **Earlier days** after restart.

If email is configured, a new Final is emailed automatically (and can be sent early via MCP or the API). In demo place mode, the same day can be emailed again after you reset local state.

### If you were offline

Meals whose order time already passed are marked **missed**. They show up in the day summary; they are not ordered late.

## Your data (local “database”)

Personal state stays on disk and is gitignored:

| File | Contents |
| --- | --- |
| `macrome-config.json` | Plan: macros, meals, schedule, budget, addresses, prefs |
| `macrome-queue-state.json` | Completed / missed / attempted slots + last cron tick |
| `macrome-day-log.json` | Per-meal outcomes |
| `macrome-digests.json` | Saved Final summaries |
| `macrome-scheduler.lock` | Which process owns the minute clock |

Upcoming orders are computed from the plan each minute. Only lifecycle state is stored, so restarts are cheap.

**Reset a demo day** (keep the plan): delete the day log, digests, and queue state files (or clear their contents), and set queue `lastSeenAt` to now so past breakfast slots aren’t all marked missed again.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Website + schedule clock → http://localhost:3000 |
| `npm run setup-profile` | One-time DoorDash login for Steel |
| `npm run agent` | One order from the terminal |
| `npm run schedule` | Clock alone (only if you don’t want it inside `dev`) |
| `npm run mcp` | MCP server on stdio (optional) |
| `npm run seed-demo -- --digest` | Fake day data for digest UI demos |
| `MACROME_DRY_RUN=1 npm run dev` | Practice mode, no live browser |
| `npm test` | Queue, digests, scheduler, server tests |

## Optional: MCP (Cursor / Claude Code / Codex)

```bash
npm run mcp
```

| Tool | What it does |
| --- | --- |
| `get_today_summary` | Live or Final summary for a day (read-only) |
| `list_digests` | Saved Finals, newest first |
| `send_eod_digest` | Save Final if needed, then email it |

Configs in-repo: `.cursor/mcp.json`, `.mcp.json`, `.codex/config.toml`. Point another project at MacroMe with absolute paths and `cwd` set to this repo. MCP does not keep the scheduler alive; `npm run dev` still must be running for orders.

### Sandbox prerequisites and cart validation

The Codex MCP configuration uses this checkout's absolute launcher and working directory. If you move the checkout, update both paths in `.codex/config.toml`. The launcher resolves nvm's Node with a minimal PATH and keeps startup diagnostics on stderr.

On Ubuntu, run `bash scripts/setup-sandbox.sh` in a terminal with sudo access to install bubblewrap and verify user-namespace startup. On Ubuntu 24.04 the script installs the additional AppArmor profile only if the initial check fails. It follows the [official sandbox prerequisites](https://learn.chatgpt.com/docs/sandboxing) and does not disable AppArmor globally.

Required food options are selected within the item dialog using the meal goals, dietary restrictions, avoided ingredients, and food budget. Optional extras stay unchanged. Unresolved choices stop the add and appear in the HTML/JSON decision report. Customized nutrition is re-estimated for the whole serving; it is not labeled USDA verified.

Cart confirmation requires matching item lines, quantities, and selected modifiers. A timed-out or uncertain add closes its browser tab and reconciles through a fresh cart inspection before another mutation. An unreadable cart or failed cleanup stops further additions.

Run `npm test` at the root for application and MCP checks, and `npm test --prefix doordash-macro-agent` for browser, checkout, recovery, modifier, picker, and session checks. Browser tests require an installed Playwright-compatible Chromium (`CHROMIUM_PATH` can specify its executable) and its shared libraries.

`npm run trials:cart --prefix doordash-macro-agent` requests 20 cart-only attempts across five restaurants and saves a structured report. It never invokes Place Order. From the agent directory, `npm run trials:cart -- --from=reports/cart-trials-<timestamp>.json` reuses observed candidate IDs; menus are still checked live. Reconcile any uncertain prior cart before restarting trials: from the agent directory, run `node --import tsx scripts/reconcile-trial.ts reports/cart-trials-<timestamp>.json` and require `cleared: true`. Cart verification and checkout readiness are reported separately; fewer than 20 completed attempts do not establish the acceptance target.

## Why local now (not Vercel-style serverless)

Ordering needs:

- a process that stays up for the minute cron and multi-minute Steel sessions
- secrets and a DoorDash login profile
- a large local nutrition SQLite DB
- JSON persistence across restarts

Short-lived serverless functions are a poor fit. For the hackathon and personal use, **one always-on Node process on your laptop (or a small VPS) is the right shape**.

## Production and how we scale

**Today (local / single user)**

- One `npm run dev` process = website + jobs
- JSON files as the database
- Steel Launch sessions (~15 minutes)
- Human approval before charge (or demo place for pitches)

**Next (always-on for a small team)**

- Deploy the same Node process to a host that stays up (Railway, Fly, Render, or a VPS), not a serverless web-only host
- Keep one process owning site + cron (same as local)
- Move secrets to the host’s env; keep Steel profile + DoorDash login healthy
- Turn off demo place (`MACROME_DEMO_PLACE=0`) and require real payment methods
- Optional: separate worker only if you outgrow a single box

**Later (multi-user product)**

- Replace JSON files with a real database (users, plans, orders, digests, queue)
- Auth and per-user Steel profiles / DoorDash identities
- Horizontal scale behind a queue so two runs never fight one cart
- Keep MCP (or a public API) as the agent-facing surface; the always-on backend still owns browsers and cron
- Stronger models via OpenRouter where free ones time out

**What we are not aiming for first**

- Pure serverless “upload and forget” hosting for the agent itself
- Fully unsupervised ordering with no human approval

## Architecture notes (for contributors)

| Piece | Role |
| --- | --- |
| `server.js` | HTTP UI, APIs, spawns agent, runs minute cron |
| `ui/` | Wizard + dashboard |
| `doordash-macro-agent/` | Steel + Playwright scrape, pick, cart, recovery |
| `order-queue.cjs` / `day-log.cjs` / `digest.cjs` | Schedule lifecycle, meal outcomes, Finals |
| `digest-email.cjs` | Resend email for Finals |
| `mcp-server.cjs` | IDE tools over the same files |

Default meal model: `nvidia/nemotron-3-super-120b-a12b:free` via OpenRouter. Override with `MACROME_MODEL`.

## Environment quick reference

| Variable | Required? | Purpose |
| --- | --- | --- |
| `STEEL_API_KEY` | live orders | Cloud browser |
| `OPENROUTER_API_KEY` | live orders | Meal picking / recovery |
| `STEEL_PROFILE_ID` | live orders | Saved DoorDash login |
| `MACROME_MODEL` | no | OpenRouter model id |
| `RESEND_API_KEY` / `DIGEST_EMAIL` | email | Final digest mail |
| `MACROME_EMAIL_FROM` | no | Sender address |
| `MACROME_DEMO_PLACE` | no | Demo place (default on; `0` = real) |
| `MACROME_MAX_STORES` | no | Restaurants to compare |
| `MACROME_SEARCH_BUDGET_SECONDS` | no | Discovery budget |
| `MACROME_MAX_MENU_ITEMS` | no | Picker menu size |
| `MACROME_SESSION_TIMEOUT_MINUTES` | no | Browser lifetime |
| `MACROME_DIGEST_TIME` | no | EOD `HH:MM` |
| `MACROME_DRY_RUN` | no | Mock run |
| `MACROME_NO_CRON` | no | Disable clock in this process |
| `PORT` | no | Web port (default 3000) |

## Repo

https://github.com/VZhou07/MacroMe
