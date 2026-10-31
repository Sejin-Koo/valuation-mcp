// 원문 보관소 스모크테스트 — 가짜 Blob + 미리 받은 원문 zip(DOC_ZIP_FILE)을 opendart 응답 대신 사용.
// 실행: DOC_ZIP_FILE=<원문zip> DART_API_KEY=x npx tsx test/doc-cache.smoke.ts
import fs from "node:fs";
process.env.BLOB_READ_WRITE_TOKEN = "fake"; process.env.DART_API_KEY ||= "x";
const zip = fs.readFileSync(process.env.DOC_ZIP_FILE!); let downloads = 0; const real = globalThis.fetch;
globalThis.fetch = (async (u: any, o: any) => String(u).includes("opendart.fss.or.kr/api/document.xml") ? (downloads++, new Response(new Uint8Array(zip))) : real(u, o)) as typeof fetch;
const C = await import("../lib/doc-cache.js"); const D = await import("../lib/dart.js");
const store = new Map<string, { buf: Buffer; at: Date }>();
C.__setCacheBackend({
  get: (async (p: string) => { const v = store.get(p); return v ? { statusCode: 200, stream: new Blob([new Uint8Array(v.buf)]).stream(), blob: { uploadedAt: v.at } } : null; }) as any,
  put: (async (p: string, b: Buffer) => { store.set(p, { buf: b, at: new Date() }); }) as any,
  del: (async (u: any) => { for (const x of [].concat(u)) store.delete(String(x).replace("https://x/", "")); }) as any,
  list: (async () => ({ blobs: [...store].map(([p, v]) => ({ url: "https://x/" + p, uploadedAt: v.at })), hasMore: false })) as any,
});
let pass = 0, fail = 0; const ok = (c: boolean, m: string) => { c ? pass++ : fail++; console.log((c ? "  OK  " : "  NG  ") + m); };
const R = "20260814003964";
const a = await D.downloadDocumentWithInfo(R); ok(a.cache.status === "miss", "1차 miss");
const b = await D.downloadDocumentWithInfo(R); ok(b.cache.status === "hit", "2차 hit");
ok(a.files[0].xml === b.files[0].xml, "보관본과 원본 내용 동일");
const sec = D.extractBusinessSection(b.files); ok(sec.subsections.length > 0, `사업의 내용 하위 항목 ${sec.subsections.length}개 추출`);
console.log(C.cacheLine(b.cache, b.ms));
store.get(C.CACHE_PREFIX + R + ".zip")!.at = new Date(Date.now() - 25 * 3600e3);
const c = await D.downloadDocumentWithInfo(R); ok(c.cache.status === "miss" && /24시간/.test(c.cache.reason ?? ""), "만료분은 새로 받음");
ok(downloads === 2, `opendart 다운로드 ${downloads}회(조회 3회)`);
store.set(C.CACHE_PREFIX + "old.zip", { buf: Buffer.alloc(200), at: new Date(Date.now() - 30 * 3600e3) });
const g = await C.purgeExpired(); ok(g.deleted === 1 && store.size === 1, `정리: ${g.scanned}건 중 만료 ${g.deleted}건 삭제`);
console.log(`통과 ${pass} / 실패 ${fail}`); process.exit(fail ? 1 : 0);
