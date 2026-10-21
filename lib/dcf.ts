/**
 * DCF 계산 — dart-mcp/lib/dcf.js(전무님 자체 코드)를 TypeScript로 옮긴 것.
 * 계산식·반올림·민감도 표·경고 문구를 원본과 한 글자도 다르지 않게 유지한다(test/dcf-equivalence 로 대조).
 * WACC 산식(buildWacc)은 wacc_calculate 도구와 이 파일이 함께 쓴다 — 산식은 한 벌만 둔다.
 * 외부 호출이 없고 같은 입력이면 항상 같은 결과를 준다. 비율은 퍼센트 숫자(9.5 = 9.5%).
 */

export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export const r2 = (v: number) => Math.round(v * 100) / 100;
export const r4 = (v: number) => Math.round(v * 10000) / 10000;

export interface DcfInput {
  unit?: string;
  first_year?: number;
  fcf?: number[];
  base_fcf?: number;
  growth_rates_pct?: number[];
  wacc_pct?: number;
  risk_free_pct?: number;
  mrp_pct?: number;
  beta?: number;
  unlevered_beta?: number;
  size_premium_pct?: number;
  cost_of_debt_pct?: number;
  tax_rate_pct?: number;
  debt_to_equity?: number;
  debt_weight_pct?: number;
  terminal_growth_pct?: number;
  exit_multiple?: number;
  terminal_metric?: number;
  mid_year?: boolean;
  net_debt?: number;
  non_controlling_interest?: number;
  non_operating_assets?: number;
  shares_outstanding?: number;
  sensitivity?: {
    wacc_step_pct?: number; wacc_steps?: number;
    growth_step_pct?: number; multiple_step?: number; second_steps?: number;
  };
}

export type WaccInput = Pick<DcfInput,
  "wacc_pct" | "risk_free_pct" | "mrp_pct" | "beta" | "unlevered_beta" | "size_premium_pct" |
  "cost_of_debt_pct" | "tax_rate_pct" | "debt_to_equity" | "debt_weight_pct">;

export interface WaccDetail { [k: string]: string | number }

export function buildFcf(a: DcfInput): { fcf: number[]; how: string } {
  if (Array.isArray(a.fcf) && a.fcf.length) {
    if (!a.fcf.every(isNum)) throw new Error("fcf는 숫자 배열이어야 합니다");
    return { fcf: a.fcf.slice(), how: "직접 입력" };
  }
  if (isNum(a.base_fcf) && Array.isArray(a.growth_rates_pct) && a.growth_rates_pct.length) {
    if (!a.growth_rates_pct.every(isNum)) throw new Error("growth_rates_pct는 숫자 배열이어야 합니다");
    const out: number[] = []; let prev = a.base_fcf;
    for (const g of a.growth_rates_pct) { prev = prev * (1 + g / 100); out.push(prev); }
    return { fcf: out, how: `기준 FCF ${a.base_fcf} × 연도별 성장률` };
  }
  throw new Error("fcf 배열 또는 base_fcf + growth_rates_pct가 필요합니다");
}

export function buildWacc(a: WaccInput): { wacc: number; detail: WaccDetail } {
  if (isNum(a.wacc_pct)) return { wacc: a.wacc_pct / 100, detail: { 방식: "직접 입력", wacc_pct: a.wacc_pct } };
  const need = ["risk_free_pct", "mrp_pct", "cost_of_debt_pct", "tax_rate_pct"] as const;
  const miss: string[] = need.filter(k => !isNum(a[k]));
  if (!isNum(a.beta) && !isNum(a.unlevered_beta)) miss.push("beta 또는 unlevered_beta");
  if (!isNum(a.debt_to_equity) && !isNum(a.debt_weight_pct)) miss.push("debt_to_equity 또는 debt_weight_pct");
  if (miss.length) throw new Error(`wacc_pct가 없으면 다음 값이 필요합니다: ${miss.join(", ")}`);
  const t = (a.tax_rate_pct as number) / 100;
  let de: number, wd: number;
  if (isNum(a.debt_to_equity)) { de = a.debt_to_equity; wd = de / (1 + de); }
  else { wd = (a.debt_weight_pct as number) / 100; if (wd >= 1) throw new Error("debt_weight_pct는 100 미만이어야 합니다"); de = wd / (1 - wd); }
  const we = 1 - wd;
  let betaL: number, betaHow: string;
  if (isNum(a.unlevered_beta)) { betaL = a.unlevered_beta * (1 + (1 - t) * de); betaHow = `언레버드 ${a.unlevered_beta} × (1 + (1 - 세율) × D/E ${r4(de)})`; }
  else { betaL = a.beta as number; betaHow = "레버드 베타 직접 입력"; }
  const sp = isNum(a.size_premium_pct) ? a.size_premium_pct / 100 : 0;
  const ke = (a.risk_free_pct as number) / 100 + betaL * ((a.mrp_pct as number) / 100) + sp;
  const kdAfter = ((a.cost_of_debt_pct as number) / 100) * (1 - t);
  const wacc = we * ke + wd * kdAfter;
  return {
    wacc,
    detail: {
      방식: "CAPM으로 계산", 레버드베타: r4(betaL), 베타산출: betaHow,
      자기자본비용_pct: r2(ke * 100), 세후타인자본비용_pct: r2(kdAfter * 100),
      자기자본비중_pct: r2(we * 100), 부채비중_pct: r2(wd * 100), 규모프리미엄_pct: r2(sp * 100), wacc_pct: r2(wacc * 100),
    },
  };
}

