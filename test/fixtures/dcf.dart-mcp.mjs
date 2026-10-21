// dart-mcp / lib/dcf.js — DCF 계산 도구.
// 업무 에이전트 중계 서버(agent-relay-mcp)는 이 도구를 그대로 넘겨 쓴다(계산 코드는 이 파일 한 벌만 둔다).
// 숫자 계산은 모델이 암산하지 않고 이 함수로 한다. 외부 호출이 없고 같은 입력이면 항상 같은 결과를 준다.
// 비율은 모두 퍼센트 숫자로 받는다(9.5 = 9.5%). 금액 단위는 받은 그대로 쓰고 unit 라벨만 붙인다.

const TOOL = {
  name: "dcf_calculate",
  description: [
    "현금흐름할인법(DCF) 계산기. 추정 잉여현금흐름(FCF)과 할인율·영구성장률 등 가정을 받아 기업가치·주주가치·주당가치와 민감도 표를 계산한다.",
    "조회는 하지 않는다. 베타·순차입금·주식수는 밸류에이션 서버나 공시에서, 무위험이자율은 국고채 수익률 조회로 먼저 확보해 넣는다.",
    "비율은 퍼센트 숫자(9.5 = 9.5%). FCF는 fcf(연도별 값 배열) 또는 base_fcf + growth_rates_pct(연도별 성장률) 중 하나로 준다.",
    "할인율은 wacc_pct를 직접 주거나, risk_free_pct·mrp_pct·beta(또는 unlevered_beta)·cost_of_debt_pct·tax_rate_pct·debt_to_equity(또는 debt_weight_pct)로 계산하게 한다.",
    "잔존가치는 terminal_growth_pct(영구성장) 또는 exit_multiple + terminal_metric(마지막 해 EBITDA 등)으로 준다.",
    "결과에는 쓰인 가정이 모두 들어 있으므로, 답변에 가정을 밝히고 다른 가정이 필요하면 다시 계산하겠다고 안내한다."
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      unit: { type: "string", description: "금액 단위 라벨(예: 백만원). 계산에는 쓰지 않는다" },
      first_year: { type: "integer", description: "추정 1년차의 연도(예: 2026). 표 라벨용" },
      fcf: { type: "array", items: { type: "number" }, description: "추정 1년차부터의 연도별 잉여현금흐름(FCFF)" },
      base_fcf: { type: "number", description: "기준 연도 FCF. growth_rates_pct와 함께 쓴다" },
      growth_rates_pct: { type: "array", items: { type: "number" }, description: "연도별 FCF 성장률(%). 길이 = 추정 연수" },
      wacc_pct: { type: "number", description: "가중평균자본비용(%)을 직접 줄 때" },
      risk_free_pct: { type: "number", description: "무위험이자율(%)" },
      mrp_pct: { type: "number", description: "시장위험프리미엄(%)" },
      beta: { type: "number", description: "레버드 베타(그대로 사용)" },
      unlevered_beta: { type: "number", description: "언레버드 베타. debt_to_equity와 tax_rate_pct로 다시 레버드한다" },
      size_premium_pct: { type: "number", description: "규모 위험 프리미엄 등 추가 가산(%). 기본 0" },
      cost_of_debt_pct: { type: "number", description: "세전 타인자본비용(%)" },
      tax_rate_pct: { type: "number", description: "법인세율(%)" },
      debt_to_equity: { type: "number", description: "목표 부채/자기자본 비율(배수, 예: 0.3)" },
      debt_weight_pct: { type: "number", description: "부채 비중 D/(D+E)(%). debt_to_equity 대신 쓸 때" },
      terminal_growth_pct: { type: "number", description: "영구성장률(%)" },
      exit_multiple: { type: "number", description: "잔존가치 배수(예: EV/EBITDA 8배)" },
      terminal_metric: { type: "number", description: "exit_multiple을 곱할 마지막 해 지표 값" },
      mid_year: { type: "boolean", description: "연중 현금흐름 가정(할인 시점 t-0.5). 기본 false. 잔존가치는 항상 N년 말에 할인" },
      net_debt: { type: "number", description: "순차입금(이자부부채 - 현금성자산). 순현금이면 음수" },
      non_controlling_interest: { type: "number", description: "비지배지분" },
      non_operating_assets: { type: "number", description: "비영업자산(더함)" },
      shares_outstanding: { type: "number", description: "주식수(주당가치 계산용)" },
      sensitivity: {
        type: "object",
        description: "민감도 표 설정. 기본: 할인율 ±1%p(0.5 간격), 영구성장률 ±0.5%p(0.25 간격) 또는 배수 ±1(0.5 간격)",
        properties: {
          wacc_step_pct: { type: "number" }, wacc_steps: { type: "integer" },
          growth_step_pct: { type: "number" }, multiple_step: { type: "number" }, second_steps: { type: "integer" }
        }
      }
    },
    additionalProperties: false
  },
  annotations: { readOnlyHint: true }
};

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 10000) / 10000;

