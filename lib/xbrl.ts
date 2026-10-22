/**
 * DART 정기보고서 XBRL 원본(fnlttXbrl.xml)에서 감가상각비·영업이익·매출·순이익을 뽑는다.
 *
 * 왜 XBRL 원본인가 (2026-10-21 실측, 2025 사업보고서 상장사 무작위 표본 46곳)
 * - 정형 재무제표 API(fnlttSinglAcntAll)는 재무제표 본문만 준다. 감가상각비를 현금흐름표 본문에 적은
 *   회사는 8곳뿐이었고, 나머지는 주석에만 적는다.
 * - XBRL 원본에는 주석 태그까지 들어 있어 23곳에서 잡혔다(본문 8곳 포함).
 * - 나머지는 주석 XBRL 의무화 대상이 아직 아닌 소형사가 대부분이다. 이때는 원문 주석 표 발췌로 넘긴다.
 *
 * 감가상각비 구성 규칙
 * - 현금흐름표 조정 항목(AdjustmentsForDepreciationExpense 등)을 1순위로 쓴다 — 손익에 반영된 금액이다.
 * - 사용권자산·투자부동산 상각은 회사마다 감가상각비 줄에 포함하기도, 따로 적기도 한다.
 *   유형자산 변동표의 감가상각(DepreciationPropertyPlantAndEquipment)에 어느 항목을 더해야
 *   현금흐름표 감가상각비와 맞는지 대조해 포함 여부를 정한다. 맞는 조합이 없으면 판정 불가로 표시한다.
 */
import AdmZip from "adm-zip";
import { DartError } from "./dart.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const OK_DIMS = new Set(["ConsolidatedMember", "SeparateMember", "ReportedAmountMember"]);

function key(): string {
  const k = process.env.DART_API_KEY;
  if (!k) throw new DartError("서버 환경변수 DART_API_KEY 가 설정되어 있지 않습니다.", "NO_KEY");
  return k;
}

// ─── 보고서 목록 ──────────────────────────────────────────

export type ReportKind = "annual" | "half" | "quarter";
export interface PeriodicReport {
  rcept_no: string; report_nm: string; rcept_dt: string; corp_name: string;
  kind: ReportKind; periodEnd: string /* YYYYMM */;
}

const KIND: Record<string, ReportKind> = { 사업: "annual", 반기: "half", 분기: "quarter" };

