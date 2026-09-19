# Cart validation status — September 19, 2026

The implementation is improved, but the live acceptance target of 19 verified carts in 20 attempts across five restaurants is **not met**. No orders were placed.

## Changes completed in this continuation

- Keep the base meal description separate from dialog text containing unselected options.
- Detect required quantity-button option rows, verify their selection state, and count existing quantities toward group limits and prices.
- Preserve modifier text when the entire cart row is an edit button, while excluding nested action controls.
- Reconcile uncertain checkout replacements through a fresh tab before further mutations; propagate the new tab to the caller and stop on failed reconciliation.
- Retain option-selection error details and handle interrupted trial batches with session cleanup.

The earlier implementation also contains the absolute MCP launcher configuration, required-option resolver, initial-add reconciliation, structured reports, and browser fixtures.

## Live evidence

- `reports/cart-trials-2026-09-19T21-47-57-628Z.json`: six completed attempts and a seventh interrupted attempt. One Chipotle cart was verified, reached checkout readiness, and was cleared. This batch predates quantity-button support.
- `reports/cart-trials-2026-09-19T21-54-50-207Z.json`: eight completed attempts and a ninth interrupted attempt. No verified carts. The required quantity group was detected, but selections remained unresolved. One Chipotle mutation produced a single observed item with unreadable modifier details; reconciliation cleared it instead of adding another item. This batch predates the clickable-cart-row fix and later diagnostic improvements.
- `reports/cart-trials-2026-09-19T21-54-50-207Z-reconciliation-2026-09-19T22-02-43-175Z.json`: final cart inspection confirmed empty (`cleared: true`).

Both batches were intentionally stopped. The latter report's browser-closed error is from stopping the batch, not an independently observed session-expiry defect. Do not count interrupted attempts as completed trials or missing reasons as successful adds.

Remaining live failure categories: dietary compatibility unverified, required option selection unresolved, and cart modifier verification. No duplicate additions were observed, but these incomplete trials do not establish a production success rate or prove dietary compatibility of rejected candidates.

## Remaining blockers and next steps

1. Automatic approval review rejected a separate OpenRouter diagnostic request because its payload included the user's dairy-free preference and observed menu options. That request was not sent. Obtain explicit approval for that payload and destination before making the diagnostic request. Use its result to distinguish model refusal/provider errors from browser selection failures; do not weaken dietary constraints to increase the pass rate.
2. Bubblewrap is still missing. System installation failed because sudo requires a password. Run `bash scripts/setup-sandbox.sh` from the repository root in a terminal with sudo access, then verify startup. The script follows the official sandbox prerequisites and loads the Ubuntu 24.04 AppArmor profile only if needed.
3. After resolving selection failures, run fresh live validation with the final code and current eligible menu items. Reconcile the existing cart first. The authorized trials may modify carts but must never place orders; preserve checkout approval behavior.

## Verification

Root tests passed all 26 checks, including MCP initialization and tool listing with a minimal PATH. TypeScript compilation and `git diff --check` passed. Browser fixtures use the Chromium executable under `/home/vincent/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`; missing libnspr4/libnss3 runtime packages were downloaded and extracted into `/tmp/macrome-browser-libs` without installing them system-wide. Temporary libraries may disappear between sessions.

The final agent suite passed all 60 tests; results are recorded in `/tmp/macrome-verified-tests.log`.
