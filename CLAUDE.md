# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Two independent one-shot Node.js scripts, both triggered on a schedule by GitHub Actions rather than run as long-lived processes:

- **`src/index.js`** — syncs schedule entries from a specific Notion database ("대명 창고" / Schedule) to specific Google Calendars, based on a category field. Runs every 15 minutes (`.github/workflows/sync.yml`) — widened from 5 minutes because GitHub throttles/delays very frequent schedule triggers more heavily.
- **`src/importHolidays.js`** — imports Korean public holidays from Google's built-in "대한민국의 휴일" calendar into the same Notion database, in the opposite direction. Runs once a day (`.github/workflows/import-holidays.yml`).

These two flows are deliberately kept from feeding back into each other in a loop — see "Notion data model gotchas" below.

## Commands

```bash
npm install                    # install dependencies
npm run sync:dry-run           # preview Notion -> Google sync, no writes
npm run sync                   # run the real Notion -> Google sync
npm run import-holidays:dry-run # preview Google holidays -> Notion import, no writes
npm run import-holidays        # run the real holiday import
npm run get-google-token       # one-time local OAuth flow to obtain a Google refresh token
```

There is no lint or test suite configured. Syntax-check a file with `node --check <file>` if needed.

Local runs read credentials from `.env` (see `.env.example`). The GitHub Actions workflows inject the same variables from repo Secrets instead. Both workflows require the full secret set even though `import-holidays` doesn't use all of it — `src/config.js` validates every variable eagerly at import time regardless of which script is running.

## Architecture

