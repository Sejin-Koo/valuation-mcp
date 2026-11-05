// 감사보고서 원문 표 읽기 단위 시험(외부 호출 없음). 사례는 2026-11-05 비상장 외감법인 감사보고서 표본에서 찾은 표 모양.
import assert from "node:assert/strict";
import { extractBalanceSheet, cleanName, parseAmount } from "../lib/audit-bs.js";
import { debtFromAuditXml, auditOpinion } from "../lib/debt-audit.js";

let n = 0; const ok = (m: string) => { n++; console.log("  OK", m); };
const tr = (...cells: string[]) => `<TR>${cells.map(c => `<TD>${c}</TD>`).join("")}</TR>`;
const doc = (title: string, unit: string, head: string, body: string, extra = "") =>
  `<P>감사의견 우리의 의견으로는 ... 공정하게 표시하고 있습니다.</P><TABLE><TBODY><TR><TD>${title}</TD></TR><TR><TD>(단위 : ${unit})</TD></TR></TBODY></TABLE>` +
  `<TABLE><THEAD>${head}</THEAD><TBODY>${body}</TBODY></TABLE>${extra}`;

// 1. 이름·금액
assert.equal(cleanName("Ⅰ. 유 동 부 채"), "유동부채");
assert.equal(cleanName("   1. 단 기 차 입 금(주석6)"), "단기차입금(주석6)");
assert.equal(cleanName("ll. 비유동부채"), "비유동부채");
assert.equal(cleanName("주.임.종 단기채무"), "주.임.종 단기채무"); // '주.' '임.' 은 번호가 아님
assert.equal(parseAmount("(1,234)"), -1234);
assert.equal(parseAmount("△500"), -500);
assert.equal(parseAmount("-"), 0);
assert.equal(parseAmount("4,6,31"), null); // 주석 번호
ok("이름 정리·금액 읽기");

// 2. 일반기업회계기준 2칸(내역·합계) + 주석 칸 + 구역 이름에 주석 번호 + 차감계정(현재가치할인차금)
const kgaap = doc("재 무 상 태 표", "원",
  tr("과 목", "주석", "제 10(당) 기", "", "제 9(전) 기", ""),
  tr("자 산", "", "", "", "", "") + tr("자 산 총 계", "", "", "9,000", "", "8,000") +
  tr("부 채", "", "", "", "", "") +
  tr("Ⅰ. 유동부채(주석8)", "", "", "3,000", "", "2,000") +
  tr("1. 매입채무", "", "500", "", "400", "") +
  tr("2. 단기차입금", "6,7", "2,000", "", "1,000", "") +
  tr("3. 유동성장기부채", "6", "500", "", "600", "") +
  tr("Ⅱ. 비유동부채", "", "", "1,900", "", "900") +
  tr("1. 장기차입금", "6", "2,000", "", "1,000", "") +
  tr("2. 현재가치할인차금", "", "(100)", "1,900", "(100)", "900") +
  tr("부 채 총 계", "", "", "4,900", "", "2,900") +
  tr("자 본 총 계", "", "", "4,100", "", "5,100"));
const a = debtFromAuditXml(kgaap);
assert.equal(a.total, 4400);
assert.deepEqual(a.lines.map(l => [l.section, l.name, l.amount]), [["current", "단기차입금", 2000], ["current", "유동성장기부채", 500], ["nonCurrent", "장기차입금", 2000], ["nonCurrent", "현재가치할인차금", -100]]);
ok("일반기업회계기준 2칸 표·구역 주석 번호·현재가치할인차금");

// 3. 단위 백만원, 리스부채 이름 변형, 장기차입금 = 바로 다음 한 줄과 금액이 같아도 부모로 보지 않음(실측: 메디픽셀)
const ifrs = doc("연 결 재 무 상 태 표", "백만원",
  tr("과목", "주석", "제 5 기말", "제 4 기말"),
  tr("자산총계", "", "100", "90") + tr("유동부채", "", "", "") + tr("리스유동부채", "", "10", "9") +
  tr("비유동부채", "", "", "") + tr("장기차입금", "", "500", "") + tr("신주인수권부사채", "11", "500", "") + tr("신주인수권조정", "", "(80)", "") + tr("리스비유동부채", "", "20", "") +
  tr("부채총계", "", "950", "") + tr("자본총계", "", "50", ""));
const b = debtFromAuditXml(ifrs);
assert.equal(b.total, (10 + 500 + 500 - 80 + 20) * 1e6);
assert.equal(b.lines.filter(l => l.category === "lease").length, 2);
ok("백만원 단위·리스 이름 변형·한 줄 같은 금액");

// 4. 리스부채가 기타금융부채에 묶인 회사: 주석 표의 유동·비유동 리스부채
const withNote = doc("재무상태표", "천원",
  tr("과목", "주석", "당기말", "전기말"),
  tr("자산총계", "", "100", "") + tr("유동부채", "", "", "") + tr("단기차입금", "", "40", "") + tr("기타금융부채", "", "15", "") +
  tr("비유동부채", "", "", "") + tr("기타비유동금융부채", "", "8", "") + tr("부채총계", "", "63", "") + tr("자본총계", "", "37", ""),
  `<P>(2) 리스부채 내역</P><TABLE><TBODY><TR><TD>(단위: 천원)</TD></TR></TBODY></TABLE><TABLE><THEAD><TR><TD>구분</TD><TD>당기말</TD><TD>전기말</TD></TR></THEAD><TBODY>${tr("유동리스부채", "5", "4")}${tr("비유동리스부채", "7", "6")}</TBODY></TABLE>`);
