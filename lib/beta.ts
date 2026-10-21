/**
 * 베타 회귀 — 네이버 수정종가의 단순수익률을 시장지수 단순수익률에 OLS 회귀.
 *
 * 표본 규칙(값을 보기 전에 정한 것이 아니라, 외부 비교 서버 kr-valuation-data 의 compute_beta 와
 * 2026-10-21 실측 대조로 확정한 관례 — 5종목 × 기준일 3개 × 주간·월간 30건이 소수점 6자리까지 일치):
 * - 주간: 기준일 이전(포함) 가장 가까운 금요일부터 7일씩 거슬러 간 금요일 종가.
 *         금요일이 휴장이면 목요일 종가, 목·금 모두 휴장이면 그 주는 빼고 한 주 더 거슬러 간다.
 *         기준일이 속한 주의 금요일 이후 값(진행 중인 주)은 쓰지 않는다.
 * - 월간: 각 월의 마지막 거래일 종가. 기준일이 속한 달은 기준일 종가를 그 달 값으로 쓴다.
 * - 수익률은 로그가 아니라 단순수익률. 조정베타 = 실질베타 × 2/3 + 1/3 (Blume).
 * - 종목과 지수가 둘 다 거래된 날만 쓴다.
 */
import { getDailyCloses, type DailyClose } from "./naver.js";

export type BetaPeriod = "Weekly-1Y" | "Weekly-2Y" | "Weekly-3Y" | "Monthly-3Y" | "Monthly-5Y";
export const BETA_PERIODS: BetaPeriod[] = ["Weekly-1Y", "Weekly-2Y", "Weekly-3Y", "Monthly-3Y", "Monthly-5Y"];
const SPEC: Record<BetaPeriod, { freq: "W" | "M"; n: number }> = {
  "Weekly-1Y": { freq: "W", n: 52 }, "Weekly-2Y": { freq: "W", n: 104 }, "Weekly-3Y": { freq: "W", n: 156 },
  "Monthly-3Y": { freq: "M", n: 36 }, "Monthly-5Y": { freq: "M", n: 60 },
};

export interface BetaResult {
  period: BetaPeriod;
  raw: number | null;
  adjusted: number | null;
  rSquared: number | null;
  standardError: number | null;
  tStat: number | null;
  dataPoints: number;
  required: number;
  window: { from: string | null; to: string | null };
  warnings: string[];
}

const toDate = (s: string) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);

/** 두 시계열이 모두 있는 날짜만 남긴다. */
function intersect(a: DailyClose[], b: DailyClose[]) {
  const mb = new Map(b.map(x => [x.date, x.close]));
  const s = new Map<string, number>(), m = new Map<string, number>();
  for (const x of a) { const v = mb.get(x.date); if (v !== undefined) { s.set(x.date, x.close); m.set(x.date, v); } }
  return { s, m, dates: Array.from(s.keys()).sort() };
}

function weeklyPoints(dates: Set<string>, base: string, n: number, earliest: string): string[] {
  const b = toDate(base);
  let fri = addDays(b, -((b.getUTCDay() - 5 + 7) % 7));
  const pts: string[] = [];
  while (pts.length < n + 1) {
    const f = fmt(fri);
    if (f < earliest) break;
    if (dates.has(f)) pts.push(f);
    else { const thu = fmt(addDays(fri, -1)); if (dates.has(thu)) pts.push(thu); }
    fri = addDays(fri, -7);
  }
  return pts.reverse();
}

function monthlyPoints(sortedDates: string[], base: string, n: number): string[] {
  const lastOfMonth = new Map<string, string>();
  for (const d of sortedDates) if (d <= base) lastOfMonth.set(d.slice(0, 6), d);
  const pts = Array.from(lastOfMonth.values()).sort();
  return pts.slice(-(n + 1));
}

function ols(xs: number[], ys: number[]) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  const beta = sxy / sxx;
  const r2 = sxy * sxy / (sxx * syy);
  const sse = syy - beta * sxy;
  const se = n > 2 ? Math.sqrt(sse / (n - 2) / sxx) : NaN;
  return { beta, r2, se };
}

const r6 = (v: number) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : null);

export function computeBetaFromSeries(stock: DailyClose[], index: DailyClose[], base: string, periods: BetaPeriod[]): BetaResult[] {
  const { s, m, dates } = intersect(stock, index);
  const set = new Set(dates);
  return periods.map((p) => {
    const { freq, n } = SPEC[p];
    const warnings: string[] = [];
    const pts = freq === "W" ? weeklyPoints(set, base, n, dates[0] ?? base) : monthlyPoints(dates, base, n);
    const xs: number[] = [], ys: number[] = [];
    for (let i = 1; i < pts.length; i++) {
      ys.push(s.get(pts[i])! / s.get(pts[i - 1])! - 1);
      xs.push(m.get(pts[i])! / m.get(pts[i - 1])! - 1);
    }
    const k = xs.length;
    if (k < n) warnings.push(`관측치 ${k}개로 요구치 ${n}개보다 적습니다(상장 기간 부족 또는 장기 거래정지). 같은 기간 표기라도 다른 종목과 비교 가능하지 않습니다.`);
    if (k < Math.max(8, Math.ceil(n / 2))) {
      return { period: p, raw: null, adjusted: null, rSquared: null, standardError: null, tStat: null, dataPoints: k, required: n, window: { from: pts[0] ?? null, to: pts[pts.length - 1] ?? null }, warnings: [...warnings, "관측치가 요구치의 절반에 못 미쳐 계산하지 않았습니다."] };
    }
    const { beta, r2, se } = ols(xs, ys);
    if (Number.isFinite(r2) && r2 < 0.05) warnings.push(`결정계수 ${r6(r2)} — 시장 수익률로 설명되는 부분이 거의 없어 베타 추정이 불안정합니다.`);
    return {
      period: p, raw: r6(beta), adjusted: r6(beta * 2 / 3 + 1 / 3), rSquared: r6(r2),
      standardError: r6(se), tStat: r6(beta / se), dataPoints: k, required: n,
      window: { from: pts[0], to: pts[pts.length - 1] }, warnings,
    };
  });
}

export async function computeBeta(codes: string[], base: string, periods: BetaPeriod[], indexSymbol: "KOSPI" | "KOSDAQ") {
  const longest = Math.max(...periods.map(p => (SPEC[p].freq === "M" ? SPEC[p].n / 12 : SPEC[p].n / 52)));
  const from = fmt(addDays(toDate(base), -Math.ceil(longest * 366 + 45)));
  const index = await getDailyCloses(indexSymbol, from, base);
  if (index.length === 0) throw new Error(`${indexSymbol} 지수 시세를 받지 못했습니다.`);
  const out = [];
  for (const code of codes) {
    try {
      const px = await getDailyCloses(code, from, base);
      if (px.length === 0) { out.push({ code, error: "주가를 받지 못했습니다(종목코드 오류·상장폐지·상장 이전 기준일)." }); continue; }
      const lastTrade = px[px.length - 1].date;
      const res = computeBetaFromSeries(px, index, base, periods);
      out.push({ code, lastTradeDate: lastTrade, results: res, ...(lastTrade < base && diffDays(base, lastTrade) > 10 ? { note: `기준일 이전 마지막 거래일이 ${lastTrade} 입니다(거래정지·상장폐지 여부 확인).` } : {}) });
    } catch (e) {
      out.push({ code, error: (e as Error).message });
    }
  }
  return { baseDate: base, index: indexSymbol, out };
}

function diffDays(a: string, b: string) { return Math.round((toDate(a).getTime() - toDate(b).getTime()) / 86400000); }
