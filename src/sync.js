import { config } from './config.js';
import { fetchUpcomingSchedules, writeGCalEventId } from './notion.js';
import { upsertAllDayEvent } from './googleCalendar.js';

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
  // 자기개발 / 휴일 / 알 수 없는 구분 → 동기화 제외
  return null;
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

  for (const schedule of schedules) {
    const target = resolveCalendar(schedule);

    if (!target || !schedule.date) {
      skipped++;
      continue;
    }

    const { start, end } = toAllDayRange(schedule.date);
    const isUpdate = Boolean(schedule.gcalEventId);

    console.log(
      `${isUpdate ? '[수정]' : '[생성]'} "${schedule.title}" (${start} ~ ${end}) → ${target.label} 캘린더`
    );

    if (dryRun) {
      continue;
    }

    const eventId = await upsertAllDayEvent({
      calendarId: target.calendarId,
      eventId: schedule.gcalEventId || null,
      summary: schedule.title,
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

  const suffix = dryRun ? ' (dry-run: 실제로 반영하지 않았습니다)' : '';
  console.log(
    `\n동기화 완료 — 조회 ${schedules.length}건 / 생성 ${created}건 / 수정 ${updated}건 / 제외 ${skipped}건${suffix}`
  );
}
