---
name: verify-threebot
description: Verify Threebot browser changes using the built frontend, isolated gateway fixture, screenshots, and real UI interactions.
---

## Launch

Run `npm run build --prefix web`, then `node scripts/fixture.mts --scenario executor --port 3998`. Keep stdin open. Wait for `Local URL: http://127.0.0.1:3998`. The frontend and gateway are real; T3 and Executor are synthetic services. Dismiss the initial usage-stats prompt if present.

## Doctor

Read `http://127.0.0.1:3998/api/system`. Confirm the fixture process owns the port, the browser title is Threebot, and sample Bot Alpha is visible.

## Drive

Click `button[aria-label="Connect apps"]`. Confirm the dialog and `input[aria-label="Search apps"]`. Click `.connected-count` and confirm `No connected apps yet.`. Check desktop and a 390 by 844 viewport. See the feature map for other paths.

## Evidence

Save screenshots outside the checkout, inspect them, and preserve them after cleanup. Record the action and resulting state, browser errors, and DOM measurements. The compact `.connected-count` should measure 28px high with 12px text. Confirm no unexpected account connections after filtering. Synthetic data proves UI behavior only, not OAuth or live retrieval.

## Cleanup

Close the browser tab created for the check. Send `quit` to fixture stdin. Confirm the process exits and its temporary directory is removed. Never stop the installed app or other processes. Preserve screenshot files.

## Helpers

`node scripts/fixture.mts --scenario executor --check` runs API smoke checks and cleans up automatically. It does not provide screenshot evidence.
