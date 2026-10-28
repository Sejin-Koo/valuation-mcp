// 평가기준일 기준 할인(stub) — 독립 산식과 대조하고, 자동 계산(stubFromDates)을 확인한다.
import { calculateDcf } from "../lib/dcf.js";
import { stubFromDates } from "../lib/tools-calc.js";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, info = "") => { cond ? pass++ : fail++; console.log(`${cond ? "OK  " : "FAIL"} ${name}${info ? " — " + info : ""}`); };
const near = (a: number, b: number, tol = 0.02) => Math.abs(a - b) <= tol;

function ref(fcf: number[], w: number, g: number, stub: number, mid: boolean) {
  let pv = 0;
  fcf.forEach((v, i) => { const t = i === 0 ? (mid ? stub / 2 : stub) : (mid ? stub + i - 0.5 : stub + i); pv += v / Math.pow(1 + w, t); });
  const tv = fcf[fcf.length - 1] * (1 + g) / (w - g);
  return pv + tv / Math.pow(1 + w, stub + fcf.length - 1);
}
const fcf = [465, 1327, 1807, 2196, 2518];
for (const mid of [false, true]) {
  const r = calculateDcf({ fcf: fcf.slice(), wacc_pct: 7.675, terminal_growth_pct: 2, stub_fraction: 0.1781, mid_year: mid }).structured;
  const e = ref(fcf, 0.07675, 0.02, 0.1781, mid);
  ok(`stub 0.1781 mid=${mid}`, near(r.결과.기업가치, Math.round(e * 100) / 100), `${r.결과.기업가치} vs ${e.toFixed(2)}`);
}
// stub=1 이면 기존 관행과 같다
const a = calculateDcf({ fcf: fcf.slice(), wacc_pct: 9, terminal_growth_pct: 1.5 }).structured;
const b = calculateDcf({ fcf: fcf.slice(), wacc_pct: 9, terminal_growth_pct: 1.5, stub_fraction: 1 }).structured;
ok("stub 1 = 기존 관행", a.결과.기업가치 === b.결과.기업가치);
// prorate
const c = calculateDcf({ fcf: [1000, 1100, 1200], wacc_pct: 9, terminal_growth_pct: 1, stub_fraction: 0.25, stub_prorate: true }).structured;
ok("prorate 첫해 250", c.연도별[0].FCF === 250);
const d = calculateDcf({ fcf: fcf.slice(), wacc_pct: 7.675, terminal_growth_pct: 2, stub_fraction: 0.5 }).structured;
ok("stub<1 이면 기존보다 기업가치가 큼", d.결과.기업가치 > calculateDcf({ fcf: fcf.slice(), wacc_pct: 7.675, terminal_growth_pct: 2 }).structured.결과.기업가치);
ok("민감도 중앙 = 기본값", (() => { const row = d.민감도.표[2] as any; return near(row[Object.keys(row)[3]], d.결과.기업가치); })());
// 자동 계산
const s1 = stubFromDates("20261027", 2026, undefined, undefined);
ok("2026-10-27 → 65/365", s1.fraction === Math.round(65 / 365 * 10000) / 10000, String(s1.fraction));
ok("12-31 직전 회계연도 말이면 관행 유지", stubFromDates("20251231", 2026).fraction === undefined);
ok("직접 준 stub 우선", stubFromDates("20261027", 2026, undefined, 0.5).fraction === undefined);
ok("first_year 없으면 안내", !!stubFromDates("20261027", undefined).note);
ok("3월 결산", stubFromDates("20261027", 2027, "0331").fraction === Math.round(155 / 365 * 10000) / 10000, String(stubFromDates("20261027", 2027, "0331").fraction));
let threw = false; try { stubFromDates("20261231", 2026); } catch { threw = true; }
ok("평가일이 첫해 말 이후면 오류", threw);
let threw2 = false; try { calculateDcf({ fcf: [1, 2], wacc_pct: 9, terminal_growth_pct: 1, stub_fraction: 1.5 }); } catch { threw2 = true; }
ok("stub 범위 오류", threw2);
console.log(`pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