- `src/config.js` — loads/validates env vars and defines fixed constants tied to this specific Notion workspace and Google account: the Notion data source ID, the category-to-Google-Calendar mapping (업무/개인/데이트/기념일), the four category page IDs (업무/개인/자기개발/휴일), and two tag constants (`partnerTag` = 세지💕, `selfTag` = 배대명). These IDs are not generic — they point at real pages in the user's "구분 색상" Notion data source.
- `src/notion.js` — talks to the Notion REST API directly via `fetch` (Notion-Version `2025-09-03`), not the `@notionhq/client` SDK, so it can use the newer `data_sources` query/create endpoints for multi-source databases. Holds functions for both sync directions: `fetchUpcomingSchedules`/`writeGCalEventId` for the outbound sync, and `fetchExistingHolidayPages`/`createHolidayPage`/`updateHolidayPage`/`archivePage` for the holiday import.
- `src/googleCalendar.js` — wrapper around `googleapis` `calendar.events.*`, using an OAuth2 client built from a stored refresh token (not a service account — personal Gmail calendars aren't reachable via service accounts). Exports the authenticated `calendar` client so `googleHolidays.js` can reuse it. Every event `upsertAllDayEvent` writes carries `extendedProperties.private = { source: 'notion-gcal-sync', notionPageId }`, invisible in the Calendar UI, used by `listSyncedEventIds` to find and reconcile/delete events whose Notion source has disappeared or changed category. `upsertAllDayEvent` falls back from `update` to `insert` on a 404 (event no longer exists in the target calendar — happens when a page's category change moves it to a different calendar).
- `src/sync.js` — the Notion → Google matching/branching logic (`resolveCalendar`): resolves a page's category **by comparing the raw relation page ID** (`구분(선택)`), not the rollup display string (`구분`) or any select label — comparing display strings was the source of a matching bug in a prior Make.com implementation of this sync. Prepends the Notion page's emoji icon to the calendar event title, but only for 개인/데이트 events (`ICON_PREFIX_LABELS`), never 업무. After an `upsert`, only re-writes `GCal Event ID` back to Notion when the returned event ID actually changed (needed because of the update→insert fallback above; skipping this check was a real bug that caused duplicate event creation on every run once a page's category changed).
- `src/index.js` — CLI entrypoint for the sync direction; `--dry-run` skips all Notion/Google writes and only logs what would happen.
- `src/googleHolidays.js` — fetches events from Google's `ko.south_korea#holiday@group.v.calendar.google.com` calendar for a given date window, reusing the shared `calendar` client.
- `src/importHolidays.js` — CLI entrypoint and orchestration for the holiday import direction; `--dry-run` works the same way as `index.js`. See "Holiday import direction" below for the non-obvious parts.
- `scripts/get-google-token.js` — standalone (does not import `src/config.js`, to avoid its required-env-var checks) local script that runs a loopback HTTP server on port 53682 to complete a Desktop-app OAuth flow and print a refresh token.

### Notion data model gotchas

- `구분(선택)` is a **relation** to a separate "구분 색상" data source, not a select field. `구분` is a rollup mirroring it. The Notion integration used by this script must be explicitly shared with **both** the "대명 창고" data source and the "구분 색상" data source — if the integration only has access to the former, the API silently returns an empty relation array for `구분(선택)` (matching values are still visible in the Notion UI, which can be misleading when debugging).
- Only pages with `Date >= SYNC_CUTOFF_DATE` are ever fetched by the sync direction, so past entries are structurally excluded rather than filtered after the fact.
- Categories `자기개발` and (by default) `휴일` are not synced to any calendar; `resolveCalendar()` in `src/sync.js` returns `null` for them. The exception is `휴일` pages where `관계자` includes `selfTag` (배대명) — those go to the "9. 기념일 등" calendar.
- **The `GCal Event ID` property is overloaded on purpose, and the two uses must never collide.** For 업무/개인/데이트/기념일-routed pages, `sync.js` writes the *outbound* Google Calendar event ID it created. For pages created by `importHolidays.js`, the same field instead stores the *inbound* source event ID from Google's holiday calendar. This works because holiday pages created by the importer always leave `관계자` empty, which keeps them out of `resolveCalendar()`'s outbound path entirely. Any code that reads `GCal Event ID` to decide whether a page was "auto-imported by the holiday importer" **must also check that `관계자` is empty** (see `fetchExistingHolidayPages` callers in `importHolidays.js`) — otherwise a 휴일+배대명 page synced out to "9. 기념일 등" looks identical to an imported holiday and gets wrongly deleted.

### Holiday import direction (`src/importHolidays.js`)

- Google's holiday calendar has centuries of events, so every fetch is bounded to a rolling window (`fromDate`=today, `toDate`=today+`IMPORT_MONTHS_AHEAD` months). Re-running daily is what lets a short window still cover the future — no need to fetch far ahead in one go.
- `NON_STATUTORY_TITLES` hardcodes a short blacklist (국군의날, 크리스마스 이브, 섣달 그믐날, 식목일, 어버이날, 스승의날) of entries Google's calendar includes that aren't actual statutory holidays. There is no reliable API signal for this — Google's own `description` field ("공휴일" vs "기념일") does not match what Google's own Calendar UI shows or hides (confirmed by testing: "새해첫날" is described as "기념일" but *is* shown), so filtering must be done by title.
- 설날 and 추석 are special-cased (`GROUPABLE_BASE_NAMES`): Google lists each as several single-day events (e.g. "설날", "설날 연휴", "쉬는 날 설날" on consecutive days), but this codebase merges consecutive same-base-name days into one Notion page titled `"{baseName} 연휴"` with a start/end date range. Only true date-adjacency triggers merging — a holiday and its substitute-holiday counterpart with a gap (e.g. 광복절 Sat + 쉬는 날 광복절 Mon, skipping Sunday) are intentionally left as separate single-day pages.
- Dedup/reconcile is ID-based, not date-based, for anything the importer previously created: each cluster (or single day) has one "representative" source event ID (the earliest date in the cluster). An existing Notion page is matched by comparing its stored `GCal Event ID` against that representative ID — if found, it's updated in place (title/date range) rather than duplicated; if a previously-tracked page's ID is no longer any current entry's representative (event vanished from Google, hit the blacklist, or got absorbed into a new 설날/추석 cluster), it's archived. Manually-authored 휴일 pages (empty `GCal Event ID`) are never touched by this reconcile step, and only participate in a coarser date-overlap check to avoid creating duplicates of them.