function buildFcf(a) {
  if (Array.isArray(a.fcf) && a.fcf.length) {
    if (!a.fcf.every(isNum)) throw new Error("fcf는 숫자 배열이어야 합니다");
    return { fcf: a.fcf.slice(), how: "직접 입력" };
  }
  if (isNum(a.base_fcf) && Array.isArray(a.growth_rates_pct) && a.growth_rates_pct.length) {
    if (!a.growth_rates_pct.every(isNum)) throw new Error("growth_rates_pct는 숫자 배열이어야 합니다");
    const out = []; let prev = a.base_fcf;
    for (const g of a.growth_rates_pct) { prev = prev * (1 + g / 100); out.push(prev); }
    return { fcf: out, how: `기준 FCF ${a.base_fcf} × 연도별 성장률` };
  }
  throw new Error("fcf 배열 또는 base_fcf + growth_rates_pct가 필요합니다");
}

function buildWacc(a) {
  if (isNum(a.wacc_pct)) return { wacc: a.wacc_pct / 100, detail: { 방식: "직접 입력", wacc_pct: a.wacc_pct } };
  const need = ["risk_free_pct", "mrp_pct", "cost_of_debt_pct", "tax_rate_pct"];
  const miss = need.filter(k => !isNum(a[k]));
  if (!isNum(a.beta) && !isNum(a.unlevered_beta)) miss.push("beta 또는 unlevered_beta");
  if (!isNum(a.debt_to_equity) && !isNum(a.debt_weight_pct)) miss.push("debt_to_equity 또는 debt_weight_pct");
  if (miss.length) throw new Error(`wacc_pct가 없으면 다음 값이 필요합니다: ${miss.join(", ")}`);
  const t = a.tax_rate_pct / 100;
  let de, wd;
  if (isNum(a.debt_to_equity)) { de = a.debt_to_equity; wd = de / (1 + de); }
  else { wd = a.debt_weight_pct / 100; if (wd >= 1) throw new Error("debt_weight_pct는 100 미만이어야 합니다"); de = wd / (1 - wd); }
  const we = 1 - wd;
  let betaL, betaHow;
  if (isNum(a.unlevered_beta)) { betaL = a.unlevered_beta * (1 + (1 - t) * de); betaHow = `언레버드 ${a.unlevered_beta} × (1 + (1 - 세율) × D/E ${r4(de)})`; }
  else { betaL = a.beta; betaHow = "레버드 베타 직접 입력"; }
  const sp = isNum(a.size_premium_pct) ? a.size_premium_pct / 100 : 0;
  const ke = a.risk_free_pct / 100 + betaL * (a.mrp_pct / 100) + sp;
  const kdAfter = (a.cost_of_debt_pct / 100) * (1 - t);
  const wacc = we * ke + wd * kdAfter;
  return {
    wacc,
    detail: {
      방식: "CAPM으로 계산", 레버드베타: r4(betaL), 베타산출: betaHow,
      자기자본비용_pct: r2(ke * 100), 세후타인자본비용_pct: r2(kdAfter * 100),
      자기자본비중_pct: r2(we * 100), 부채비중_pct: r2(wd * 100), 규모프리미엄_pct: r2(sp * 100), wacc_pct: r2(wacc * 100)
    }
  };
}

