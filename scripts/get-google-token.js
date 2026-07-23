// 최초 1회만 로컬에서 실행하는 도우미 스크립트.
// 브라우저에서 구글 로그인을 한 번 진행하면 refresh token을 발급해준다.
// 이 refresh token을 .env의 GOOGLE_REFRESH_TOKEN에 넣으면,
// 그 뒤로는 다시 로그인할 필요 없이 자동으로 동기화가 가능하다.
import 'dotenv/config';
import http from 'node:http';
import { google } from 'googleapis';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    '.env 파일에 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 를 먼저 넣어주세요.'
  );
  process.exit(1);
}

const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/calendar'],
});

console.log('\n아래 주소를 브라우저에 붙여넣어 구글 로그인 및 권한 허용을 진행해주세요:\n');
console.log(authUrl);
console.log('\n로그인을 완료하면 이 창에 refresh token이 자동으로 출력됩니다...\n');

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, REDIRECT_URI);
    const code = url.searchParams.get('code');

    if (!code) {
      res.end('code가 없습니다. 다시 시도해주세요.');
      return;
    }

    res.end('로그인이 완료되었습니다. 이 창을 닫고 터미널로 돌아가세요.');
    server.close();

    const { tokens } = await oAuth2Client.getToken(code);

    if (!tokens.refresh_token) {
      console.error(
        '\nrefresh token이 발급되지 않았습니다. 구글 계정 설정에서 이 앱의 기존 접근 권한을 제거한 뒤 다시 시도해주세요.\n(myaccount.google.com/permissions)'
      );
      process.exit(1);
    }

    console.log('\n발급된 refresh token — 이 값을 .env 파일의 GOOGLE_REFRESH_TOKEN 에 넣어주세요:\n');
    console.log(tokens.refresh_token);
    console.log('');
    process.exit(0);
  } catch (err) {
    console.error('토큰 발급 중 오류가 발생했습니다:', err);
    process.exit(1);
  }
});

server.listen(PORT);
