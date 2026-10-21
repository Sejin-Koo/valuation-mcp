/**
 * 피어 통계 엔진 — 멀티플·언레버드 베타의 분포를 낸다. 외부 호출 없음, 같은 입력이면 같은 결과.
 *
 * 규칙(ref-empirical-estimation 반영, 값을 보기 전에 정해 둔 기준):
 * - 대표값은 중앙값. 멀티플은 오른쪽 꼬리가 길어 평균이 위로 끌린다. 평균은 참고로만 싣는다.
 * - 제외는 정의상 성립하지 않는 경우만 한다(분모 ≤ 0, EV ≤ 0, 필드 결측, 누적기간 12개월 미만).
 *   제외 건수와 사유를 종목별로 모두 싣는다.
 * - 이상치는 자동 제외하지 않는다. Tukey 울타리(Q1 − 1.5·IQR, Q3 + 1.5·IQR) 밖 값을 "표시"만 한다.
 *   제외하려면 호출자가 outlier_rule 을 명시해야 하고, 그때도 몇 건을 무슨 기준으로 뺐는지 싣는다.
 * - 사분위는 선형보간(R type 7, 엑셀 QUARTILE.INC 와 같음). 통계량 이름을 응답에 적는다.
 * - 중앙값의 불확실성은 부트스트랩(복원추출 10,000회, 고정 시드) 95% 구간으로 낸다.
 *   사분위 구간(Q1~Q3, 분포의 퍼짐)과 중앙값 95% 구간(추정의 불확실성)은 다른 것이므로 따로 싣는다.
 * - 표본이 5개 미만이면 경고, 3개 미만이면 사분위·구간을 내지 않는다.
 */

import { isNum } from "./dcf.js";

export interface PeerRow {
  code: string;
  name?: string;
  /** 레버드(조정 또는 실질) 베타 — 어느 쪽인지는 호출자가 beta_basis 로 밝힌다 */
  beta?: number | null;
  marketCap?: number | null;
  /** 이자부부채 총액 */
  ibd?: number | null;
  /** 이자부부채 중 리스부채 */
  lease?: number | null;
  cash?: number | null;
  shortTermDeposits?: number | null;
  nci?: number | null;
  /** 제공되면 그대로 쓰고, 없으면 시가총액 + 순차입금 + 비지배지분으로 계산 */
  enterpriseValue?: number | null;
  revenue?: number | null;
  operatingIncome?: number | null;
  /** 감가상각비(유형+사용권자산+무형) — 있으면 EBITDA = 영업이익 + 감가상각비 */
  depreciationAmortization?: number | null;
  netIncomeParent?: number | null;
  equityParent?: number | null;
  /** 손익의 누적 개월수(분기보고서면 3·6·9). 12가 아니면 흐름 멀티플에서 제외(annualize 옵션 시 연환산) */
  incomeMonths?: number | null;
  /** 근거 보고서 표시(예: "2025 사업보고서") — 보고서가 섞였는지 확인용 */
  report?: string | null;
  /** 원천 데이터의 확인 필요 표시(예: valuation_get_data 의 marketCap.sharesNote, ibd.checks) — 결과 경고에 그대로 올린다 */
  dataNotes?: string[] | null;
}

export type MetricKey = "ev_sales" | "ev_ebit" | "ev_ebitda" | "per" | "pbr" | "unlevered_beta";

export const METRIC_LABEL: Record<MetricKey, string> = {
  ev_sales: "EV/매출액",
  ev_ebit: "EV/영업이익",
  ev_ebitda: "EV/EBITDA",
  per: "PER(시가총액/지배순이익)",
  pbr: "PBR(시가총액/지배자본)",
  unlevered_beta: "언레버드 베타(Hamada)",
};

export interface PeerStatsOptions {
  metrics?: MetricKey[];
  /** 언레버드 베타 계산용 법인세율(%) — unlevered_beta 를 요청하면 필수 */
  tax_rate_pct?: number;
  /** 언레버드 베타의 부채 정의. 기본 ibd_total(리스 포함 이자부부채 총액) */
  debt_definition?: "ibd_total" | "ibd_ex_lease" | "net_debt";
  /** 손익 누적이 12개월 미만인 행 처리. 기본 exclude */
  partial_period?: "exclude" | "annualize";
  outlier_rule?: "none" | "tukey_1.5" | "tukey_3";
  bootstrap_resamples?: number;
}