type Tv = { kind: "gordon"; g: number } | { kind: "multiple"; multiple: number; metric: number };

function valueOnce(fcf: number[], wacc: number, tv: Tv, midYear: boolean) {
  const n = fcf.length;
  let pvSum = 0; const rows: { t: number; df: number; pv: number }[] = [];
  fcf.forEach((v, i) => {
    const t = midYear ? i + 0.5 : i + 1;
    const df = 1 / Math.pow(1 + wacc, t);
    pvSum += v * df; rows.push({ t, df, pv: v * df });
  });
  let tvValue: number;
  if (tv.kind === "gordon") {
    if (wacc <= tv.g) throw new Error(`할인율(${r2(wacc * 100)}%)이 영구성장률(${r2(tv.g * 100)}%)보다 커야 합니다`);
    tvValue = fcf[n - 1] * (1 + tv.g) / (wacc - tv.g);
  } else {
    tvValue = tv.multiple * tv.metric;
  }
  const pvTv = tvValue / Math.pow(1 + wacc, n);
  return { rows, pvSum, tvValue, pvTv, ev: pvSum + pvTv };
}

export function calculateDcf(a: DcfInput) {
  a = a || {};
  const { fcf, how } = buildFcf(a);
  const { wacc, detail } = buildWacc(a);
  let tv: Tv;
  if (isNum(a.terminal_growth_pct)) tv = { kind: "gordon", g: a.terminal_growth_pct / 100 };
  else if (isNum(a.exit_multiple) && isNum(a.terminal_metric)) tv = { kind: "multiple", multiple: a.exit_multiple, metric: a.terminal_metric };
  else throw new Error("terminal_growth_pct 또는 exit_multiple + terminal_metric이 필요합니다");
  const mid = !!a.mid_year;
  const base = valueOnce(fcf, wacc, tv, mid);

  const nd = isNum(a.net_debt) ? a.net_debt : null;
  const nci = isNum(a.non_controlling_interest) ? a.non_controlling_interest : 0;
  const noa = isNum(a.non_operating_assets) ? a.non_operating_assets : 0;
  const equityOf = (ev: number) => (nd === null ? null : ev - nd - nci + noa);
  const perShareOf = (ev: number) => { const e = equityOf(ev); return e !== null && isNum(a.shares_outstanding) && a.shares_outstanding > 0 ? e / a.shares_outstanding : null; };

  const y0 = Number.isInteger(a.first_year) ? (a.first_year as number) : null;
  const table = fcf.map((v, i) => ({
    연도: y0 !== null ? y0 + i : `${i + 1}년차`, FCF: r2(v), 할인시점: base.rows[i].t, 할인계수: r4(base.rows[i].df), 현재가치: r2(base.rows[i].pv),
  }));

  const s = a.sensitivity || {};
  const wStep = (isNum(s.wacc_step_pct) ? s.wacc_step_pct : 0.5) / 100;
  const wN = Number.isInteger(s.wacc_steps) ? Math.min(Math.max(s.wacc_steps as number, 1), 4) : 2;
  const sN = Number.isInteger(s.second_steps) ? Math.min(Math.max(s.second_steps as number, 1), 4) : 2;
  const waccs: number[] = []; for (let i = -wN; i <= wN; i++) waccs.push(wacc + i * wStep);
  let seconds: number[], secondLabel: string, mk: (x: number) => Tv;
  if (tv.kind === "gordon") {
    const g0 = tv.g;
    const gStep = (isNum(s.growth_step_pct) ? s.growth_step_pct : 0.25) / 100;
    seconds = []; for (let i = -sN; i <= sN; i++) seconds.push(g0 + i * gStep);
    secondLabel = "영구성장률_pct"; mk = (x) => ({ kind: "gordon", g: x });
  } else {
    const m0 = tv.multiple, metric = tv.metric;
    const mStep = isNum(s.multiple_step) ? s.multiple_step : 0.5;
    seconds = []; for (let i = -sN; i <= sN; i++) seconds.push(m0 + i * mStep);
    secondLabel = "잔존가치배수"; mk = (x) => ({ kind: "multiple", multiple: x, metric });
  }
  const outKey = perShareOf(base.ev) !== null ? "주당가치" : (equityOf(base.ev) !== null ? "주주가치" : "기업가치");
  const grid = waccs.map(w => {
    const row: Record<string, number | null> = { 할인율_pct: r2(w * 100) };
    seconds.forEach(x => {
      const col = tv.kind === "gordon" ? `g ${r2(x * 100)}%` : `${r2(x)}배`;
      try {
        const v = valueOnce(fcf, w, mk(x), mid);
        const val = outKey === "주당가치" ? perShareOf(v.ev) : outKey === "주주가치" ? equityOf(v.ev) : v.ev;
        row[col] = r2(val as number);
      } catch { row[col] = null; }
    });
    return row;
  });

  const warnings: string[] = [];
  const tvShare = base.ev !== 0 ? base.pvTv / base.ev : null;
  if (tvShare !== null && tvShare > 0.75) warnings.push(`잔존가치가 기업가치의 ${r2(tvShare * 100)}%입니다. 결과가 영구성장률·배수 가정에 크게 좌우됩니다.`);
  if (tv.kind === "gordon" && isNum(a.risk_free_pct) && tv.g * 100 > a.risk_free_pct) warnings.push("영구성장률이 무위험이자율보다 높습니다. 장기 경제성장률 수준인지 확인이 필요합니다.");
  if (fcf.some(v => v < 0)) warnings.push("음(-)의 FCF가 있는 연도가 있습니다.");
  if (fcf[fcf.length - 1] < 0 && tv.kind === "gordon") warnings.push("마지막 해 FCF가 음수라 영구성장 잔존가치가 음수입니다. 정상화된 FCF를 쓰는지 확인이 필요합니다.");
  if (nd === null) warnings.push("net_debt가 없어 주주가치·주당가치는 계산하지 않았습니다.");

  const out = {
    단위: a.unit || "(미지정)",
    가정: {
      FCF산출: how, 추정연수: fcf.length, 할인율: detail as WaccDetail & Record<string, unknown>,
      잔존가치: tv.kind === "gordon" ? { 방식: "영구성장(고든)", 영구성장률_pct: r2(tv.g * 100) } : { 방식: "배수", 배수: tv.multiple, 지표값: tv.metric },
      할인관행: mid ? "연중 현금흐름(t-0.5), 잔존가치는 N년 말" : "연말 현금흐름(t), 잔존가치는 N년 말",
      순차입금: nd, 비지배지분: nci, 비영업자산: noa, 주식수: isNum(a.shares_outstanding) ? a.shares_outstanding : null,
    },
    연도별: table,
    결과: {
      추정기간_현재가치합: r2(base.pvSum), 잔존가치: r2(base.tvValue), 잔존가치_현재가치: r2(base.pvTv),
      기업가치: r2(base.ev), 잔존가치비중_pct: tvShare === null ? null : r2(tvShare * 100),
      주주가치: equityOf(base.ev) === null ? null : r2(equityOf(base.ev) as number),
      주당가치: perShareOf(base.ev) === null ? null : r2(perShareOf(base.ev) as number),
    },
    민감도: { 값: outKey, 행: "할인율_pct", 열: secondLabel, 표: grid },
    경고: warnings,
  };

  const f = (v: unknown) => (v === null || v === undefined ? "-" : Number(v).toLocaleString("ko-KR", { maximumFractionDigits: 2 }));
  const cols = Object.keys(grid[0]);
  const md = [
    `DCF 계산 결과 (단위: ${out.단위})`,
    "",
    `- 할인율 ${r2(wacc * 100)}% (${detail.방식}) · 잔존가치 ${out.가정.잔존가치.방식} · ${out.가정.할인관행}`,
    `- 기업가치 ${f(out.결과.기업가치)} = 추정기간 현재가치 ${f(out.결과.추정기간_현재가치합)} + 잔존가치 현재가치 ${f(out.결과.잔존가치_현재가치)} (잔존가치 비중 ${f(out.결과.잔존가치비중_pct)}%)`,
    `- 주주가치 ${f(out.결과.주주가치)} · 주당가치 ${f(out.결과.주당가치)}`,
    "",
    "| 연도 | FCF | 할인계수 | 현재가치 |", "|---|---:|---:|---:|",
    ...table.map(r => `| ${r.연도} | ${f(r.FCF)} | ${r.할인계수} | ${f(r.현재가치)} |`),
    "",
    `민감도 (${outKey}, 행 = 할인율 %, 열 = ${tv.kind === "gordon" ? "영구성장률" : "배수"})`,
    "", "| " + cols.join(" | ") + " |", "|" + cols.map(() => "---:").join("|") + "|",
    ...grid.map(r => "| " + cols.map(c => f(r[c])).join(" | ") + " |"),
    ...(warnings.length ? ["", "경고:", ...warnings.map(w => `- ${w}`)] : []),
  ];
  return { text: md.join("\n"), structured: out };
}
