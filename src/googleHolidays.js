import { calendar } from './googleCalendar.js';

const HOLIDAY_CALENDAR_ID = 'ko.south_korea#holiday@group.v.calendar.google.com';

// "대한민국의 휴일" 구글 캘린더는 수십~백 년치 이벤트가 있어서 반드시 범위를
// 제한해야 한다 (importHolidays.js가 fromDate~toDate로 12개월 창을 넘겨준다).
// 공휴일/기념일 구분 없이 전부 가져온다 (구글의 description 표시가 실제
// 법정 공휴일 여부와 100% 일치하지 않기 때문 — 사용자 확인 완료).
export async function fetchKoreanHolidays({ fromDate, toDate }) {
  const timeMin = `${fromDate}T00:00:00Z`;
  const timeMax = `${toDate}T00:00:00Z`;

  const events = new Map(); // googleEventId -> { title, date: 'YYYY-MM-DD' }
  let pageToken;

  do {
    const res = await calendar.events.list({
      calendarId: HOLIDAY_CALENDAR_ID,
      timeMin,
      timeMax,
      singleEvents: true,
      showDeleted: false,
      maxResults: 250,
      pageToken,
    });

    for (const event of res.data.items ?? []) {
      if (!event.start?.date) continue; // 종일 이벤트만 대상 (이 캘린더는 전부 종일)
      events.set(event.id, { title: event.summary, date: event.start.date });
    }

    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  return events;
}
