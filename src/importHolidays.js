import { fetchKoreanHolidays } from './googleHolidays.js';
import { fetchExistingHolidayPages, createHolidayPage, archivePage } from './notion.js';

const IMPORT_MONTHS_AHEAD = 12;

function dateRange() {
  const now = new Date();
  const fromDate = now.toISOString().slice(0, 10);

  const until = new Date(now);
  until.setUTCMonth(until.getUTCMonth() + IMPORT_MONTHS_AHEAD);
  const toDate = until.toISOString().slice(0, 10);

  return { fromDate, toDate };
}

async function run({ dryRun }) {
  const range = dateRange();

  const googleEvents = await fetchKoreanHolidays(range); // Map<eventId, {title, date}>
  const notionPages = await fetchExistingHolidayPages(range); // [{pageId, date, sourceEventId}]

  const existingDates = new Set(notionPages.map((p) => p.date));

  let created = 0;
  let removed = 0;

  // 생성: 구글엔 있는데 노션엔 그 날짜에 아무 휴일 페이지도 없는 경우만.
  for (const [sourceEventId, { title, date }] of googleEvents) {
    if (existingDates.has(date)) continue;

    console.log(`[생성] "${title}" (${date})`);
    if (!dryRun) {
      await createHolidayPage({ title, date, sourceEventId });
    }
    created++;
  }

  // 삭제(reconcile): 이 기능이 자동으로 가져온(= GCal Event ID가 있고 관계자가
  // 비어있는) 페이지인데, 그 원본 구글 이벤트가 더 이상 이번 조회 범위에 없으면
  // 휴지통으로 이동. 관계자가 있는 페이지는 GCal Event ID가 있어도 건드리지
  // 않는다 — sync.js가 "9. 기념일 등"에 올리며 적어둔 값일 수 있기 때문
  // (같은 필드를 다른 용도로 재사용하는 데서 오는 충돌을 여기서 피한다).
  for (const page of notionPages) {
    if (!page.sourceEventId || page.attendees.length > 0) continue;
    if (googleEvents.has(page.sourceEventId)) continue;

    console.log(`[삭제 예정] 구글에서 사라진 자동 생성 휴일 (노션 페이지 ${page.pageId})`);
    if (!dryRun) {
      await archivePage(page.pageId);
    }
    removed++;
  }

  const suffix = dryRun ? ' (dry-run: 실제로 반영하지 않았습니다)' : '';
  console.log(
    `\n휴일 가져오기 완료 — 구글 조회 ${googleEvents.size}건 / 생성 ${created}건 / 삭제 ${removed}건${suffix}`
  );
}

const dryRun = process.argv.includes('--dry-run');

run({ dryRun }).catch((err) => {
  console.error('휴일 가져오기 중 오류가 발생했습니다:', err);
  process.exitCode = 1;
});
