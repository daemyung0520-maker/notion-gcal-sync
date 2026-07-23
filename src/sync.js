import { config } from './config.js';
import { fetchUpcomingSchedules, writeGCalEventId } from './notion.js';
import { upsertAllDayEvent, listSyncedEventIds, deleteEvent } from './googleCalendar.js';

// "구분(선택)" relation의 원본 페이지 ID로 캘린더를 결정한다 (롤업 문자열 비교 X).
function resolveCalendar({ categoryPageId, attendees }) {
  if (categoryPageId === config.categoryPageIds.업무) {
    return { calendarId: config.calendars.업무, label: '1. 업무' };
  }
  if (categoryPageId === config.categoryPageIds.개인) {
    if (attendees.includes(config.partnerTag)) {
      return { calendarId: config.calendars.데이트, label: '3. 데이트' };
    }
    return { calendarId: config.calendars.개인, label: '2. 개인' };
  }
  if (categoryPageId === config.categoryPageIds.휴일 && attendees.includes(config.selfTag)) {
    return { calendarId: config.calendars.기념일, label: '9. 기념일 등' };
  }
  // 자기개발 / (배대명이 아닌) 휴일 / 알 수 없는 구분 → 동기화 제외
  return null;
}

// 캘린더에 실제로 올라갈 제목. "개인"/"데이트"로 가는 일정만, 페이지 아이콘이
// 이모지로 설정되어 있으면 제목 앞에 "이모지 + 공백 1개"로 붙인다.
const ICON_PREFIX_LABELS = new Set(['2. 개인', '3. 데이트']);

function buildSummary(schedule, target) {
  if (ICON_PREFIX_LABELS.has(target.label) && schedule.icon) {
    return `${schedule.icon} ${schedule.title}`;
  }
  return schedule.title;
}

// 구글 캘린더는 종일 이벤트의 종료일을 exclusive로 처리하므로,
// 노션 Date의 종료일(없으면 시작일)에 +1일 해서 넘겨야 한다.
function toAllDayRange(dateProp) {
  const start = dateProp.start.slice(0, 10);
  const endSource = (dateProp.end || dateProp.start).slice(0, 10);
  const endDate = new Date(`${endSource}T00:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate() + 1);
  const end = endDate.toISOString().slice(0, 10);
  return { start, end };
}

export async function runSync({ dryRun }) {
  const schedules = await fetchUpcomingSchedules();

  let created = 0;
  let updated = 0;
  let skipped = 0;

  // 이번에 실제로 캘린더에 있어야 하는 (구분 매칭 + 날짜 있는) 노션 페이지 ID 집합.
  // 삭제/구분변경 감지(reconcile) 단계에서 "더 이상 유효하지 않은 것"을 가리는 기준이 된다.
  const stillValidPageIds = new Set();

  for (const schedule of schedules) {
    const target = resolveCalendar(schedule);

    if (!target || !schedule.date) {
      skipped++;
      continue;
    }

    stillValidPageIds.add(schedule.pageId);

    const { start, end } = toAllDayRange(schedule.date);
    const isUpdate = Boolean(schedule.gcalEventId);
    const summary = buildSummary(schedule, target);

    console.log(
      `${isUpdate ? '[수정]' : '[생성]'} "${summary}" (${start} ~ ${end}) → ${target.label} 캘린더`
    );

    if (dryRun) {
      continue;
    }

    const eventId = await upsertAllDayEvent({
      calendarId: target.calendarId,
      eventId: schedule.gcalEventId || null,
      summary,
      start,
      end,
      notionPageId: schedule.pageId,
    });

    if (isUpdate) {
      updated++;
    } else {
      created++;
      await writeGCalEventId(schedule.pageId, eventId);
    }
  }

  // 삭제 반영: 노션에서 페이지가 삭제/휴지통 이동되었거나 구분이 바뀌어 더 이상
  // 이 캘린더 대상이 아닌 경우, 예전에 만들어둔 이벤트를 찾아 지운다.
  // (Notion API는 삭제된 페이지를 조회 결과에서 아예 빼버리므로, 반대로 구글
  // 캘린더 쪽에서 "우리가 만든" 이벤트를 훑어 지금 유효한 페이지 목록과 비교한다.)
  let removed = 0;
  const timeMinISO = `${config.syncCutoffDate}T00:00:00Z`;
  const calendarIds = new Set(Object.values(config.calendars));

  for (const calendarId of calendarIds) {
    const synced = await listSyncedEventIds(calendarId, timeMinISO);

    for (const [notionPageId, eventId] of synced) {
      if (stillValidPageIds.has(notionPageId)) continue;

      console.log(`[삭제] 노션에서 사라졌거나 구분이 바뀜 → 캘린더에서 제거`);

      if (!dryRun) {
        await deleteEvent(calendarId, eventId);
      }
      removed++;
    }
  }

  const suffix = dryRun ? ' (dry-run: 실제로 반영하지 않았습니다)' : '';
  console.log(
    `\n동기화 완료 — 조회 ${schedules.length}건 / 생성 ${created}건 / 수정 ${updated}건 / 삭제 ${removed}건 / 제외 ${skipped}건${suffix}`
  );
}