interface Exclusion { code: string; name?: string; reason: string }
interface Value { code: string; name?: string; value: number; outlier: boolean; note?: string }

export interface MetricSummary {
  metric: MetricKey;
  label: string;
  definition: string;
  nInput: number;
  nUsed: number;
  excluded: Exclusion[];
  excludedByReason: Record<string, number>;
  outlierRule: string;
  outliersFlagged: string[];
  outliersRemoved: string[];
  median: number | null;
  q1: number | null;
  q3: number | null;
  mean: number | null;
  min: number | null;
  max: number | null;
  medianBootstrap95: [number, number] | null;
  values: Value[];
  warnings: string[];
}

// ─── 기초 통계 ───────────────────────────────────────────────

/** R type 7 / QUARTILE.INC */
export function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h), hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}
export const median = (sorted: number[]) => quantile(sorted, 0.5);

/** 재현 가능한 의사난수(mulberry32). 같은 입력이면 부트스트랩 구간도 같다. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedOf(values: number[]): number {
  let h = 2166136261;
  for (const v of values) { const s = v.toFixed(10); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } }
  return h >>> 0;
}
export function bootstrapMedianCI(values: number[], resamples = 10000): [number, number] {
  const rnd = mulberry32(seedOf(values));
  const n = values.length, meds = new Float64Array(resamples), buf = new Array<number>(n);
  for (let b = 0; b < resamples; b++) {
    for (let i = 0; i < n; i++) buf[i] = values[Math.floor(rnd() * n)];
    buf.sort((x, y) => x - y);
    meds[b] = median(buf);
  }
  const s = Array.from(meds).sort((x, y) => x - y);
  return [quantile(s, 0.025), quantile(s, 0.975)];
}

const round = (v: number | null, d = 4) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

// ─── 지표 계산 ───────────────────────────────────────────────

function evOf(r: PeerRow): number | null {
  if (isNum(r.enterpriseValue)) return r.enterpriseValue;
  if (!isNum(r.marketCap) || !isNum(r.ibd) || !isNum(r.cash)) return null;
  const sd = isNum(r.shortTermDeposits) ? r.shortTermDeposits : 0;
  const nci = isNum(r.nci) ? r.nci : 0;
  return r.marketCap + (r.ibd - r.cash - sd) + nci;
}

/** 손익 항목을 12개월 기준으로 맞춘다. 맞출 수 없으면 사유를 돌려준다. */
function flow(r: PeerRow, v: number | null | undefined, opt: PeerStatsOptions): { value?: number; reason?: string; note?: string } {
  if (!isNum(v)) return { reason: "손익 항목 결측" };
  const m = isNum(r.incomeMonths) ? r.incomeMonths : 12;
  if (m === 12) return { value: v };
  if (opt.partial_period === "annualize") return { value: v * 12 / m, note: `${m}개월 누적 × 12/${m} 연환산(계절성 미반영)` };
  return { reason: `손익이 ${m}개월 누적(연간 아님) — LTM 또는 annualize 필요` };
}