/** 기준일(포함) 이전에 접수된 정기보고서. 같은 기간은 기준일까지 접수된 마지막 판(정정 반영)만 남긴다. */
export async function periodicReportsUntil(corp_code: string, until: string): Promise<PeriodicReport[]> {
  const y = Number(until.slice(0, 4));
  const out: PeriodicReport[] = [];
  for (let page = 1; page <= 3; page++) {
    const url = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${key()}&corp_code=${corp_code}&bgn_de=${y - 3}0101&end_de=${until}&pblntf_ty=A&last_reprt_at=N&page_no=${page}&page_count=100`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new DartError(`DART 공시목록 HTTP ${res.status}`);
    const d: any = await res.json();
    if (d.status === "013") break;
    if (d.status !== "000") throw new DartError(`DART 공시목록 오류 ${d.status}: ${String(d.message ?? "").slice(0, 100)}`, d.status);
    for (const r of d.list as any[]) {
      const m = String(r.report_nm).match(/(사업|반기|분기)보고서\s*\((\d{4})\.(\d{2})\)/);
      if (!m) continue;
      out.push({ rcept_no: r.rcept_no, report_nm: String(r.report_nm).trim(), rcept_dt: r.rcept_dt, corp_name: r.corp_name, kind: KIND[m[1]], periodEnd: m[2] + m[3] });
    }
    if (Number(d.total_page ?? 1) <= page) break;
  }
  const latest = new Map<string, PeriodicReport>();
  for (const r of out) {
    const k = `${r.kind}:${r.periodEnd}`;
    const prev = latest.get(k);
    if (!prev || r.rcept_dt > prev.rcept_dt || (r.rcept_dt === prev.rcept_dt && r.rcept_no > prev.rcept_no)) latest.set(k, r);
  }
  return Array.from(latest.values()).sort((a, b) => (a.periodEnd === b.periodEnd ? (a.rcept_dt < b.rcept_dt ? 1 : -1) : a.periodEnd < b.periodEnd ? 1 : -1));
}

/** fnlttXbrl 의 reprt_code. 분기보고서는 결산월로부터 몇 달째인지로 1분기·3분기를 가른다. */
export function reprtCode(r: PeriodicReport, fyEndMonth: number): string {
  if (r.kind === "annual") return "11011";
  if (r.kind === "half") return "11012";
  const off = (Number(r.periodEnd.slice(4)) - fyEndMonth + 12) % 12;
  return off === 3 ? "11013" : "11014";
}

// ─── XBRL 내려받기·해석 ───────────────────────────────────

export interface Fact { ns: string; tag: string; scope: "C" | "S" | "N"; start: string; end: string; value: number; unit: string; label?: string }
export interface XbrlDoc { instance: string; labelsKo: string | null }

/** 실측(2026-10-22): 한 건 25~41초. 연결이 끊기는 일이 있어(ConnectionReset) 남은 시간 안에서 한 번 더 시도한다. */
export async function downloadXbrl(rcept_no: string, reprt_code: string, deadline = Date.now() + 150_000): Promise<XbrlDoc> {
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const budget = Math.min(150_000, deadline - Date.now());
    if (budget < 5_000) break;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), budget);
    try {
      const res = await fetch(`https://opendart.fss.or.kr/api/fnlttXbrl.xml?crtfc_key=${key()}&rcept_no=${rcept_no}&reprt_code=${reprt_code}`, { headers: { "User-Agent": UA }, signal: ac.signal });
      if (!res.ok) throw new DartError(`DART XBRL HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
        const msg = buf.toString("utf8", 0, Math.min(buf.length, 300));
        throw new DartError(`XBRL 원본이 없습니다(${(msg.match(/<message>([^<]*)/) ?? [])[1] ?? msg.slice(0, 120)})`, "NO_XBRL");
      }
      const entries = new AdmZip(buf).getEntries();
      const entry = entries.find(e => /\.xbrl$/i.test(e.entryName));
      if (!entry) throw new DartError("XBRL 압축파일에 인스턴스(.xbrl)가 없습니다.", "NO_XBRL");
      const lab = entries.find(e => /lab-ko\.xml$/i.test(e.entryName));
      return { instance: entry.getData().toString("utf8"), labelsKo: lab ? lab.getData().toString("utf8") : null };
    } catch (e) {
      if (e instanceof DartError && e.code === "NO_XBRL") throw e;
      lastErr = (e as Error).name === "AbortError" ? `${Math.round(budget / 1000)}초 초과` : (e as Error).message;
    } finally { clearTimeout(timer); }
  }
  throw new DartError(`DART XBRL 내려받기 실패(${lastErr})`, "DOWNLOAD");
}

/** 회사 고유 계정(entity 네임스페이스)의 한글 표준 라벨. 키 = "네임스페이스_태그" */
function customLabels(labXml: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!labXml) return out;
  for (const m of labXml.matchAll(/<link:label\b([^>]*)>([^<]*)<\/link:label>/g)) {
    const a = m[1];
    if (!/xlink:role="http:\/\/www\.xbrl\.org\/2003\/role\/label"/.test(a)) continue;
    const id = (a.match(/xlink:label="Label_label_(.+?)_ko"/) ?? [])[1];
    if (id && !out.has(id)) out.set(id, m[2].trim());
  }
  return out;
}

/** 연결/별도 축과 "보고금액" 외 다른 축이 없는 기간형 사실만 남긴다(부문·자산종류별 값 제외). */
export function parseFacts(doc: XbrlDoc | string): Fact[] {
  const xml = typeof doc === "string" ? doc : doc.instance;
  const labels = customLabels(typeof doc === "string" ? null : doc.labelsKo);
  // rouClass: 유형자산 종류 축에서 사용권자산 하나만 고른 문맥(사용권자산을 유형자산의 한 종류로 공시하는 회사 — 실측 케이씨 2025)
  const ctx = new Map<string, { start: string; end: string; scope: Fact["scope"]; rouClass?: boolean } | null>();
  for (const m of xml.matchAll(/<xbrli:context\s+id="([^"]+)"\s*>([\s\S]*?)<\/xbrli:context>/g)) {
    const b = m[2];
    const s = (b.match(/<xbrli:startDate>([^<]+)</) ?? [])[1];
    const e = (b.match(/<xbrli:endDate>([^<]+)</) ?? [])[1];
    const dims = Array.from(b.matchAll(/dimension="[^"]+"\s*>([^<]+)</g), x => x[1].split(":").pop()!.trim());
    const other = dims.filter(d => !OK_DIMS.has(d));
    const rouClass = other.length === 1 && /Rightofuse|RightOfUse/i.test(other[0]);
    if (!s || !e || (other.length && !rouClass)) { ctx.set(m[1], null); continue; }
    ctx.set(m[1], { start: s, end: e, scope: dims.includes("ConsolidatedMember") ? "C" : dims.includes("SeparateMember") ? "S" : "N", ...(rouClass ? { rouClass } : {}) });
  }
  const units = new Map<string, string>();
  for (const m of xml.matchAll(/<xbrli:unit\s+id="([^"]+)"\s*>([\s\S]*?)<\/xbrli:unit>/g)) {
    units.set(m[1], ((m[2].match(/<xbrli:measure>([^<]+)</) ?? [])[1] ?? m[1]).split(":").pop()!);
  }
  const facts: Fact[] = [];
  for (const m of xml.matchAll(/<([A-Za-z][\w-]*):([A-Za-z]\w*)\b([^>]*?)>([^<]*)<\/\1:\2>/g)) {
    const attrs = m[3];
    const c = (attrs.match(/contextRef="([^"]+)"/) ?? [])[1];
    if (!c) continue;
    const cx = ctx.get(c);
    if (!cx) continue;
    const v = Number(m[4].trim());
    if (!m[4].trim() || !Number.isFinite(v)) continue;
    const u = (attrs.match(/unitRef="([^"]+)"/) ?? [])[1] ?? "";
    if (cx.rouClass && m[2] !== "DepreciationPropertyPlantAndEquipment") continue;
    const label = m[1] !== "ifrs-full" && m[1] !== "dart" ? labels.get(`${m[1]}_${m[2]}`) : undefined;
    facts.push({ ns: m[1], tag: cx.rouClass ? `${m[2]}#ROU` : m[2], scope: cx.scope, start: cx.start, end: cx.end, value: v, unit: units.get(u) ?? u, ...(label ? { label } : {}) });
  }
  return facts;
}

// ─── 기간 고르기 ──────────────────────────────────────────

const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;
/** YYYYMM → 그 달 말일(YYYY-MM-DD) */
const isoEnd = (yyyymm: string) => new Date(Date.UTC(Number(yyyymm.slice(0, 4)), Number(yyyymm.slice(4)), 0)).toISOString().slice(0, 10);

export interface Period { start: string; end: string; months: number }

/** 주어진 종료일로 끝나는 기간 중 가장 긴 것(누적 기간). 영업이익 태그가 있는 기간을 우선한다. */
export function cumulativePeriod(facts: Fact[], end: string): Period | null {
  const cands = new Map<string, number>();
  for (const f of facts) if (f.end === end) {
    const w = f.tag === "OperatingIncomeLoss" ? 2 : 1;
    cands.set(f.start, Math.max(cands.get(f.start) ?? 0, w));
  }
  if (!cands.size) return null;
  const starts = Array.from(cands.keys()).filter(s => days(s, end) <= 372);
  if (!starts.length) return null;
  starts.sort((a, b) => (cands.get(b)! - cands.get(a)!) || (a < b ? -1 : 1));
  const s = starts[0];
  return { start: s, end, months: Math.round(days(s, end) / 30.44) };
}

// ─── 항목 계산 ────────────────────────────────────────────

export interface DaComponent { item: string; value: number; tag: string; treatment: "포함" | "별도 가산" | "기준" | "판정 불가(가산 안 함)" }
export interface DaResult {
  total: number | null;
  totalExclRightOfUse: number | null;
  components: DaComponent[];
  reportedCombined: { value: number; tag: string } | null;
  rightOfUseIncluded: boolean | null;
  /** 사용권자산(rou)·투자부동산(ip)을 감가상각비 줄에 포함(true)/따로 가산(false)으로 판정한 결과 — 같은 회사 다른 기간의 판정 근거로 넘긴다 */
  decisions: Record<string, boolean | null>;
  notes: string[];
}

type Getter = (tags: string[]) => { value: number; tag: string } | null;

function getter(facts: Fact[], scope: Fact["scope"], p: Period, abs: boolean): Getter {
  const idx = new Map<string, Fact[]>();
  for (const f of facts) if (f.scope === scope && f.start === p.start && f.end === p.end) {
    const a = idx.get(f.tag) ?? []; a.push(f); idx.set(f.tag, a);
  }
  return (tags) => {
    for (const t of tags) {
      const fs = idx.get(t);
      if (!fs?.length) continue;
      // 같은 태그가 여러 번 나오면(본문·주석) 가장 많이 나온 값
      const cnt = new Map<number, number>();
      for (const f of fs) cnt.set(f.value, (cnt.get(f.value) ?? 0) + 1);
      const v = Array.from(cnt.entries()).sort((a, b) => b[1] - a[1])[0][0];
      return { value: abs ? Math.abs(v) : v, tag: `${fs[0].ns}:${t}` };
    }
    return null;
  };
}

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1000, 0.003 * Math.max(Math.abs(a), Math.abs(b)));

