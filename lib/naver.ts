/**
 * 네이버 금융 공개 JSON 조회 — 일별 수정주가(siseJson)와 종목 종합정보(m.stock integration).
 *
 * 실측(2026-10-21):
 * - siseJson 은 액면분할을 반영한 수정주가를 준다(카카오 2021-04 5:1 분할 전일 종가가 분할 후 기준으로 환산).
 * - 거래정지일은 시가·고가·저가·거래량이 0이고 종가만 직전 값으로 이어진다 — 종가만 쓰므로 그대로 둔다.
 * - 응답은 JSON 이 아니라 작은따옴표 머리행이 섞인 자바스크립트 배열 문자열이다. 행 단위로 파싱한다.
 * - integration 응답의 숫자는 "1,306조 6,433억", "10.03배", "46.08%" 같은 표시 문자열이다.
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const TIMEOUT_MS = 20_000;

export class NaverError extends Error {
  constructor(message: string) { super(message); this.name = "NaverError"; }
}

async function getText(url: string): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://m.stock.naver.com/" }, signal: ac.signal });
    if (!res.ok) throw new NaverError(`네이버 응답 HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    if (e instanceof NaverError) throw e;
    throw new NaverError(`네이버 연결 실패: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

export interface DailyClose { date: string; close: number }

/** 일별 수정종가. symbol 은 종목코드 6자리 또는 "KOSPI"/"KOSDAQ". */
export async function getDailyCloses(symbol: string, from: string, to: string): Promise<DailyClose[]> {
  const url = `https://api.finance.naver.com/siseJson.naver?symbol=${encodeURIComponent(symbol)}&requestType=1&startTime=${from}&endTime=${to}&timeframe=day`;
  const body = await getText(url);
  const out: DailyClose[] = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*\["(\d{8})",\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)/);
    if (!m) continue;
    const close = Number(m[5]);
    if (Number.isFinite(close) && close > 0) out.push({ date: m[1], close });
  }
  return out;
}

// ─── 종합정보 ─────────────────────────────────────────────

const UNITS: Record<string, number> = { 조: 1e12, 억: 1e8, 만: 1e4 };

/** "1,306조 6,433억" → 1306643300000000, "10.03배" → 10.03, "46.08%" → 46.08, "N/A"·"-" → null */
export function parseKoreanNumber(s: unknown): number | null {
  if (s === null || s === undefined) return null;
  const t = String(s).trim();
  if (!t || t === "-" || /^N\/A$/i.test(t)) return null;
  if (/[조억만]/.test(t)) {
    let total = 0, any = false;
    for (const m of t.matchAll(/([-\d,.]+)\s*([조억만])/g)) {
      const v = Number(m[1].replace(/,/g, ""));
      if (Number.isFinite(v)) { total += v * UNITS[m[2]]; any = true; }
    }
    const tail = t.replace(/([-\d,.]+)\s*[조억만]/g, "").match(/[-\d,.]+/);
    if (tail) { const v = Number(tail[0].replace(/,/g, "")); if (Number.isFinite(v)) { total += v; any = true; } }
    return any ? total : null;
  }
  const m = t.match(/-?[\d,]+(\.\d+)?/);
  if (!m) return null;
  const v = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(v) ? v : null;
}

export interface MarketSnapshot {
  code: string;
  name: string;
  market: string | null;
  industryCode: string | null;
  fetchedAt: string;
  /** 표시 문자열과 숫자를 함께 싣는다 — 숫자 변환이 틀렸을 때 사람이 대조할 수 있도록 */
  indicators: { key: string; label: string; display: string; value: number | null }[];
  consensus: { asOf: string | null; targetPriceMean: number | null; recommendationMean: number | null } | null;
  industryPeers: { code: string; name: string; market: string | null; closePrice: number | null; marketValueMillion: number | null }[];
}

export async function getMarketSnapshot(code: string): Promise<MarketSnapshot> {
  if (!/^\d{6}$|^[0-9A-Z]{6}$/.test(code)) throw new NaverError(`종목코드 6자리가 필요합니다: ${code}`);
  const body = await getText(`https://m.stock.naver.com/api/stock/${code}/integration`);
  let d: any;
  try { d = JSON.parse(body); } catch { throw new NaverError("네이버 종합정보 응답이 JSON 이 아닙니다(종목코드 오류 또는 응답 형식 변경)."); }
  if (!d || !d.itemCode) throw new NaverError(`네이버에 ${code} 종목 정보가 없습니다.`);
  const indicators = (d.totalInfos ?? []).map((t: any) => ({
    key: String(t.code ?? ""), label: String(t.key ?? ""), display: String(t.value ?? ""), value: parseKoreanNumber(t.value),
  }));
  const c = d.consensusInfo;
  const peers = (d.industryCompareInfo ?? []).map((p: any) => ({
    code: String(p.itemCode ?? ""), name: String(p.stockName ?? ""),
    market: p.stockExchangeType?.nameKor ?? null,
    closePrice: parseKoreanNumber(p.closePrice),
    // 동종업종 비교의 marketValue 는 백만원 단위 정수 문자열이다(삼성전자 2026-10-21: 종합정보 시총 1,306조 vs 비교표 SK하이닉스 947,448,597).
    marketValueMillion: parseKoreanNumber(p.marketValue),
  }));
  return {
    code: d.itemCode, name: d.stockName,
    market: d.stockExchangeType?.nameKor ?? d.stockExchangeName ?? null,
    industryCode: d.industryCode ?? null,
    fetchedAt: new Date().toISOString(),
    indicators,
    consensus: c ? { asOf: c.createDate ?? null, targetPriceMean: parseKoreanNumber(c.priceTargetMean), recommendationMean: parseKoreanNumber(c.recommMean) } : null,
    industryPeers: peers,
  };
}