function compute(metric: MetricKey, r: PeerRow, opt: PeerStatsOptions): { value?: number; reason?: string; note?: string } {
  switch (metric) {
    case "ev_sales":
    case "ev_ebit":
    case "ev_ebitda": {
      const ev = evOf(r);
      if (ev === null) return { reason: "EV 산출 필드 결측(시가총액·이자부부채·현금)" };
      if (ev <= 0) return { reason: "EV ≤ 0" };
      let base;
      if (metric === "ev_sales") base = flow(r, r.revenue, opt);
      else if (metric === "ev_ebit") base = flow(r, r.operatingIncome, opt);
      else {
        if (!isNum(r.depreciationAmortization)) return { reason: "감가상각비 결측(EBITDA 산출 불가)" };
        if (!isNum(r.operatingIncome)) return { reason: "영업이익 결측" };
        base = flow(r, r.operatingIncome + r.depreciationAmortization, opt);
      }
      if (base.reason) return base;
      if ((base.value as number) <= 0) return { reason: "분모 ≤ 0(적자 또는 0)" };
      return { value: ev / (base.value as number), note: base.note };
    }
    case "per": {
      if (!isNum(r.marketCap)) return { reason: "시가총액 결측" };
      const ni = flow(r, r.netIncomeParent, opt);
      if (ni.reason) return ni;
      if ((ni.value as number) <= 0) return { reason: "지배순이익 ≤ 0" };
      return { value: r.marketCap / (ni.value as number), note: ni.note };
    }
    case "pbr": {
      if (!isNum(r.marketCap)) return { reason: "시가총액 결측" };
      if (!isNum(r.equityParent)) return { reason: "지배자본 결측" };
      if (r.equityParent <= 0) return { reason: "지배자본 ≤ 0(자본잠식)" };
      return { value: r.marketCap / r.equityParent };
    }
    case "unlevered_beta": {
      if (!isNum(opt.tax_rate_pct)) return { reason: "tax_rate_pct 미입력" };
      if (!isNum(r.beta)) return { reason: "베타 결측" };
      if (!isNum(r.marketCap) || r.marketCap <= 0) return { reason: "시가총액 결측" };
      if (!isNum(r.ibd)) return { reason: "이자부부채 결측" };
      const def = opt.debt_definition ?? "ibd_total";
      let d = r.ibd;
      if (def === "ibd_ex_lease") d = r.ibd - (isNum(r.lease) ? r.lease : 0);
      if (def === "net_debt") {
        if (!isNum(r.cash)) return { reason: "현금 결측(순차입금 정의)" };
        d = r.ibd - r.cash - (isNum(r.shortTermDeposits) ? r.shortTermDeposits : 0);
      }
      // 순현금(D<0)이면 D/E를 0으로 둔다 — 음의 부채로 베타를 키우지 않는다.
      const de = Math.max(d, 0) / r.marketCap;
      const t = opt.tax_rate_pct / 100;
      return { value: r.beta / (1 + (1 - t) * de), note: `D/E ${round(de)}${d < 0 ? " (순현금 → 0 처리)" : ""}` };
    }
  }
}

const DEFINITION: Record<MetricKey, string> = {
  ev_sales: "EV = 시가총액 + (이자부부채 − 현금 − 단기금융상품) + 비지배지분, 분모 매출액",
  ev_ebit: "분모 영업이익(EBIT 대용)",
  ev_ebitda: "분모 영업이익 + 감가상각비",
  per: "시가총액 / 지배주주순이익",
  pbr: "시가총액 / 지배주주지분",
  unlevered_beta: "βu = βL / (1 + (1 − t) × D/E), E = 시가총액",
};

