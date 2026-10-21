/**
 * 한국은행 ECOS 시장금리(일별, 통계표 817Y002) 조회.
 *
 * - 인증키는 환경변수 ECOS_API_KEY 에서만 읽는다. 응답·오류 메시지에 키를 싣지 않는다.
 * - ECOS 는 인증키를 URL 경로에 넣는다(쿼리 파라미터가 아님).
 * - 항목코드를 생략하면 통계표의 전 항목이 한 번에 온다(2026-10-21 실측: 7영업일 × 27항목 = 188행).
 *   그래서 항목별로 나눠 부르지 않고 한 번만 부른다.
 * - 휴일·주말만 걸친 구간은 INFO-200(데이터 없음)이 온다. 평가기준일이 휴일이면 직전 영업일 값을 쓰도록
 *   기준일 이전 LOOKBACK_DAYS 일을 함께 받는다.
 * - INFO-200 은 "데이터 없음"이지 오류가 아니다. 그 밖의 RESULT 코드(INFO-100 인증키 오류 등)는 오류로 올린다.
 */

export const ECOS_BASE = "https://ecos.bok.or.kr/api";
export const MARKET_RATE_TABLE = "817Y002";

/** 휴일이 길게 이어지는 경우(설·추석 연휴 + 주말)를 덮는 조회 창. 값은 보수적으로 잡았다. */
export const LOOKBACK_DAYS = 14;

/** 한 번에 받을 행 수. 14일 × 27항목 ≈ 270행이라 여유가 있다. 응답의 list_total_count 와 대조해 잘림을 검사한다. */
const PAGE_SIZE = 1000;

/** 도구에서 쓰는 이름 → ECOS 항목코드. 항목코드는 StatisticItemList(817Y002)로 2026-10-21 확인. */
export const RATE_ITEMS = {
  ktb_1y: { code: "010190000", name: "국고채(1년)" },
  ktb_2y: { code: "010195000", name: "국고채(2년)" },
  ktb_3y: { code: "010200000", name: "국고채(3년)" },
  ktb_5y: { code: "010200001", name: "국고채(5년)" },
  ktb_10y: { code: "010210000", name: "국고채(10년)" },
  ktb_20y: { code: "010220000", name: "국고채(20년)" },
  ktb_30y: { code: "010230000", name: "국고채(30년)" },
  ktb_50y: { code: "010240000", name: "국고채(50년)" },
  corp_aa_minus_3y: { code: "010300000", name: "회사채(3년, AA-)" },
  corp_bbb_minus_3y: { code: "010320000", name: "회사채(3년, BBB-)" },
  msb_1y: { code: "010400001", name: "통안증권(1년)" },
  cd_91d: { code: "010502000", name: "CD(91일)" },
  koribor_3m: { code: "010150000", name: "KORIBOR(3개월)" },
  call_1d: { code: "010101000", name: "콜금리(1일, 전체거래)" },
} as const;

export type RateKey = keyof typeof RATE_ITEMS;
export const RATE_KEYS = Object.keys(RATE_ITEMS) as RateKey[];

/** 무위험이자율 만기 → 항목. */
export const KTB_BY_TENOR: Record<string, RateKey> = {
  "1y": "ktb_1y", "2y": "ktb_2y", "3y": "ktb_3y", "5y": "ktb_5y",
  "10y": "ktb_10y", "20y": "ktb_20y", "30y": "ktb_30y", "50y": "ktb_50y",
};

/** 신용등급 → 회사채 항목. ECOS 일별 시장금리에는 3년 AA-, BBB- 두 등급만 있다. */
export const CORP_BY_RATING: Record<string, RateKey> = {
  "AA-": "corp_aa_minus_3y",
  "BBB-": "corp_bbb_minus_3y",
};

export interface RateObservation {
  key: RateKey;
  name: string;
  itemCode: string;
  /** 연% (예: 3.84 = 연 3.84%) */
  valuePct: number;
  /** 실제 관측일 YYYYMMDD — 평가기준일이 휴일이면 직전 영업일 */
  observedDate: string;
  /** 평가기준일과 관측일의 달력일 차이 */
  lagDays: number;
}

export interface RatesResult {
  valuationDate: string;
  table: string;
  window: { from: string; to: string };
  rates: RateObservation[];
  /** 요청했지만 조회 창 안에 값이 없던 항목 */
  missing: { key: RateKey; name: string; reason: string }[];
  source: string;
}

export class EcosError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "EcosError";
  }
}

export function normalizeDate(input: string): string {
  const d = input.replace(/-/g, "");
  if (!/^\d{8}$/.test(d)) throw new EcosError(`날짜 형식은 YYYYMMDD 또는 YYYY-MM-DD 여야 합니다: ${input}`);
  const y = +d.slice(0, 4), m = +d.slice(4, 6), day = +d.slice(6, 8);
  const dt = new Date(Date.UTC(y, m - 1, day));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== day) {
    throw new EcosError(`존재하지 않는 날짜입니다: ${input}`);
  }
  return d;
}

