import { config } from './config.js';

// 멀티 데이터소스 데이터베이스(구 "data source") 조회를 지원하는 최신 API 버전
const NOTION_VERSION = '2025-09-03';
const NOTION_API = 'https://api.notion.com/v1';

async function notionFetch(path, options = {}) {
  const res = await fetch(`${NOTION_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.notion.token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion API 오류 (${res.status}): ${text}`);
  }
  return res.json();
}

function normalizeId(id) {
  return id ? id.replace(/-/g, '') : id;
}

function parseSchedulePage(page) {
  const props = page.properties;

  const title = props['이름']?.title?.map((t) => t.plain_text).join('') || '(제목 없음)';
  const date = props['Date']?.date ?? null;
  const attendees = (props['관계자']?.multi_select ?? []).map((o) => o.name);

  // 화면에 보이는 "구분" 롤업 문자열이 아니라 "구분(선택)" relation의 원본
  // 페이지 ID를 그대로 가져온다. Make.com에서 롤업 문자열 비교가 안 걸렸던
  // 문제를 피하기 위함.
  const categoryPageId = normalizeId(props['구분(선택)']?.relation?.[0]?.id);

  const gcalEventId =
    props['GCal Event ID']?.rich_text?.map((t) => t.plain_text).join('') || '';

  // 페이지 상단 아이콘. 이모지인 경우만 쓸 수 있고, 업로드 이미지/외부 URL
  // 아이콘은 캘린더 제목에 넣을 수 없으니 무시한다.
  const icon = page.icon?.type === 'emoji' ? page.icon.emoji : null;

  return { pageId: page.id, title, date, attendees, categoryPageId, gcalEventId, icon };
}

// 기준일(config.syncCutoffDate) 이후 Date를 가진 일정만 조회한다.
// 이전 일정은 애초에 조회 대상에서 제외되므로 절대 건드릴 일이 없다.
export async function fetchUpcomingSchedules() {
  const pages = [];
  let cursor;

  do {
    const body = {
      filter: {
        property: 'Date',
        date: { on_or_after: config.syncCutoffDate },
      },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    };

    const data = await notionFetch(`/data_sources/${config.notion.dataSourceId}/query`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return pages.map(parseSchedulePage);
}

// 새로 생성된 구글 캘린더 이벤트 ID를 노션 페이지에 기록해 다음부터는
// "수정"으로 처리되도록 한다.
export async function writeGCalEventId(pageId, eventId) {
  await notionFetch(`/pages/${pageId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      properties: {
        'GCal Event ID': {
          rich_text: [{ text: { content: eventId } }],
        },
      },
    }),
  });
}

function toDashedId(id) {
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

// "휴일" 구분의 노션 페이지들을 fromDate~toDate 범위에서 조회한다.
// sourceEventId는 "GCal Event ID"에 저장된 값인데, 이 필드는 두 가지 다른
// 용도로 쓰인다: (1) 이 가져오기 기능이 적어둔 "구글 원본 휴일 이벤트 ID",
// (2) 관계자에 배대명이 있는 휴일 페이지를 sync.js가 "9. 기념일 등"에 올릴 때
// 적어두는 "우리가 만든 구글 이벤트 ID". 둘을 구분하지 않으면 (2)를 (1)로
// 착각해서 잘못 삭제할 수 있으므로, attendees(관계자)도 함께 반환해서
// 호출부에서 "관계자가 비어있을 때만 가져오기가 만든 것"으로 판단하게 한다.
export async function fetchExistingHolidayPages({ fromDate, toDate }) {
  const pages = [];
  let cursor;

  do {
    const body = {
      filter: {
        and: [
          {
            property: '구분(선택)',
            relation: { contains: toDashedId(config.categoryPageIds.휴일) },
          },
          { property: 'Date', date: { on_or_after: fromDate } },
          { property: 'Date', date: { on_or_before: toDate } },
        ],
      },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    };

    const data = await notionFetch(`/data_sources/${config.notion.dataSourceId}/query`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return pages.map((page) => {
    const props = page.properties;
    const dateStart = props['Date']?.date?.start?.slice(0, 10) ?? null;
    // 종료일이 따로 없으면(하루짜리) 시작일과 같다고 본다 — 범위 계산을 단순화.
    const dateEnd = props['Date']?.date?.end?.slice(0, 10) ?? dateStart;
    const sourceEventId =
      props['GCal Event ID']?.rich_text?.map((t) => t.plain_text).join('') || '';
    const attendees = (props['관계자']?.multi_select ?? []).map((o) => o.name);
    const title = props['이름']?.title?.map((t) => t.plain_text).join('') || '';
    return { pageId: page.id, title, date: dateStart, dateEnd, sourceEventId, attendees };
  });
}

// 구글 공휴일 이벤트를 노션에 새 페이지로 만든다. 관계자는 일부러 비워둔다 —
// 채우면 기존 sync.js의 "휴일+배대명→9.기념일 등" 규칙에 걸려 구글로 다시
// 나가버리는데, 이 캘린더는 이미 "대한민국의 휴일"로 따로 구독 중이라 중복이 됨.
// dateEnd를 넘기면(date와 다를 때만) 범위(연휴)로, 안 넘기면 하루짜리로 저장한다.
export async function createHolidayPage({ title, date, dateEnd, sourceEventId }) {
  const dateProperty = dateEnd && dateEnd !== date ? { start: date, end: dateEnd } : { start: date };

  await notionFetch('/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { data_source_id: config.notion.dataSourceId },
      properties: {
        이름: { title: [{ text: { content: title } }] },
        Date: { date: dateProperty },
        '구분(선택)': { relation: [{ id: toDashedId(config.categoryPageIds.휴일) }] },
        'GCal Event ID': { rich_text: [{ text: { content: sourceEventId } }] },
      },
    }),
  });
}

// 기존 휴일 페이지의 제목/날짜(범위)를 갱신한다. 설날/추석처럼 낱개 날짜로
// 이미 만들어져 있던 페이지("설날" 등)를 하나의 연휴 범위("설날 연휴")로
// 합칠 때 쓴다 — 제목도 같이 바꿔야 "설날 연휴"로 통일된다.
export async function updateHolidayPage(pageId, { title, dateStart, dateEnd }) {
  const dateProperty =
    dateEnd && dateEnd !== dateStart ? { start: dateStart, end: dateEnd } : { start: dateStart };

  await notionFetch(`/pages/${pageId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      properties: {
        이름: { title: [{ text: { content: title } }] },
        Date: { date: dateProperty },
      },
    }),
  });
}

// 완전 삭제가 아니라 노션 휴지통으로 이동 (복구 가능).
export async function archivePage(pageId) {
  await notionFetch(`/pages/${pageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ archived: true }),
  });
}
