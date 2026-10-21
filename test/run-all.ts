// npm test — 전체 검증. --offline 이면 외부 호출 없는 계산 대조만.
// 온라인 검증 필요 환경변수: ECOS_API_KEY, DART_API_KEY
import { spawnSync } from "node:child_process";

const offline = process.argv.includes("--offline");
const suites = ["test/dcf-equivalence.ts", ...(offline ? [] : ["test/beta-vs-reference.ts", "test/e2e.ts"])];
let failed = 0;
for (const s of suites) {
  console.log(`\n▶ ${s}`);
  const r = spawnSync("npx", ["tsx", s], { stdio: "inherit", env: process.env });
  if (r.status !== 0) { failed++; console.log(`✗ ${s} 실패`); }
}
console.log(`\n${suites.length - failed}/${suites.length} 통과`);
process.exit(failed ? 1 : 0);