/** hint: 같은 회사 다른 기간(보통 사업보고서)에서 판정한 결과. 이 기간만으로 판정할 수 없을 때 쓴다. */
export function computeDa(facts: Fact[], scope: Fact["scope"], p: Period, hint?: Record<string, boolean | null>): DaResult | null {
  const g = getter(facts, scope, p, true);
  const depCf = g(["AdjustmentsForDepreciationExpense"]);
  const amoCf = g(["AdjustmentsForAmortisationExpense"]);
  const daCf = g(["AdjustmentsForDepreciationAndAmortisationExpense"]);
  const rouCf = g(["AdjustmentsForDepreciationRightofuseAssets", "AdjustmentsForDepreciationOfRightofuseAssets"]);
  const ppe = g(["DepreciationPropertyPlantAndEquipment"]);
  const ppeRouClass = g(["DepreciationPropertyPlantAndEquipment#ROU"]); // 유형자산 변동표 안의 사용권자산 종류
  const rouRf = g(["DepreciationRightofuseAssets"]);
  const ipRf = g(["DepreciationInvestmentProperty"]);
  const intg = g(["AmortisationIntangibleAssetsOtherThanGoodwill"]);
  const daNat = g(["DepreciationAndAmortisationExpense"]);
  const depNat = g(["DepreciationExpense"]);
  const amoNat = g(["AmortisationExpense"]);
  const notes: string[] = [];

  const dep = depCf ?? ppe ?? depNat;
  const amo = amoCf ?? intg ?? amoNat;
  const combined = daCf ?? daNat;
  if (!dep && !amo) {
    if (!combined) return null;
    notes.push("감가상각비·상각비가 합계 한 줄로만 공시돼 구성(사용권자산 포함 여부)을 알 수 없습니다.");
    return { total: combined.value, totalExclRightOfUse: null, components: [{ item: "감가상각비와 상각비(합계)", value: combined.value, tag: combined.tag, treatment: "기준" }], reportedCombined: combined, rightOfUseIncluded: null, notes, decisions: {} };
  }

  const comps: DaComponent[] = [];
  if (dep) comps.push({ item: dep === depCf ? "감가상각비(현금흐름표 조정)" : dep === ppe ? "유형자산 감가상각비(변동표)" : "감가상각비(비용의 성격별)", value: dep.value, tag: dep.tag, treatment: "기준" });
  if (amo) comps.push({ item: amo === amoCf ? "무형자산상각비(현금흐름표 조정)" : amo === intg ? "무형자산상각비(변동표)" : "상각비(비용의 성격별)", value: amo.value, tag: amo.tag, treatment: "기준" });

  // 회사 고유 계정으로 공시한 현금흐름표 조정 행(예: "투자부동산감가상각비" — 실측 미래산업 2025)
  const DA_LABEL = /(감가상각|상각비)/, BAD_LABEL = /(대손|상각후원가|환입|손상|처분|누계)/;
  const seen = new Set<string>();
  const custom = facts.filter(f => f.scope === scope && f.start === p.start && f.end === p.end && f.label && /Adjustments|udf_CF/i.test(f.tag)
    && DA_LABEL.test(f.label) && !BAD_LABEL.test(f.label) && !seen.has(f.tag) && (seen.add(f.tag), true))
    .map(f => ({ value: Math.abs(f.value), tag: `${f.ns}:${f.tag}`, label: f.label! }));
  let rouCfX: { value: number; tag: string } | null = rouCf;
  let ipCf: { value: number; tag: string } | null = null;
  const otherCustom: { value: number; tag: string; label: string }[] = [];
  for (const c of custom) {
    if (/사용권/.test(c.label) && !rouCfX) rouCfX = c;
    else if (/투자부동산/.test(c.label) && !ipCf) ipCf = c;
    else otherCustom.push(c);
  }

  // 사용권자산·투자부동산이 감가상각비 줄에 들어 있는지 — 현금흐름표에 별도 행이 있으면 따로 더하고,
  // 없으면 유형자산 변동표 감가상각에 무엇을 더해야 현금흐름표 감가상각비와 맞는지로 판정
  const extras: { key: "rou" | "ip"; item: string; f: { value: number; tag: string }; ownCfLine: boolean }[] = [];
  const rou = rouCfX ?? rouRf;
  const ip = ipCf ?? ipRf;
  if (rou) extras.push({ key: "rou", item: "사용권자산 상각", f: rou, ownCfLine: !!rouCfX });
  if (ip) extras.push({ key: "ip", item: "투자부동산 감가상각", f: ip, ownCfLine: !!ipCf });
  // decision: true = 감가상각비 줄에 이미 포함, false = 따로 더함, null = 판정 불가
  const decision = new Map<string, boolean | null>();
  for (const e of extras) if (e.ownCfLine) decision.set(e.key, false);
  const open = extras.filter(e => !e.ownCfLine);
  // ppeRou: 유형자산 변동표 감가상각에 사용권자산이 들어 있는지(true/false/모름) — 반기·분기 판정에 넘긴다
  let ppeRou: boolean | null = null;
  if (open.length && dep) {
    // 유형자산 변동표가 사용권자산을 한 종류로 포함하면, 그 몫을 빼 순수 유형자산 감가상각을 기준으로 비교
    const ppeBase = ppe ? ppe.value - (ppeRouClass && rou && close(ppeRouClass.value, rou.value) ? ppeRouClass.value : 0) : 0;
    if (ppe && ppeBase !== ppe.value) { ppeRou = true; notes.push("유형자산 변동표에 사용권자산이 한 종류로 들어 있어 그 몫을 빼고 대조했습니다."); }
    if (dep === depCf && ppe) {
      const subsets: typeof open[] = [[], ...open.map(e => [e])];
      if (open.length === 2) subsets.push(open);
      const hit = subsets.find(sub => close(dep.value, ppeBase + sub.reduce((a, e) => a + e.f.value, 0)));
      if (hit) { for (const e of open) decision.set(e.key, hit.includes(e)); if (ppeRou === null && rou) ppeRou = false; }
      else {
        notes.push(`현금흐름표 감가상각비(${dep.value.toLocaleString("ko-KR")})가 유형자산 변동표 감가상각(${ppe.value.toLocaleString("ko-KR")})에 사용권자산·투자부동산을 어떻게 더해도 맞지 않습니다 — 원문 확인 필요.`);
        for (const e of open) decision.set(e.key, null);
      }
    } else if (dep === ppe) {
      // 유형자산 변동표 값에는 투자부동산이 없다. 사용권자산은 한 종류로 들어 있으면 포함 —
      // 이 기간에 종류별 태그가 없으면 사업보고서에서 변동표에 사용권자산이 들어 있었는지를 따른다
      for (const e of open) {
        if (e.key !== "rou") { decision.set(e.key, false); continue; }
        if (ppeRou) decision.set("rou", true);
        else if (hint && typeof hint.ppeRou === "boolean") {
          decision.set("rou", hint.ppeRou);
          notes.push(`사용권자산 상각: 이 기간 유형자산 변동표에 종류별 금액이 없어, 사업보고서에서 변동표에 사용권자산이 ${hint.ppeRou ? "들어 있던" : "없던"} 구성을 따랐습니다.`);
        } else decision.set("rou", false);
      }
    } else {
      for (const e of open) decision.set(e.key, null);
    }
  }
  // 이 기간만으로 판정 못 한 항목은 같은 회사 사업보고서의 판정을 따른다(반기·분기 XBRL 에는 유형자산 변동표 합계가 없는 일이 많다)
  for (const e of open) if ((decision.get(e.key) ?? null) === null && hint && typeof hint[e.key] === "boolean") {
    decision.set(e.key, hint[e.key] as boolean);
    notes.push(`${e.item}: 이 기간 자료만으로는 포함 여부를 판정할 수 없어 사업보고서의 판정(${hint[e.key] ? "감가상각비에 포함" : "따로 가산"})을 따랐습니다.`);
  }
  for (const e of extras) {
    const d = decision.get(e.key) ?? null;
    if (d === null) comps.push({ item: e.item, value: e.f.value, tag: e.f.tag, treatment: "판정 불가(가산 안 함)" });
    else if (d) comps.push({ item: e.item, value: e.f.value, tag: e.f.tag, treatment: "포함" });
    else comps.push({ item: e.item + (e.ownCfLine ? "(현금흐름표 별도 행)" : ""), value: e.f.value, tag: e.f.tag, treatment: "별도 가산" });
  }
  for (const c of otherCustom) {
    if (dep === depCf) comps.push({ item: `${c.label}(현금흐름표 회사 고유 행)`, value: c.value, tag: c.tag, treatment: "별도 가산" });
    else notes.push(`현금흐름표에 회사 고유 행 "${c.label}"(${c.value.toLocaleString("ko-KR")})이 있으나 감가상각비 기준이 현금흐름표가 아니어서 더하지 않았습니다.`);
  }
  if (dep === depCf && extras.some(e => e.key === "rou" && !e.ownCfLine && decision.get("rou") === false)) notes.push("현금흐름표에서 사용권자산 상각 행을 찾지 못해 사용권자산 변동표 금액을 따로 더했습니다 — 현금흐름표 주석에서 다른 행에 들어 있는지 확인을 권합니다.");
  if (comps.some(c => c.treatment === "판정 불가(가산 안 함)")) notes.push("사용권자산·투자부동산 상각이 감가상각비에 포함됐는지 판정하지 못한 항목은 더하지 않았습니다. 구성항목 금액을 보고 판단하십시오.");

  const added = comps.filter(c => c.treatment === "기준" || c.treatment === "별도 가산").reduce((a, c) => a + c.value, 0);
  const rouComp = comps.find(c => c.item.startsWith("사용권자산"));
  const rouIn = rouComp ? (rouComp.treatment === "판정 불가(가산 안 함)" ? null : true) : false;
  const exclRou = rouComp && rouComp.treatment !== "판정 불가(가산 안 함)" ? added - rouComp.value : rouComp ? null : added;
  if (combined && !close(combined.value, added)) {
    const diff = added - combined.value;
    const why = rouComp && close(diff, rouComp.value) ? " — 차이는 사용권자산 상각과 같습니다(회사가 공시한 합계는 사용권자산 상각을 뺀 금액)." : "";
    notes.push(`회사가 공시한 감가상각비·상각비 합계(${combined.value.toLocaleString("ko-KR")}, ${combined.tag})와 구성 합계가 ${diff.toLocaleString("ko-KR")} 다릅니다${why}`);
  }
  return { total: added, totalExclRightOfUse: exclRou, components: comps, reportedCombined: combined, rightOfUseIncluded: rouIn, notes, decisions: { ...Object.fromEntries(extras.map(e => [e.key, decision.get(e.key) ?? null])), ppeRou } };
}

