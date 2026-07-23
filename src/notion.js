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
