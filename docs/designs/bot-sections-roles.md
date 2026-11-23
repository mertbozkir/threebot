# Sections at Bot creation, and two special roles

Status: approved (2026-11-23). Bot Creator is an identity only; the badge says "Bot Creator".

## Problem

A Bot gets its section (Work, Personal, …) only after it exists: you open its menu and move it. The create dialog has no section, so new Bots land in Unassigned. Two Bots also have a job no other Bot has, and the app shows only one of them:

- **Main Bot**: the Bot that runs everything. It already exists as `primary`, shown with a star.
- **Bot Creator**: the Bot that designs and audits the other Bots. The app has no notion of it.

## Goals

1. Pick a section when creating a Bot, including typing a new one, which is added to Settings' section list.
2. A **Bot Creator** role: at most one Bot holds it. Set from the Bot's menu ("Make Bot Creator"), cleared the same way.
3. Main Bot and Bot Creator show as small labelled badges ("Main Bot", "Bot Creator") on the Bot's row, in Details, and in the create flow's section list. Both pin to the top of the sidebar, as the Main Bot does today.

## Non-goals

- Free-form tags, several labels per Bot, or filtering by label. Sections stay the only grouping.
- Restricting Bot creation to the Bot Creator. Any Bot can still create Bots; the role is an identity and placement, not a permission.
- A creation flow that hands the request to the Bot Creator in chat (possible follow-up).

## Design

- Data: `MainBotRecord` gains `creator: boolean`, like `primary`. The gateway keeps it unique: setting it on one Bot clears it on every other, in the same write. Missing means false, so old records need no migration.
- API: the existing Bot update route accepts `creator`. No new route.
- Create dialog: a section picker under the name (Unassigned, the sections from settings, "New section…" with an inline name field). On create it sends `section`, and a new name is appended to `settings.sections` first.
- Sidebar: pinned group order is Main Bot, Bot Creator, then pinned Bots. Badges reuse the existing star style; Bot Creator gets its own glyph (wand).
- Menu: "Make Bot Creator" / "Remove Bot Creator" next to "Make main Bot". The Main Bot can't also be the Bot Creator; the item is disabled on it.

## Failure modes

- Two Bots marked creator in hand-edited JSON: on load the gateway keeps the most recently updated one and clears the rest, the same rule `primary` already follows.
- The Bot Creator is hidden, archived or deleted: the role clears with it.
- A new section name that already exists (any case): reuse the existing one, no duplicate.

## Tests

- Server: creator stays unique across set, load and delete; missing field reads false.
- Web: create dialog sends the chosen or new section; a new section appears in settings once; menu toggles the role; pinned order is Main Bot, Bot Creator, pinned.
- Real path: create a Bot into a new section in the running app and screenshot the sidebar and the badges.
