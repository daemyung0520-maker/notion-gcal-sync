import { fetchKoreanHolidays } from './googleHolidays.js';
import {
  fetchExistingHolidayPages,
  createHolidayPage,
  updateHolidayPage,
  archivePage,
} from './notion.js';

const IMPORT_MONTHS_AHEAD = 18;

// 구글 "대한민국의 휴일" 캘린더에는 실제 법정 공휴일이 아닌 기념일도 섞여
// 있다 (국군의날, 크리스마스 이브 등). 구글 캘린더 화면에 뜨는지 여부로는
// 구분이 안 돼서(구글 내부 로직이라 API로 알 수 없음 — 확인해봄), 실제로
// 법정 공휴일이 아닌 게 확실한 것들만 이름으로 직접 제외한다. 이 날짜들은
// 법으로 고정이라 매년 바뀔 일이 거의 없다. 나중에 법이 바뀌면 이 목록만
// 수정하면 된다.
const NON_STATUTORY_TITLES = new Set([
  '국군의날',
  '크리스마스 이브',
  '섣달 그믐날',
  '식목일',
  '어버이날',
  '스승의날',
]);

// 설날/추석은 구글에 하루하루 개별 이벤트로 나뉘어 있지만("설날", "설날 연휴",
// "쉬는 날 설날" 등), 노션에는 "설날 연휴" 하나로 시작일~종료일 범위로 합쳐서
// 기록한다 (사용자 요청). 다른 공휴일이 연속되는 경우는 묶지 않고 그대로 둔다.
const GROUPABLE_BASE_NAMES = ['설날', '추석'];

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function expandRange(start, end) {
  const dates = [];
  let cur = start;
  while (cur <= end) {
    dates.push(cur);
    if (cur === end) break;
    cur = addDays(cur, 1);
  }
  return dates;
}

function dateRange() {
  const now = new Date();
  const fromDate = now.toISOString().slice(0, 10);

  const until = new Date(now);
  until.setUTCMonth(until.getUTCMonth() + IMPORT_MONTHS_AHEAD);
  const toDate = until.toISOString().slice(0, 10);

  return { fromDate, toDate };
}

// 설날/추석에 해당하는 이벤트들을 (연속된 날짜끼리) 묶어서 범위 항목으로,
// 나머지는 하루짜리 항목으로 만든다. 대표 ID는 클러스터의 첫 날짜 이벤트로
// 삼아 삭제 감지(reconcile)에 쓴다.
function buildDesiredEntries(googleEvents) {
  const grouped = new Map(); // baseName -> [{id, date}]
  const entries = [];

  for (const [id, { title, date }] of googleEvents) {
    const baseName = GROUPABLE_BASE_NAMES.find((name) => title.includes(name));
    if (!baseName) {
      entries.push({ title, dateStart: date, dateEnd: date, representativeId: id });
      continue;
    }
    if (!grouped.has(baseName)) grouped.set(baseName, []);
    grouped.get(baseName).push({ id, date });
  }

  for (const [baseName, items] of grouped) {
    items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    let cluster = [items[0]];
    for (let i = 1; i < items.length; i++) {
      const prevDate = cluster[cluster.length - 1].date;
      if (items[i].date === addDays(prevDate, 1)) {
        cluster.push(items[i]);
      } else {
        entries.push(clusterToEntry(baseName, cluster));
        cluster = [items[i]];
      }
    }
    entries.push(clusterToEntry(baseName, cluster));
  }

  return entries;
}

function clusterToEntry(baseName, cluster) {
  return {
    title: `${baseName} 연휴`,
    dateStart: cluster[0].date,
    dateEnd: cluster[cluster.length - 1].date,
    representativeId: cluster[0].id,
  };
}