const c = debtFromAuditXml(withNote);
assert.equal(c.total, (40 + 5 + 7) * 1e3);
assert.ok(c.lines.some(l => l.source === "주석" && l.section === "nonCurrent" && l.amount === 7000));
ok("주석 리스부채 보충");

// 5. 포괄 '단기금융부채'가 차입금 주석 표 합계와 같으면 전액 차입금(실측: 사조씨푸드 2025)
const sajo = doc("재무상태표", "원",
  tr("과목", "주석", "당기말", "전기말"),
  tr("자산총계", "", "100", "") + tr("유동부채", "", "", "") + tr("단기금융부채", "", "9,000", "") + tr("비유동부채", "", "", "") + tr("부채총계", "", "9,000", "") + tr("자본총계", "", "1", ""),
  `<TITLE>주 석</TITLE><P>20. 차입금 (1) 단기차입금의 내용은 다음과 같습니다.</P><TABLE><TBODY><TR><TD>(단위: 천원)</TD></TR></TBODY></TABLE><TABLE><THEAD><TR><TD>차입금 종류</TD><TD>차입처</TD><TD>당기말</TD><TD>전기말</TD></TR></THEAD><TBODY>${tr("일반대출", "A은행", "5", "")}${tr("시설대출", "B은행", "4", "")}${tr("합 계", "", "9", "7")}</TBODY></TABLE>`);
const d = debtFromAuditXml(sajo);
assert.equal(d.total, 9000);
assert.equal(d.lines[0].name, "단기금융부채");
ok("포괄 금융부채 = 차입금 주석 합계");

// 6. 본문 '차입금' 행에 리스가 포함(주석 차입금 구성 표에 리스부채 행) — 리스를 따로 더하지 않음(실측: LG화학 2025)
const lgc = doc("연결재무상태표", "백만원",
  tr("과목", "주석", "당기말", "전기말"),
  tr("자산총계", "", "100", "") + tr("유동부채", "", "", "") + tr("차입금", "14", "1,100", "") + tr("비유동부채", "", "", "") + tr("차입금", "14", "2,050", "") + tr("부채총계", "", "3,150", "") + tr("자본총계", "", "1", ""),
  `<TITLE>주 석</TITLE><P>14. 차입금 (1) 차입금 구성은 다음과 같습니다. (단위: 백만원)</P><TABLE><THEAD><TR><TD>구분</TD><TD>당기말</TD><TD>전기말</TD></TR></THEAD><TBODY>${tr("단기차입금", "1,000", "")}${tr("유동리스부채", "100", "")}${tr("사채", "2,000", "")}${tr("리스부채", "50", "")}</TBODY></TABLE>` +
  `<P>리스부채의 내역 (단위: 백만원)</P><TABLE><THEAD><TR><TD>구분</TD><TD>당기말</TD></TR></THEAD><TBODY>${tr("유동리스부채", "100")}${tr("비유동리스부채", "50")}</TBODY></TABLE>`);
const e = debtFromAuditXml(lgc);
assert.equal(e.total, 3150e6);
assert.ok(!e.lines.some(l => l.category === "lease"));
ok("본문 차입금에 리스 포함");

// 7. '당기말 및 전기말 현재 …' 설명 뒤 표는 당기 표, '(2) 전기말' 표는 건너뜀 / '비유동성리스부채'
const twoYears = doc("재무상태표", "천원",
  tr("과목", "주석", "당기말", "전기말"),
  tr("자산총계", "", "100", "") + tr("유동부채", "", "", "") + tr("기타채무", "", "30", "") + tr("부채총계", "", "30", "") + tr("자본총계", "", "70", ""),
  `<TITLE>주 석</TITLE><P>(2) 전기말 (단위: 천원)</P><TABLE><THEAD><TR><TD>구분</TD><TD>장부금액</TD></TR></THEAD><TBODY>${tr("유동성리스부채", "99")}</TBODY></TABLE>` +
  `<P>당기말 및 전기말 현재 기타채무의 내역은 다음과 같습니다. (단위: 천원)</P><TABLE><THEAD><TR><TD>구분</TD><TD>당기말</TD><TD>전기말</TD></TR></THEAD><TBODY>${tr("유동성리스부채(*1)", "6", "5")}${tr("비유동성리스부채(*1)", "2", "1")}</TBODY></TABLE>`);
const f = debtFromAuditXml(twoYears);
assert.equal(f.total, 8000);
ok("전기 표 건너뜀·비유동성리스부채");

// 8. 감사의견
assert.equal(auditOpinion("<P>의견거절근거 우리는 ...</P>"), "의견거절");
assert.equal(auditOpinion("<P>한정의견근거 ...</P>"), "한정");
assert.equal(auditOpinion(kgaap), "적정");
assert.equal(extractBalanceSheet("<P>재무제표 없음</P>"), null);
ok("감사의견·표 없음");

console.log(`debt-audit: ${n}건 통과`);
