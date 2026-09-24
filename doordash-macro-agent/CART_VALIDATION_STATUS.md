# Cart validation status — September 23, 2026

## September 23 Late Snack regression check

The reported Harvest Clean Eats / Thai Peanut Burrito failure was a local
modifier-policy error. The resolver required every dairy-free choice label to
literally say "vegan" or "dairy-free", so it rejected all observed wrap and
protein choices before asking the option model. It now prioritizes choices
supported by ingredient evidence and lets neutral choices reach validation;
explicit dairy remains excluded. Harvest's January 2026 allergen guide supports
its gluten-free wrap, chicken and peanut tofu add-ons, and Thai Peanut Sauce.
The source-backed rule applies only while the exact documented burrito
ingredients remain on DoorDash. The unlabeled plain Wrap is not certified by
this rule.

A new cart-only live probe selected **Gluten Free Wrap** and **Chicken**,
confirmed a single matching cart line at CA$16.95, reached a readable checkout
at **CA$25.47**, passed the agent's cart and budget checks, observed an enabled
Place Order button, and cleared the cart. No purchase was submitted. The picker
now adds distinct eligible backups when a model supplies one choice, excludes
wellness shots and desserts from full-meal candidates, rejects a condiment-sized
USDA match for a burrito, and replaces a four-field estimate copied exactly
from the macro target with a rough estimate labeled as such. This failure was
not caused by the model: the modifier filter prevented any model selection.

The final DoorDash agent suite passed **75/75** tests and the root app suite
passed **26/26**. TypeScript and `git diff --check` passed. These checks verify
cart and checkout readiness; they do not verify a completed live purchase or
measure a production success rate.

## September 23 Dinner regression check

The reported Dinner failure was reproduced and repaired. A cart-only live probe
for Mary Be Kitchen / Be Green selected three restaurant-labeled vegan sides,
confirmed one matching cart line, reached a readable DoorDash checkout at
CA$29.43, passed the agent's budget and cart verification, and observed an
enabled Place Order button. The probe cleared the cart and made no purchase.
The earlier false demo placement was corrected in the day log and digest, and
real checkout is now the default. Cookies and bulk desserts are excluded before
both model selection and fallback ranking.

A live purchase was not submitted, so the post-submission confirmation behavior
is covered by a local browser fixture. The separate 19-of-20,
five-restaurant reliability target remains unmeasured.

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

These older failure categories predate the September 23 fixes. No duplicate
additions were observed, but the incomplete historical trials do not establish
a production success rate.

## Remaining validation

The current code reached a verified checkout for each of the two reported meals,
but the 19-of-20, five-restaurant reliability target has not been run. A live
purchase still requires a user-approved checkout total. Bubblewrap remains a
local sandbox prerequisite; run `bash scripts/setup-sandbox.sh` from the repo
root in a terminal with sudo access if the configured sandbox is needed.

## Verification

Root tests passed all 26 checks, including MCP initialization and tool listing with a minimal PATH. TypeScript compilation and `git diff --check` passed. Browser fixtures use the Chromium executable under `/home/vincent/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`; missing libnspr4/libnss3 runtime packages were downloaded and extracted into `/tmp/macrome-browser-libs` without installing them system-wide. Temporary libraries may disappear between sessions.

The final agent suite passed all 75 tests. The live Harvest replay is available
as `scripts/verify-late-snack-cart.ts`; it never calls Place Order and clears
the cart on completion.
