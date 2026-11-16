# Usage: limits and Bot token usage

Status: v1
Date: 2026-11-16

## Goal

Settings › Usage shows two things:

1. **Limits:** each provider's usage limits, grouped as "Session limits" and
   "Weekly limits" (other windows get their own card), with a thin bar, the
   percent used and when it resets.
2. **Bot usage:** how many tokens the Bots used, input and output, over 7 or
   30 days, by Bot, by source (you, routines, other Bots) or by model, with a
   daily chart.

Each Bot's Details panel gets one line, "1.2M tokens this week", that opens
the page.

## Data

- **Limits:** unchanged. They come from T3's provider status
  (`usageLimits.windows`), as today.
- **Bot tokens:** T3 records token usage on every provider turn
  (`providerTurns[].turnTokenUsage` in `orchestration.getThreadProjection`).
  A projection only holds a thread's recent turns, so reading it on demand
  would undercount a week. The gateway therefore keeps a small ledger:
  - Every 15 minutes it reads the projections of Bot threads that changed
    since the last pass, and records each finished provider turn once (keyed
    by thread and turn), with day, Bot, model, source and token counts.
  - Source: a turn whose run was started by a message with
    `scheduledTaskId` is a routine; a message created by an agent or the
    server ("From …") is another Bot; anything else is the person.
  - The ledger holds counts only, never content, in
    `<app dir>/usage/ledger.json` (mode 0600). Entries older than 90 days are
    dropped.
  - Totals cover the time since the ledger started; the page says so until
    it has 7 days.
- **Account totals:** T3's `server.getUsageSummary` counts every transcript on
  the machine per provider and model. The page shows it as one line ("Bots:
  30M of 410M tokens on this account this week") so Bot use can be compared
  with all use. Transcript paths are mapped to provider names on the server
  and never sent to the browser.

## API

`GET /api/usage/bots?days=7|30` (app login, like other `/api` routes; not a
Bot tool):

```json
{ "since": "2026-11-10", "until": "2026-11-16", "timeZone": "Europe/Istanbul",
  "ledgerSince": "2026-11-16T10:00:00Z",
  "days": ["2026-11-10", "…"],
  "rows": [{ "day": "2026-11-16", "bot": "slug", "source": "you|routine|bot", "model": "…",
             "input": 0, "cached": 0, "cacheWrite": 0, "output": 0, "turns": 0 }] }
```

The browser groups rows by Bot, source or model.

## Display rules

- Headline: input + output tokens; cached input is shown separately and
  muted, because cache reads dominate raw totals.
- Bars turn amber and say "Almost used" at 80% or more.
- Up to four series, then "Other". Colors follow the entity, not its rank.

## Not in v1

- Cost per Bot (T3 prices per provider and model, not per thread). The
  estimated total cost appears in the total's tooltip when T3 allows it.
- History before the ledger started.
- A project filter in T3's usage summary (would remove the ledger; a T3
  change).

## Acceptance

- Unit: turn classification (you, routine, other Bot), dedupe across passes,
  day bucketing in the person's time zone, 90-day pruning, the API grouping,
  path-to-provider mapping.
- Live: the page on the real gateway shows today's Bot turns within one pass,
  the 7/30 switch and the three groupings work, limits show Session and
  Weekly cards, and the Details line matches the page.