// 한 가지 할인율·잔존가치 가정으로 기업가치를 낸다.
function valueOnce(fcf, wacc, tv, midYear) {
  const n = fcf.length;
  let pvSum = 0; const rows = [];
  fcf.forEach((v, i) => {
    const t = midYear ? i + 0.5 : i + 1;
    const df = 1 / Math.pow(1 + wacc, t);
    pvSum += v * df; rows.push({ t, df, pv: v * df });
  });
  let tvValue;
  if (tv.kind === "gordon") {
    if (wacc <= tv.g) throw new Error(`할인율(${r2(wacc * 100)}%)이 영구성장률(${r2(tv.g * 100)}%)보다 커야 합니다`);
    tvValue = fcf[n - 1] * (1 + tv.g) / (wacc - tv.g);
  } else {
    tvValue = tv.multiple * tv.metric;
  }
  const pvTv = tvValue / Math.pow(1 + wacc, n);
  return { rows, pvSum, tvValue, pvTv, ev: pvSum + pvTv };
}

function calculate(a) {
  a = a || {};
  const { fcf, how } = buildFcf(a);
  const { wacc, detail } = buildWacc(a);
  let tv;
  if (isNum(a.terminal_growth_pct)) tv = { kind: "gordon", g: a.terminal_growth_pct / 100 };
  else if (isNum(a.exit_multiple) && isNum(a.terminal_metric)) tv = { kind: "multiple", multiple: a.exit_multiple, metric: a.terminal_metric };
  else throw new Error("terminal_growth_pct 또는 exit_multiple + terminal_metric이 필요합니다");
  const mid = !!a.mid_year;
  const base = valueOnce(fcf, wacc, tv, mid);

  const nd = isNum(a.net_debt) ? a.net_debt : null;
  const nci = isNum(a.non_controlling_interest) ? a.non_controlling_interest : 0;
  const noa = isNum(a.non_operating_assets) ? a.non_operating_assets : 0;
  const equityOf = (ev) => (nd === null ? null : ev - nd - nci + noa);
  const perShareOf = (ev) => { const e = equityOf(ev); return e !== null && isNum(a.shares_outstanding) && a.shares_outstanding > 0 ? e / a.shares_outstanding : null; };

  const y0 = Number.isInteger(a.first_year) ? a.first_year : null;
  const table = fcf.map((v, i) => ({
    연도: y0 !== null ? y0 + i : `${i + 1}년차`, FCF: r2(v), 할인시점: base.rows[i].t, 할인계수: r4(base.rows[i].df), 현재가치: r2(base.rows[i].pv)
  }));

  // 민감도 표
  const s = a.sensitivity || {};
  const wStep = (isNum(s.wacc_step_pct) ? s.wacc_step_pct : 0.5) / 100;
  const wN = Number.isInteger(s.wacc_steps) ? Math.min(Math.max(s.wacc_steps, 1), 4) : 2;
  const sN = Number.isInteger(s.second_steps) ? Math.min(Math.max(s.second_steps, 1), 4) : 2;
  const waccs = []; for (let i = -wN; i <= wN; i++) waccs.push(wacc + i * wStep);
  let seconds, secondLabel, mk;
  if (tv.kind === "gordon") {
    const gStep = (isNum(s.growth_step_pct) ? s.growth_step_pct : 0.25) / 100;
    seconds = []; for (let i = -sN; i <= sN; i++) seconds.push(tv.g + i * gStep);
    secondLabel = "영구성장률_pct"; mk = (x) => ({ kind: "gordon", g: x });
  } else {
    const mStep = isNum(s.multiple_step) ? s.multiple_step : 0.5;
    seconds = []; for (let i = -sN; i <= sN; i++) seconds.push(tv.multiple + i * mStep);
    secondLabel = "잔존가치배수"; mk = (x) => ({ kind: "multiple", multiple: x, metric: tv.metric });
  }
  const outKey = perShareOf(base.ev) !== null ? "주당가치" : (equityOf(base.ev) !== null ? "주주가치" : "기업가치");
  const grid = waccs.map(w => {
    const row = { 할인율_pct: r2(w * 100) };
    seconds.forEach(x => {
      const col = tv.kind === "gordon" ? `g ${r2(x * 100)}%` : `${r2(x)}배`;
      try {
        const v = valueOnce(fcf, w, mk(x), mid);
        const val = outKey === "주당가치" ? perShareOf(v.ev) : outKey === "주주가치" ? equityOf(v.ev) : v.ev;
        row[col] = r2(val);
      } catch (e) { row[col] = null; }
    });
    return row;
  });

  const warnings = [];
  const tvShare = base.ev !== 0 ? base.pvTv / base.ev : null;
  if (tvShare !== null && tvShare > 0.75) warnings.push(`잔존가치가 기업가치의 ${r2(tvShare * 100)}%입니다. 결과가 영구성장률·배수 가정에 크게 좌우됩니다.`);
  if (tv.kind === "gordon" && isNum(a.risk_free_pct) && tv.g * 100 > a.risk_free_pct) warnings.push("영구성장률이 무위험이자율보다 높습니다. 장기 경제성장률 수준인지 확인이 필요합니다.");
  if (fcf.some(v => v < 0)) warnings.push("음(-)의 FCF가 있는 연도가 있습니다.");
  if (fcf[fcf.length - 1] < 0 && tv.kind === "gordon") warnings.push("마지막 해 FCF가 음수라 영구성장 잔존가치가 음수입니다. 정상화된 FCF를 쓰는지 확인이 필요합니다.");
  if (nd === null) warnings.push("net_debt가 없어 주주가치·주당가치는 계산하지 않았습니다.");

  const out = {
    단위: a.unit || "(미지정)",
    가정: {
      FCF산출: how, 추정연수: fcf.length, 할인율: detail,
      잔존가치: tv.kind === "gordon" ? { 방식: "영구성장(고든)", 영구성장률_pct: r2(tv.g * 100) } : { 방식: "배수", 배수: tv.multiple, 지표값: tv.metric },
      할인관행: mid ? "연중 현금흐름(t-0.5), 잔존가치는 N년 말" : "연말 현금흐름(t), 잔존가치는 N년 말",
      순차입금: nd, 비지배지분: nci, 비영업자산: noa, 주식수: isNum(a.shares_outstanding) ? a.shares_outstanding : null
    },
    연도별: table,
    결과: {
      추정기간_현재가치합: r2(base.pvSum), 잔존가치: r2(base.tvValue), 잔존가치_현재가치: r2(base.pvTv),
      기업가치: r2(base.ev), 잔존가치비중_pct: tvShare === null ? null : r2(tvShare * 100),
      주주가치: equityOf(base.ev) === null ? null : r2(equityOf(base.ev)),
      주당가치: perShareOf(base.ev) === null ? null : r2(perShareOf(base.ev))
    },
    민감도: { 값: outKey, 행: "할인율_pct", 열: secondLabel, 표: grid },
    경고: warnings
  };

  const fmt = (v) => (v === null || v === undefined ? "-" : Number(v).toLocaleString("ko-KR", { maximumFractionDigits: 2 }));
  const cols = Object.keys(grid[0]);
  const md = [
    `DCF 계산 결과 (단위: ${out.단위})`,
    "",
    `- 할인율 ${r2(wacc * 100)}% (${detail.방식}) · 잔존가치 ${out.가정.잔존가치.방식} · ${out.가정.할인관행}`,
    `- 기업가치 ${fmt(out.결과.기업가치)} = 추정기간 현재가치 ${fmt(out.결과.추정기간_현재가치합)} + 잔존가치 현재가치 ${fmt(out.결과.잔존가치_현재가치)} (잔존가치 비중 ${fmt(out.결과.잔존가치비중_pct)}%)`,
    `- 주주가치 ${fmt(out.결과.주주가치)} · 주당가치 ${fmt(out.결과.주당가치)}`,
    "",
    "| 연도 | FCF | 할인계수 | 현재가치 |", "|---|---:|---:|---:|",
    ...table.map(r => `| ${r.연도} | ${fmt(r.FCF)} | ${r.할인계수} | ${fmt(r.현재가치)} |`),
    "",
    `민감도 (${outKey}, 행 = 할인율 %, 열 = ${tv.kind === "gordon" ? "영구성장률" : "배수"})`,
    "", "| " + cols.join(" | ") + " |", "|" + cols.map(() => "---:").join("|") + "|",
    ...grid.map(r => "| " + cols.map(c => fmt(r[c])).join(" | ") + " |"),
    ...(warnings.length ? ["", "경고:", ...warnings.map(w => `- ${w}`)] : [])
  ];
  return { content: [{ type: "text", text: md.join("\n") }], structuredContent: out };
}

export { TOOL, calculate };