export function peerStatistics(rows: PeerRow[], opt: PeerStatsOptions = {}) {
  const metrics = opt.metrics?.length ? Array.from(new Set(opt.metrics)) : (["ev_sales", "ev_ebit", "ev_ebitda", "per", "pbr", "unlevered_beta"] as MetricKey[]);
  const rule = opt.outlier_rule ?? "none";
  const B = Math.min(Math.max(opt.bootstrap_resamples ?? 10000, 1000), 20000);

  // 같은 종목이 두 번 들어오면 분포를 끌어당긴다 — 종목코드로 병합(첫 행 유지)하고 그 사실을 싣는다.
  const seen = new Set<string>(); const dupes: string[] = []; const uniq: PeerRow[] = [];
  for (const r of rows) { if (seen.has(r.code)) { dupes.push(r.code); continue; } seen.add(r.code); uniq.push(r); }

  const globalWarnings: string[] = [];
  if (dupes.length) globalWarnings.push(`중복 종목 ${dupes.length}건을 제외했습니다: ${dupes.join(", ")}`);
  const reports = Array.from(new Set(uniq.map(r => r.report).filter(Boolean)));
  if (reports.length > 1) globalWarnings.push(`근거 보고서가 섞여 있습니다(${reports.join(" / ")}). 시점·기간이 다른 값이 한 분포에 들어갔을 수 있습니다.`);
  for (const r of uniq) for (const n of r.dataNotes ?? []) globalWarnings.push(`${r.name ?? r.code}(${r.code}) 원천 데이터 확인 필요: ${n}`);
  globalWarnings.push("피어가 현재(또는 기준일) 상장사로만 구성되면 상장폐지 기업이 빠져 멀티플이 높게 나올 수 있습니다(생존편향).");

  const summaries: MetricSummary[] = metrics.map((metric) => {
    const excluded: Exclusion[] = [];
    const vals: Value[] = [];
    for (const r of uniq) {
      const c = compute(metric, r, opt);
      if (c.reason) excluded.push({ code: r.code, name: r.name, reason: c.reason });
      else vals.push({ code: r.code, name: r.name, value: c.value as number, outlier: false, note: c.note });
    }
    const warnings: string[] = [];
    const sortedAll = vals.map(v => v.value).sort((a, b) => a - b);
    let flagged: string[] = [], removed: string[] = [];
    if (sortedAll.length >= 4) {
      const q1 = quantile(sortedAll, 0.25), q3 = quantile(sortedAll, 0.75), iqr = q3 - q1;
      const k = rule === "tukey_3" ? 3 : 1.5;
      for (const v of vals) if (v.value < q1 - k * iqr || v.value > q3 + k * iqr) { v.outlier = true; flagged.push(v.code); }
      if (rule !== "none") removed = flagged.slice();
    }
    const used = vals.filter(v => !removed.includes(v.code));
    for (const code of removed) excluded.push({ code, name: vals.find(v => v.code === code)?.name, reason: `이상치(${rule})` });
    const s = used.map(v => v.value).sort((a, b) => a - b);
    const n = s.length;
    if (n === 0) warnings.push("사용 가능한 표본이 없습니다.");
    else if (n < 3) warnings.push(`표본 ${n}개 — 사분위·구간을 내지 않습니다. 대표값으로 쓰기 어렵습니다.`);
    else if (n < 5) warnings.push(`표본 ${n}개 — 얇은 표본입니다. 중앙값 95% 구간을 함께 보십시오.`);
    if (uniq.length > 0 && excluded.length / uniq.length >= 0.3) warnings.push(`입력 ${uniq.length}개 중 ${excluded.length}개(${Math.round(excluded.length / uniq.length * 100)}%)가 제외됐습니다. 제외가 특정 유형(적자 기업 등)에 쏠리면 남은 표본이 편향됩니다.`);
    if (metric === "ev_ebitda" && excluded.some(e => e.reason.startsWith("감가상각비"))) warnings.push("감가상각비가 없는 행이 있습니다 — EV/EBITDA 표본이 다른 멀티플보다 작을 수 있습니다.");

    const byReason: Record<string, number> = {};
    for (const e of excluded) byReason[e.reason] = (byReason[e.reason] ?? 0) + 1;

    return {
      metric, label: METRIC_LABEL[metric], definition: DEFINITION[metric],
      nInput: uniq.length, nUsed: n, excluded, excludedByReason: byReason,
      outlierRule: rule === "none" ? "제외 없음 — Tukey 1.5·IQR 밖 값은 표시만" : `Tukey ${rule === "tukey_3" ? 3 : 1.5}·IQR 밖 값 제외`,
      outliersFlagged: flagged, outliersRemoved: removed,
      median: n ? round(median(s)) : null,
      q1: n >= 3 ? round(quantile(s, 0.25)) : null,
      q3: n >= 3 ? round(quantile(s, 0.75)) : null,
      mean: n ? round(s.reduce((a, b) => a + b, 0) / n) : null,
      min: n ? round(s[0]) : null,
      max: n ? round(s[n - 1]) : null,
      medianBootstrap95: n >= 3 ? (bootstrapMedianCI(s, B).map(v => round(v)) as [number, number]) : null,
      values: vals.map(v => ({ ...v, value: round(v.value) as number })),
      warnings,
    };
  });

  return {
    method: {
      대표값: "중앙값(평균은 참고)",
      사분위: "선형보간(R type 7, 엑셀 QUARTILE.INC)",
      중앙값구간: `부트스트랩 복원추출 ${B}회 95% 구간(고정 시드 — 같은 입력이면 같은 값)`,
      이상치: rule === "none" ? "자동 제외 없음(표시만)" : `Tukey 울타리(${rule}) 밖 제외`,
      손익기간: (opt.partial_period ?? "exclude") === "exclude" ? "12개월 미만 누적은 흐름 멀티플에서 제외" : "12개월 미만 누적은 단순 연환산",
      부채정의: opt.debt_definition ?? "ibd_total",
    },
    nInput: rows.length,
    nAfterDedup: uniq.length,
    metrics: summaries,
    warnings: globalWarnings,
  };
}
