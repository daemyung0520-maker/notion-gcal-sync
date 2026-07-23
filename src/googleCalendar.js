import { google } from 'googleapis';
import { config } from './config.js';

function getCalendarClient() {
  const oAuth2Client = new google.auth.OAuth2(config.google.clientId, config.google.clientSecret);
  oAuth2Client.setCredentials({ refresh_token: config.google.refreshToken });
  return google.calendar({ version: 'v3', auth: oAuth2Client });
}

// 다른 모듈(googleHolidays.js 등)에서도 같은 인증된 클라이언트를 재사용한다.
export const calendar = getCalendarClient();

// 종일(all-day) 이벤트를 생성하거나(eventId 없음) 수정한다(eventId 있음).
// start/end는 'YYYY-MM-DD' 문자열이며, end는 이미 구글 캘린더 규칙(exclusive)에
// 맞춰 +1일 처리된 값을 그대로 받는다 (sync.js에서 계산).
// extendedProperties.private는 캘린더 화면엔 안 보이지만, 이 이벤트가
// 자동화로 생성됐다는 걸 나중에 API로 구분할 수 있게 남겨두는 표시다.
export async function upsertAllDayEvent({ calendarId, eventId, summary, start, end, notionPageId }) {
  const requestBody = {
    summary,
    start: { date: start },
    end: { date: end },
    extendedProperties: {
      private: {
        source: 'notion-gcal-sync',
        notionPageId,
      },
    },
  };

  if (eventId) {
    try {
      const res = await calendar.events.update({ calendarId, eventId, requestBody });
      return res.data.id;
    } catch (err) {
      const status = err.code ?? err.response?.status;
      // 예전에 다른 캘린더에 만들어졌던 이벤트일 수 있다 (구분이 바뀌어 캘린더가
      // 달라진 경우). 이 캘린더엔 해당 eventId가 없는 것뿐이니 새로 만든다.
      if (status !== 404 && status !== 410) throw err;
    }
  }

  const res = await calendar.events.insert({ calendarId, requestBody });
  return res.data.id;
}

// source=notion-gcal-sync 로 표시된(=이 스크립트가 만든) 이벤트들을 캘린더에서
// 찾아 { notionPageId → eventId } 맵으로 돌려준다. 삭제 감지(reconcile)에 사용.
export async function listSyncedEventIds(calendarId, timeMinISO) {
  const found = new Map();
  let pageToken;

  do {
    const res = await calendar.events.list({
      calendarId,
      privateExtendedProperty: ['source=notion-gcal-sync'],
      timeMin: timeMinISO,
      singleEvents: true,
      showDeleted: false,
      maxResults: 250,
      pageToken,
    });

    for (const event of res.data.items ?? []) {
      const pageId = event.extendedProperties?.private?.notionPageId;
      if (pageId) found.set(pageId, event.id);
    }

    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  return found;
}

export async function deleteEvent(calendarId, eventId) {
  try {
    await calendar.events.delete({ calendarId, eventId });
  } catch (err) {
    const status = err.code ?? err.response?.status;
    if (status !== 404 && status !== 410) throw err; // 이미 없으면 조용히 넘어감
  }
}
