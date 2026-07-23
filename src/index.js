import { runSync } from './sync.js';

const dryRun = process.argv.includes('--dry-run');

runSync({ dryRun }).catch((err) => {
  console.error('동기화 중 오류가 발생했습니다:', err);
  process.exitCode = 1;
});
