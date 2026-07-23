import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`환경변수 ${name} 가 설정되어 있지 않습니다. .env 파일을 확인하세요.`);
  }
  return value;
}

export const config = {
  notion: {
    token: required('NOTION_TOKEN'),
    // "대명 창고" 데이터소스 (Schedule)
    dataSourceId: '2dbbb9a8-72db-80bb-b9d1-000b11b3de9c',
  },
  google: {
    clientId: required('GOOGLE_CLIENT_ID'),
    clientSecret: required('GOOGLE_CLIENT_SECRET'),
    refreshToken: required('GOOGLE_REFRESH_TOKEN'),
  },
  calendars: {
    업무: process.env.CALENDAR_ID_WORK || 'daemyung0520@gmail.com',
    개인: required('CALENDAR_ID_PERSONAL'),
    데이트: required('CALENDAR_ID_DATE'),
    기념일: required('CALENDAR_ID_ANNIVERSARY'),
  },
  timeZone: 'Asia/Seoul',
  // "구분(선택)" relation이 가리키는 "구분 색상" 데이터소스의 실제 페이지 ID.
  // 화면에 보이는 롤업 문자열이 아니라 이 ID로 비교해야 Make.com에서 겪었던
  // 롤업 필터링 오류를 피할 수 있음.
  categoryPageIds: {
    업무: '2e7bb9a872db80e4b854e30b0fec64ec',
    개인: '2e7bb9a872db80f98f4af3328aa01864',
    자기개발: '2e7bb9a872db802dbc0ee64f6b609f32',
    휴일: '2e7bb9a872db80a8ac86c2c27bc9f001',
  },
  // 이 인물이 "관계자"에 포함되면 개인 일정이 데이트 캘린더로 감
  partnerTag: '세지💕',
  // 본인. "휴일" 구분 + 이 인물이 관계자면 기념일 캘린더로 감 (연차, 공휴일 등)
  selfTag: '배대명',
  // 이 날짜(YYYY-MM-DD) 이후의 Date 속성을 가진 일정만 동기화 대상
  syncCutoffDate: required('SYNC_CUTOFF_DATE'),
};