async function run({ dryRun }) {
  const range = dateRange();

  const rawGoogleEvents = await fetchKoreanHolidays(range); // Map<eventId, {title, date}>
  const googleEvents = new Map(
    [...rawGoogleEvents].filter(([, { title }]) => !NON_STATUTORY_TITLES.has(title))
  );
  const notionPages = await fetchExistingHolidayPages(range); // [{pageId, date, dateEnd, sourceEventId, attendees}]

  const desiredEntries = buildDesiredEntries(googleEvents);
  const desiredIds = new Set(desiredEntries.map((e) => e.representativeId));
  const pagesBySourceId = new Map(
    notionPages.filter((p) => p.sourceEventId).map((p) => [p.sourceEventId, p])
  );

  // 삭제(reconcile) 대상: 이 기능이 자동으로 가져온(= GCal Event ID가 있고
  // 관계자가 비어있는) 페이지인데, 그 ID가 이번에 "유효한 대표 ID" 목록에
  // 없으면 대상이다. 여기엔 구글에서 사라진 경우, 법정 공휴일 제외 목록에 걸린
  // 경우, 그리고 설날/추석 묶음으로 통합되어 더는 개별 페이지로 필요 없어진
  // 예전 낱개 페이지(대표가 아니었던 것들)까지 전부 포함된다. 관계자가 있는
  // 페이지는 sync.js가 "9. 기념일 등"에 올리며 GCal Event ID를 적어둔 것일
  // 수 있어 건드리지 않는다.
  const toDelete = notionPages.filter(
    (p) => p.sourceEventId && p.attendees.length === 0 && !desiredIds.has(p.sourceEventId)
  );

  // 일반 중복 판단용 날짜 집합: 이 기능이 추적하지 않는 페이지(사용자가 직접
  // 쓴 것, 또는 관계자가 있어 건드리지 않는 것)만 대상으로 한다. 대표 ID로
  // 추적되는 페이지는 아래에서 정확히 1:1로 갱신/생성 여부를 판단하므로 여기
  // 포함시키지 않는다.
  const existingDates = new Set();
  for (const page of notionPages) {
    if (page.sourceEventId && page.attendees.length === 0) continue;
    for (const d of expandRange(page.date, page.dateEnd)) existingDates.add(d);
  }

  let created = 0;
  let updated = 0;

  for (const entry of desiredEntries) {
    const label =
      entry.dateStart === entry.dateEnd ? entry.dateStart : `${entry.dateStart} ~ ${entry.dateEnd}`;
    const existingMatch = pagesBySourceId.get(entry.representativeId);

    if (existingMatch) {
      // 대표 ID로 이미 추적 중인 페이지가 있음 — 제목이나 날짜 범위가 다르면
      // (예: "설날" 낱개 페이지가 "설날 연휴" 범위로 통합되는 경우) 갱신만
      // 하고 새로 만들지 않는다.
      if (
        existingMatch.date !== entry.dateStart ||
        existingMatch.dateEnd !== entry.dateEnd ||
        existingMatch.title !== entry.title
      ) {
        console.log(`[수정] "${existingMatch.title}" → "${entry.title}" (${label})`);
        if (!dryRun) {
          await updateHolidayPage(existingMatch.pageId, {
            title: entry.title,
            dateStart: entry.dateStart,
            dateEnd: entry.dateEnd,
          });
        }
        updated++;
      }
      continue;
    }

    // 대표 ID로 추적되는 페이지가 없는 완전히 새로운 항목. 그 날짜가 이미
    // (사용자가 직접 쓴) 다른 휴일 페이지로 덮여있으면 중복 생성하지 않는다.
    if (expandRange(entry.dateStart, entry.dateEnd).some((d) => existingDates.has(d))) continue;

    console.log(`[생성] "${entry.title}" (${label})`);
    if (!dryRun) {
      await createHolidayPage({
        title: entry.title,
        date: entry.dateStart,
        dateEnd: entry.dateEnd,
        sourceEventId: entry.representativeId,
      });
    }
    created++;
  }

  let removed = 0;
  for (const page of toDelete) {
    console.log(
      `[삭제 예정] 구글에서 사라졌거나 제외/통합 대상이 된 자동 생성 휴일 (노션 페이지 ${page.pageId})`
    );
    if (!dryRun) {
      await archivePage(page.pageId);
    }
    removed++;
  }

  const suffix = dryRun ? ' (dry-run: 실제로 반영하지 않았습니다)' : '';
  console.log(
    `\n휴일 가져오기 완료 — 구글 조회 ${googleEvents.size}건 / 생성 ${created}건 / 수정 ${updated}건 / 삭제 ${removed}건${suffix}`
  );
}

const dryRun = process.argv.includes('--dry-run');

run({ dryRun }).catch((err) => {
  console.error('휴일 가져오기 중 오류가 발생했습니다:', err);
  process.exitCode = 1;
});
