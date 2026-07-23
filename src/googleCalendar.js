import { google } from 'googleapis';
import { config } from './config.js';

function getCalendarClient() {
  const oAuth2Client = new google.auth.OAuth2(config.google.clientId, config.google.clientSecret);
  oAuth2Client.setCredentials({ refresh_token: config.google.refreshToken });
  return google.calendar({ version: 'v3', auth: oAuth2Client });
}

const calendar = getCalendarClient();

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
    const res = await calendar.events.update({ calendarId, eventId, requestBody });
    return res.data.id;
  }

  const res = await calendar.events.insert({ calendarId, requestBody });
  return res.data.id;
}