function toUtc(d: string): Date {
  return new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)));
}
function fmt(dt: Date): string {
  return dt.toISOString().slice(0, 10).replace(/-/g, "");
}
export function addDays(d: string, n: number): string {
  const dt = toUtc(d);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fmt(dt);
}
export function diffDays(a: string, b: string): number {
  return Math.round((toUtc(a).getTime() - toUtc(b).getTime()) / 86400000);
}

interface EcosRow { ITEM_CODE1: string; ITEM_NAME1: string; TIME: string; DATA_VALUE: string; UNIT_NAME: string }

type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

function getKey(): string {
  const k = process.env.ECOS_API_KEY;
  if (!k) throw new EcosError("서버 환경변수 ECOS_API_KEY 가 설정되어 있지 않습니다.", "NO_KEY");
  return k;
}

/** 구간 [from, to] 의 817Y002 전 항목 행을 받는다. 데이터 없음이면 빈 배열. */
export async function fetchMarketRateRows(from: string, to: string, fetcher: Fetcher = fetch as unknown as Fetcher): Promise<EcosRow[]> {
  const key = getKey();
  const url = `${ECOS_BASE}/StatisticSearch/${encodeURIComponent(key)}/json/kr/1/${PAGE_SIZE}/${MARKET_RATE_TABLE}/D/${from}/${to}`;
  let res;
  try {
    res = await fetcher(url);
  } catch (e) {
    throw new EcosError(`ECOS 연결 실패: ${(e as Error).message.replace(key, "***")}`, "NETWORK");
  }
  if (!res.ok) throw new EcosError(`ECOS HTTP ${res.status}`, `HTTP_${res.status}`);
  const body = (await res.json()) as Record<string, any>;
  if (body.RESULT) {
    const code = String(body.RESULT.CODE ?? "");
    if (code === "INFO-200") return [];
    throw new EcosError(`ECOS 오류 ${code}: ${String(body.RESULT.MESSAGE ?? "").slice(0, 120)}`, code);
  }
  const s = body.StatisticSearch;
  if (!s || !Array.isArray(s.row)) throw new EcosError("ECOS 응답 형식이 예상과 다릅니다(StatisticSearch.row 없음).", "SHAPE");
  const total = Number(s.list_total_count);
  if (Number.isFinite(total) && total > s.row.length) {
    // 잘린 채로 값을 고르면 관측일이 틀어질 수 있으므로 조용히 넘어가지 않는다.
    throw new EcosError(`ECOS 응답이 잘렸습니다(전체 ${total}행 중 ${s.row.length}행). 조회 창을 줄여야 합니다.`, "TRUNCATED");
  }
  return s.row as EcosRow[];
}

/**
 * 평가기준일 당일(휴일이면 직전 영업일)의 금리를 고른다.
 * 기준일보다 뒤의 값은 절대 쓰지 않는다(사후 정보 차단).
 */
export async function getRatesAsOf(valuationDate: string, keys: RateKey[], fetcher?: Fetcher): Promise<RatesResult> {
  const vd = normalizeDate(valuationDate);
  const from = addDays(vd, -LOOKBACK_DAYS);
  const rows = await fetchMarketRateRows(from, vd, fetcher);

  const byCode = new Map<string, EcosRow[]>();
  for (const r of rows) {
    if (r.TIME > vd) continue;
    const v = Number(r.DATA_VALUE);
    if (r.DATA_VALUE === null || r.DATA_VALUE === "" || !Number.isFinite(v)) continue;
    const arr = byCode.get(r.ITEM_CODE1) ?? [];
    arr.push(r);
    byCode.set(r.ITEM_CODE1, arr);
  }

  const rates: RateObservation[] = [];
  const missing: RatesResult["missing"] = [];
  const uniq = Array.from(new Set(keys));
  for (const k of uniq) {
    const item = RATE_ITEMS[k];
    const arr = byCode.get(item.code);
    if (!arr || arr.length === 0) {
      missing.push({ key: k, name: item.name, reason: `${from}~${vd} 사이에 값이 없습니다(해당 항목의 공표 시작 이전이거나 장기 휴장).` });
      continue;
    }
    const latest = arr.reduce((a, b) => (b.TIME > a.TIME ? b : a));
    rates.push({
      key: k, name: item.name, itemCode: item.code,
      valuePct: Number(latest.DATA_VALUE),
      observedDate: latest.TIME,
      lagDays: diffDays(vd, latest.TIME),
    });
  }

  return {
    valuationDate: vd,
    table: `${MARKET_RATE_TABLE} 시장금리(일별)`,
    window: { from, to: vd },
    rates, missing,
    source: "한국은행 경제통계시스템(ECOS) StatisticSearch",
  };
}
