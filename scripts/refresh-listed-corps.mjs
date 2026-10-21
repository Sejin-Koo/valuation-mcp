// valuation-mcp / scripts/refresh-listed-corps.mjs
// OpenDART corpCode.xml(전체 등록법인)에서 상장사(stock_code 가 있는 법인)만 추려 data/listed-corps.json 으로 저장한다.
// 요청 처리 중에 3.5MB zip 을 받으면 Vercel↔DART 구간 스로틀링으로 60초를 넘기는 사례가 있어(dart-mcp 실측),
// GitHub Actions 가 주기적으로 갱신해 저장소에 커밋하고 런타임은 이 파일만 읽는다.
// 상장폐지 법인도 stock_code 가 남아 있으면 포함된다(과거 기준일 조회용) — 현재 상장 여부는 이 파일로 판정하지 말 것.
// 실행: DART_API_KEY=xxx node scripts/refresh-listed-corps.mjs
import AdmZip from "adm-zip";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const key = process.env.DART_API_KEY;
if (!key) { console.error("DART_API_KEY 환경변수가 필요합니다."); process.exit(1); }
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "listed-corps.json");

const res = await fetch(`https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${key}`, { headers: { "User-Agent": "Mozilla/5.0" } });
if (!res.ok) { console.error(`HTTP ${res.status}`); process.exit(1); }
const buf = Buffer.from(await res.arrayBuffer());
if (buf[0] !== 0x50 || buf[1] !== 0x4b) { console.error("zip 이 아닙니다: " + buf.toString("utf8", 0, 200)); process.exit(1); }
const xml = new AdmZip(buf).getEntries()[0].getData().toString("utf8");
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const dec = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ENT[e]);
const tag = (b, t) => { const m = b.match(new RegExp(`<${t}>([^<]*)</${t}>`)); return m ? dec(m[1].trim()) : ""; };
const list = [];
for (const m of xml.matchAll(/<list>([\s\S]*?)<\/list>/g)) {
  const stock = tag(m[1], "stock_code");
  if (!stock) continue;
  list.push({ stock_code: stock, corp_code: tag(m[1], "corp_code"), corp_name: tag(m[1], "corp_name"), modify_date: tag(m[1], "modify_date") });
}
list.sort((a, b) => a.stock_code.localeCompare(b.stock_code));
if (list.length < 1000) { console.error(`상장사가 ${list.length}개뿐입니다 — 응답 이상으로 보고 저장하지 않습니다.`); process.exit(1); }
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ source: "OpenDART corpCode.xml", count: list.length, list }) + "\n");
console.log(`listed-corps.json: ${list.length}개`);
