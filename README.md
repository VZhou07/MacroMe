# MacroMe

MacroMe finds DoorDash meals that fit your macros, then waits for you to approve before anything gets charged.

You set calorie and macro goals, meal times, budget, delivery details, and food preferences once. After that, MacroMe looks at nearby restaurants, picks something that fits that meal’s targets, shows you the live cart, and waits for your OK. Leave it running and it’ll kick off scheduled meals when they’re due.

## Who it’s for

People who want DoorDash without hunting for high-protein (or otherwise on-target) meals every time. It’s a good fit if you’re okay leaving a small app running on your computer so orders can start on schedule.

Most of the time you’ll live in the website: onboarding, **Run now**, approving carts, and checking today’s progress plus past day summaries.

## Quick start

```bash
npm install
npm install --prefix doordash-macro-agent
npm run join-nutrition-db --prefix doordash-macro-agent
cp doordash-macro-agent/.env.example doordash-macro-agent/.env
# add your keys (see Setup below)
npm run setup-profile    # log into DoorDash once in the live browser
npm run dev              # open http://localhost:3000
```

1. Leave `npm run dev` running if you want scheduled meals to fire. Don’t close the terminal or put the machine to sleep.
2. Open http://localhost:3000. Finish the setup wizard, or jump to the dashboard if you already have a plan.
3. If DoorDash logs you out later, run `npm run setup-profile` again and update `STEEL_PROFILE_ID`.

## Using the dashboard

- **No plan yet:** the onboarding wizard walks you through macros, meals, budget, days, addresses, and food preferences.
- **Plan saved:** the dashboard shows your plan, upcoming orders, **Run now**, and the live browser when a run is active. Open **/setup** anytime to edit the plan.

**Run now** starts the next upcoming meal. Scheduled meals use the same flow at each meal’s order time. Nothing is charged until you press **Place order**, unless demo place mode is on (see below).

### Today and end-of-day summary

**Today** updates as meals get placed, declined, missed, or fail. You’ll see macro progress and each meal’s outcome.

A **Final** day summary is saved automatically when:

- the end-of-day time arrives (by default, about 90 minutes after your last meal), or
- every planned meal for that day has been placed (for example 3 of 3).

Earlier days show up under **Earlier days** and stick around after you restart. Empty days with no meal activity don’t get a Final.

You’ll get notifications (toasts, and optional desktop alerts) when a run finishes, a digest is ready, or a meal was missed while you were away.

### If you were offline

If a meal’s order time already passed while MacroMe wasn’t running, it’s marked **missed**. That means it shows up in your day summary, not that it gets ordered late. MacroMe won’t place lunch at 4pm just because the laptop was asleep at 11:45.

## Setup

### Keys and login

The app reads both:

1. repo-root `.env`
2. `doordash-macro-agent/.env` (this one wins if a key appears in both)

Copy the example file and fill in real values. Don’t commit `.env` files.

#### Required for live ordering

