# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A one-shot Node.js script that syncs schedule entries from a specific Notion database ("대명 창고" / Schedule) to specific Google Calendars, based on a category field. It is triggered on a schedule by GitHub Actions (`.github/workflows/sync.yml`), not run as a long-lived process.

## Commands

```bash
npm install              # install dependencies
npm run sync:dry-run     # preview what would be created/updated, no writes (Notion or Google)
npm run sync             # run the real sync
npm run get-google-token # one-time local OAuth flow to obtain a Google refresh token
```

There is no lint or test suite configured. Syntax-check a file with `node --check <file>` if needed.

Local runs read credentials from `.env` (see `.env.example`). The GitHub Actions workflow injects the same variables from repo Secrets instead.

## Architecture

- `src/config.js` — loads/validates env vars and defines fixed constants tied to this specific Notion workspace and Google account: the Notion data source ID, the category-to-Google-Calendar mapping, and the four category page IDs (업무/개인/자기개발/휴일). These IDs are not generic — they point at real pages in the user's "구분 색상" Notion data source.
- `src/notion.js` — talks to the Notion REST API directly via `fetch` (Notion-Version `2025-09-03`), not the `@notionhq/client` SDK, so it can use the newer `data_sources` query endpoint for multi-source databases. Queries pages with `Date >= config.syncCutoffDate` and writes the `GCal Event ID` rich_text property back after creating an event.
- `src/googleCalendar.js` — thin wrapper around `googleapis` `calendar.events.insert/update`, using an OAuth2 client built from a stored refresh token (not a service account — personal Gmail calendars aren't reachable via service accounts). Every event it writes carries `extendedProperties.private = { source: 'notion-gcal-sync', notionPageId }` so script-created events can be identified later even though that field isn't visible in the Calendar UI.
- `src/sync.js` — the matching/branching logic: resolves a Notion page's category **by comparing the raw relation page ID** (`구분(선택)`), not the rollup display string (`구분`) or any select label. This is deliberate — the rollup mirrors the relation and is empty whenever the relation is, and comparing display strings was the source of a matching bug in a prior Make.com implementation of this same sync. Also computes the all-day date range, converting Notion's inclusive end date to Google Calendar's exclusive end date (+1 day).
- `src/index.js` — CLI entrypoint; `--dry-run` skips all Notion/Google writes and only logs what would happen.
- `scripts/get-google-token.js` — standalone (does not import `src/config.js`, to avoid its required-env-var checks) local script that runs a loopback HTTP server on port 53682 to complete a Desktop-app OAuth flow and print a refresh token.

### Notion data model gotchas

- `구분(선택)` is a **relation** to a separate "구분 색상" data source, not a select field. `구분` is a rollup mirroring it. The Notion integration used by this script must be explicitly shared with **both** the "대명 창고" data source and the "구분 색상" data source — if the integration only has access to the former, the API silently returns an empty relation array for `구분(선택)` (matching values are still visible in the Notion UI, which can be misleading when debugging).
- Only pages with `Date >= SYNC_CUTOFF_DATE` are ever fetched, so past entries are structurally excluded rather than filtered after the fact.
- Categories `자기개발` and `휴일` are intentionally not synced to any calendar; `resolveCalendar()` in `src/sync.js` returns `null` for them.
