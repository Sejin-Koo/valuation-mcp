// 감사보고서 재무 요약 단위 시험(외부 호출 없음). 표 모양은 2026-11-05 상장사 첨부·비상장 감사보고서 대조에서 찾은 것.
import assert from "node:assert/strict";
import { financialsFromAuditXml } from "../lib/audit-fin.js";

let n = 0; const ok = (m: string) => { n++; console.log("  OK", m); };
const tr = (...c: string[]) => `<TR>${c.map(x => `<TD>${x}</TD>`).join("")}</TR>`;
const tbl = (title: string, unit: string, head: string, body: string) =>
  `<TABLE><TBODY><TR><TD>${title}</TD></TR><TR><TD>(단위 : ${unit})</TD></TR></TBODY></TABLE><TABLE><THEAD>${head}</THEAD><TBODY>${body}</TBODY></TABLE>`;
const H = tr("과 목", "주석", "제 10(당) 기", "제 9(전) 기");

// 1. 일반기업회계기준: 영업손실·당기순손실 양수 표기, 현금흐름표에 상각비·유형자산 취득(종류별), 합계 밑줄 '===='
const xml1 =
  tbl("재 무 상 태 표", "천원", H, tr("현금및현금성자산", "", "100", "80") + tr("단기금융상품", "", "50", "") + tr("자산총계", "", "1,000", "900") + tr("유동부채", "", "", "") + tr("단기차입금", "", "300", "") + tr("부채총계", "", "400", "350") + tr("자본총계", "", "600", "550")) +
  tbl("손 익 계 산 서", "천원", H, tr("Ⅰ. 매출액", "", "2,000", "1,800") + tr("Ⅱ. 영업손실", "", "120", "(30)") + tr("법인세비용차감전순손실", "", "150", "") + tr("당기순손실", "", "150=====", "") ) +
  tbl("현 금 흐 름 표", "천원", H, tr("Ⅰ. 영업활동으로 인한 현금흐름", "", "(50)", "") + tr("감가상각비", "", "40", "35") + tr("무형자산상각비", "", "5", "") + tr("Ⅱ. 투자활동으로 인한 현금흐름", "", "", "") + tr("기계장치의 취득", "", "(70)", "") + tr("비품의 취득", "", "(10)", ""));
const a = financialsFromAuditXml(xml1);
const y = a.years[0];
assert.equal(y.revenue, 2_000_000); assert.equal(y.operatingIncome, -120_000); assert.equal(y.netIncome, -150_000);
assert.equal(a.years[1].operatingIncome, -30_000);
assert.equal(y.depreciationAmortization, 45_000); assert.equal(y.ebitda, -75_000);
assert.equal(y.capexTangible, 80_000); assert.equal(y.operatingCashFlow, -50_000);
assert.equal(y.cash, 100_000); assert.equal(y.shortTermDeposits, 50_000); assert.equal(y.equityParent, 600_000);
ok("일반기업회계기준 손실 표기·상각비·종류별 취득·밑줄");

// 2. 연결: '당기순이익의 귀속' 머리가 총포괄손익 합계 뒤에 있음(에코프로비엠 모양)
const xml2 =
  tbl("연결재무상태표", "백만원", H, tr("현금및현금성자산", "", "10", "") + tr("자산총계", "", "100", "") + tr("부채총계", "", "40", "") + tr("지배기업의 소유주에게 귀속되는 지분", "", "50", "") + tr("비지배지분", "", "10", "") + tr("자본총계", "", "60", "")) +
  tbl("연결포괄손익계산서", "백만원", H, tr("매출액", "", "500", "") + tr("영업이익(손실)", "", "50", "") + tr("법인세비용차감전순이익(손실)", "", "40", "") + tr("당기순이익(손실)", "", "30", "") + tr("당기총포괄손익", "", "28", "") + tr("당기순이익(손실)의 귀속", "", "", "") + tr("지배기업소유주지분", "", "20", "") + tr("비지배지분", "", "10", "") + tr("당기총포괄손익의 귀속", "", "", "") + tr("지배기업소유주지분", "", "19", "")) +
  tbl("연결현금흐름표", "백만원", H, tr("영업활동현금흐름", "", "", "") + tr("영업활동으로부터의 순현금유입", "", "70", "") + tr("투자활동현금흐름", "", "", "") + tr("유형자산의 취득", "", "(25)", ""));
const b = financialsFromAuditXml(xml2).years[0];
assert.equal(b.netIncomeParent, 20e6); assert.equal(b.equityParent, 50e6); assert.equal(b.nci, 10e6);
assert.equal(b.operatingCashFlow, 70e6); assert.equal(b.capexTangible, 25e6);
assert.equal(b.depreciationAmortization, null); // 상각비를 못 찾으면 EBITDA 를 만들지 않음
ok("지배주주순이익 귀속 머리·지배기업 지분 이름 변형·값 없는 제목 행 건너뜀");

// 3. 설립 첫 해: 기간 표기가 하나뿐인 2칸(내역·합계) 표는 모두 당기
const xml3 = tbl("재무상태표", "원", tr("과 목", "주석", "제 1 기", ""), tr("자산총계", "", "", "1,000") + tr("부채총계", "", "", "400") + tr("자본총계", "", "", "600")) +
  tbl("손익계산서", "원", tr("과 목", "주석", "제 1 기", ""), tr("Ⅰ. 매출액", "", "", "300") + tr("판매비와관리비", "", "100", "") + tr("Ⅳ.영업이익", "", "", "200") + tr("법인세비용차감전순이익", "", "", "200") + tr("당기순이익", "", "", "150"));
const c = financialsFromAuditXml(xml3);
assert.equal(c.years[0].revenue, 300); assert.equal(c.years[0].totalAssets, 1000); assert.equal(c.years[1].revenue, null);
ok("설립 첫 해 단일 기간 표");

// 4. 검산(2026-11-06): 구역 세부 합계·자산=부채+자본·세전−법인세=순이익이 맞으면 원문 확인 필요 없음, 행 하나를 틀리게 적으면 잡힘
const bsOk = (cash: string) => tbl("재무상태표", "백만원", H,
  tr("유동자산", "", "300", "") + tr("현금및현금성자산", "", cash, "") + tr("매출채권", "", "200", "") + tr("비유동자산", "", "700", "") + tr("유형자산", "", "700", "") + tr("자산총계", "", "1,000", "") +
  tr("유동부채", "", "400", "") + tr("매입채무", "", "400", "") + tr("부채총계", "", "400", "") + tr("자본총계", "", "600", "")) +
  tbl("손익계산서", "백만원", H, tr("매출액", "", "900", "") + tr("매출원가", "", "600", "") + tr("매출총이익", "", "300", "") + tr("영업이익", "", "100", "") + tr("법인세비용차감전순이익", "", "90", "") + tr("법인세비용", "", "20", "") + tr("당기순이익", "", "70", ""));
const good = financialsFromAuditXml(bsOk("100")).checks.filter(x => x.level === "verify" && x.item !== "현금흐름표");
assert.equal(good.length, 0, JSON.stringify(good));
const bad = financialsFromAuditXml(bsOk("110")).checks.filter(x => x.level === "verify");
assert.ok(bad.some(x => /유동자산 아래 행들의 합/.test(x.message)));
ok("검산: 맞는 표는 통과, 현금 한 행 오독은 원문 확인 필요");

console.log(`audit-fin: ${n}건 통과`);