export interface Flows { revenue: { value: number; tag: string } | null; operatingIncome: { value: number; tag: string } | null; netIncomeParent: { value: number; tag: string } | null }

export function computeFlows(facts: Fact[], scope: Fact["scope"], p: Period): Flows {
  const g = getter(facts, scope, p, false);
  return {
    revenue: g(["Revenue", "RevenueFromContractsWithCustomers", "Revenues", "RevenueFromSaleOfGoodsProduct"]),
    operatingIncome: g(["OperatingIncomeLoss"]),
    // 비지배지분이 없는 회사는 지배주주 귀속 순이익을 따로 태그하지 않는다(실측 S-Oil 2026 반기) — 그때는 당기순이익
    netIncomeParent: g(["ProfitLossAttributableToOwnersOfParent"])
      ?? (scope === "S" || !g(["ProfitLossAttributableToNoncontrollingInterests"]) ? g(["ProfitLoss"]) : null),
  };
}

export function currencyOf(facts: Fact[], scope: Fact["scope"], p: Period): string | null {
  const f = facts.find(x => x.scope === scope && x.start === p.start && x.end === p.end && x.tag === "OperatingIncomeLoss");
  return f?.unit ?? facts.find(x => x.scope === scope && x.end === p.end && /^[A-Z]{3}$/.test(x.unit))?.unit ?? null;
}

export { isoEnd, days };