| Variable | Where | What it’s for |
| --- | --- | --- |
| `STEEL_API_KEY` | `doordash-macro-agent/.env` | Cloud browser for DoorDash ([steel.dev](https://steel.dev)) |
| `OPENROUTER_API_KEY` | `doordash-macro-agent/.env` | Chooses meals and helps with checkout ([openrouter.ai](https://openrouter.ai)) |
| `STEEL_PROFILE_ID` | `doordash-macro-agent/.env` | Your saved DoorDash login from `npm run setup-profile` (paste the id it prints) |

Without these three, you can still fill out the plan, but live ordering won’t work.

#### Optional: email day summaries

| Variable | Needed to send? | Notes |
| --- | --- | --- |
| `RESEND_API_KEY` | yes | From [resend.com](https://resend.com) |
| `DIGEST_EMAIL` | yes | Where summaries go (comma-separate for more than one) |
| `MACROME_EMAIL_FROM` | no | The default shared sender only delivers to your Resend account email until you verify a domain |

```bash
RESEND_API_KEY=re_...
DIGEST_EMAIL=you@example.com
# MACROME_EMAIL_FROM="MacroMe <digest@yourdomain.com>"
```

#### Optional: a stronger meal-picking model

Meal picking goes through OpenRouter. To use Claude or another paid model, set an OpenRouter model id:

```bash
OPENROUTER_API_KEY=sk-or-...
MACROME_MODEL=anthropic/claude-sonnet-4
```

The free default costs nothing. Paid models usually land at only cents per meal for MacroMe’s short requests. Current ids are listed at [openrouter.ai/anthropic](https://openrouter.ai/anthropic).

#### Optional tuning

| Variable | Default | What it does |
| --- | --- | --- |
| `MACROME_MAX_STORES` | `3` | How many restaurant menus to compare (max 30) |
| `MACROME_SEARCH_BUDGET_SECONDS` | `240` | How long discovery may take (`120` for a shorter demo) |
| `MACROME_MAX_MENU_ITEMS` | `20` | How many dishes the picker sees (max 60) |
| `MACROME_SESSION_TIMEOUT_MINUTES` | `15` | Browser session length (your Steel plan may cap this) |
| `MACROME_DIGEST_TIME` | last meal + 90m | End-of-day time as `HH:MM` in your plan timezone |
| `MACROME_DEMO_PLACE` | on | Demo mode: **Place order** counts as placed without charging DoorDash. Set `0` for real checkout |
| `MACROME_DRY_RUN` | unset | `1` = practice mode with a mock menu, no live browser |
| `MACROME_NO_CRON` | unset | `1` = this process won’t run the schedule clock |
| `PORT` | `3000` | Website port |

Browser sessions usually last up to **15 minutes** on Steel’s Launch plan. Longer needs a higher plan. MacroMe opens a session for each run and closes it when finished.

Nutrition data ships as split files. After you clone, run `npm run join-nutrition-db --prefix doordash-macro-agent` to build the local database. Estimates are approximate, since restaurant portions vary.

## Approving an order

When a cart is ready you’ll see every line, prices, and DoorDash’s checkout total. The suggested dish is labeled **Agent pick**. **Place order** confirms the whole cart. **Don’t order** cancels that attempt without charging.

In demo place mode (the hackathon default), approving records the meal as placed for Today and digests without a real DoorDash charge. Set `MACROME_DEMO_PLACE=0` when you want real payment checks.

## Your data on disk

Your plan and history live in local files. Personal ones stay out of git:

| File | Contents |
| --- | --- |
| `macrome-config.json` | Your plan (macros, meals, budget, addresses, preferences) |
| `macrome-queue-state.json` | Which scheduled slots are done, missed, or already tried |
| `macrome-day-log.json` | What happened each meal |
| `macrome-digests.json` | Saved day summaries |
| `macrome-scheduler.lock` | Makes sure only one clock is running |

Upcoming orders are calculated from your plan each minute. After a restart, MacroMe still knows what you already completed or missed.

## Commands

| Command | What you get |
| --- | --- |
| `npm run dev` | Website + schedule clock at http://localhost:3000 |
| `npm run agent` | One order from the terminal |
| `npm run schedule` | Schedule clock alone (only if you don’t want it inside `dev`) |
| `npm run setup-profile` | One-time DoorDash login for the cloud browser |
| `npm run seed-demo -- --digest` | Sample day data for trying the summary UI |
| `MACROME_DRY_RUN=1 npm run dev` | Dashboard practice mode, no live order |

## Optional: ask MacroMe from your coding app

If you use Cursor, Claude Code, or Codex, you can hook up the optional MacroMe tools (`get_today_summary`, `list_digests`, `send_eod_digest`) with:

| App | Config |
| --- | --- |
| Cursor | `.cursor/mcp.json` |
| Claude Code | `.mcp.json` |
| Codex | `.codex/config.toml` (project must be trusted) |

```bash
npm run mcp
```

Totally optional. The website and schedule work fine without it.

## Environment quick reference

| Variable | Required? | Purpose |
| --- | --- | --- |
| `STEEL_API_KEY` | for live orders | Cloud browser |
| `OPENROUTER_API_KEY` | for live orders | Meal picking |
| `STEEL_PROFILE_ID` | for live orders | Saved DoorDash login |
| `MACROME_MODEL` | no | OpenRouter model id (default: free) |
| `RESEND_API_KEY` / `DIGEST_EMAIL` | to email | Day summary email |
| `MACROME_EMAIL_FROM` | no | Email sender |
| `MACROME_DEMO_PLACE` | no | Demo place without charging (default on; `0` = real checkout) |
| `MACROME_MAX_STORES` | no | Restaurants to compare |
| `MACROME_SEARCH_BUDGET_SECONDS` | no | Discovery time budget |
| `MACROME_MAX_MENU_ITEMS` | no | Dishes sent to the picker |
| `MACROME_DIGEST_TIME` | no | End-of-day time |
| `MACROME_DRY_RUN` | no | Mock run |
| `PORT` | no | Website port (default 3000) |
