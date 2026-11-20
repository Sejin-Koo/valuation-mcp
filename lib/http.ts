// 원천(DART·네이버) 요청의 연결 단계 실패를 잠깐 쉬고 다시 받는 공통 fetch.
// 2026-11-20 11:46 실측: dart_business_section이 DART 공시목록(list.json) 요청에서 'fetch failed'(10초)로 실패했고,
// 같은 인자 재호출은 정상이었다(DART 접속 일시 끊김). 전에는 재시도 없이 바로 오류였다.
//   - 연결 실패(응답 전 예외)와 HTTP 5xx만 다시 받는다. 4xx·정상 응답은 그대로 돌려준다.
//   - 중단(AbortError — 호출부 시간 한도)은 다시 받지 않는다.
//   - quickMs: 이 시간 안에 난 연결 실패만 다시 받는다. 원본 zip처럼 오래 받다가 끊긴 경우(terminated)까지 다시 받으면
//     함수 한도(300초)를 넘길 수 있어 내려받기 호출부는 짧게 준다.
export async function fetchRetry(url: string, init: RequestInit = {}, opts: { tries?: number; quickMs?: number } = {}): Promise<Response> {
  const tries = opts.tries ?? 3;
  const quickMs = opts.quickMs ?? Infinity;
  let lastErr: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, init);
      if (res.status >= 500 && attempt < tries - 1) { await sleep(600 * (attempt + 1)); continue; }
      return res;
    } catch (e) {
      lastErr = e;
      if ((e as Error).name === "AbortError" || Date.now() - t0 > quickMs || attempt === tries - 1) break;
      await sleep(600 * (attempt + 1));
    }
  }
  const e = lastErr as Error & { cause?: { code?: string } };
  const code = e && e.cause && e.cause.code;
  if (e && e.name !== "AbortError" && code && !String(e.message).includes(code)) e.message = `${e.message} (${code})`;
  throw lastErr;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
