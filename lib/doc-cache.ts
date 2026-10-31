// valuation-mcp / lib/doc-cache.ts — DART 공시 원문(document.xml zip) 24시간 보관소 (2026-10-31)
//
// dart-mcp/lib/doc_cache.js 와 같은 규칙이다. 사업의 내용(dart_business_section)과 EBITDA 주석 발췌가
// 같은 보고서를 다시 부를 때 opendart 에서 새로 받지 않도록, 받은 zip 을 Vercel Blob 비공개 저장소에
// 접수번호 단위로 24시간 보관한다.
// - 같은 접수번호의 원문은 바뀌지 않는다(새 보고서·정정공시는 새 접수번호) → 보관본이 낡은 답을 내지 않는다.
// - 보관소는 보조 장치다. 토큰이 없거나 Blob 호출이 실패해도 종전처럼 직접 받는다.
// - 만료는 읽을 때 판정하고, api/doc-cache-cleanup.ts 가 매일 만료분을 지운다(dart-mcp 와 같은 방식,
//   Vercel Cron + CRON_SECRET).
import { get, put, del, list } from "@vercel/blob";

export const CACHE_PREFIX = "dart-doc-cache/";
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const IO_TIMEOUT_MS = 10_000;

export type CacheInfo = { status: "hit" | "miss" | "error" | "off"; uploadedAt?: string; reason?: string };

type Backend = { get: typeof get; put: typeof put; del: typeof del; list: typeof list };
let backend: Backend = { get, put, del, list };
/** 테스트에서 가짜 저장소를 끼우는 주입점 */
export function __setCacheBackend(b: Partial<Backend> | null) { backend = b ? (b as Backend) : { get, put, del, list }; }

export const cacheEnabled = () => !!process.env.BLOB_READ_WRITE_TOKEN && process.env.DOC_CACHE_DISABLED !== "1";
const pathOf = (rcept_no: string) => `${CACHE_PREFIX}${rcept_no}.zip`;
const isZip = (b: Buffer) => b.length >= 100 && b[0] === 0x50 && b[1] === 0x4b;

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), IO_TIMEOUT_MS);
  try { return await fn(ac.signal); } finally { clearTimeout(t); }
}

async function read(rcept_no: string, now = Date.now()): Promise<{ buf: Buffer; uploadedAt: Date } | { miss: string } | { error: string }> {
  try {
    const res = await withTimeout(signal => backend.get(pathOf(rcept_no), { access: "private", abortSignal: signal }));
    if (!res || res.statusCode !== 200 || !res.stream) return { miss: "보관본 없음" };
    const uploadedAt = new Date(res.blob.uploadedAt);
    if (now - uploadedAt.getTime() > CACHE_TTL_MS) {
      backend.del(pathOf(rcept_no)).catch(() => {});
      return { miss: "보관 기간(24시간) 경과" };
    }
    const buf = Buffer.from(await new Response(res.stream).arrayBuffer());
    if (!isZip(buf)) return { miss: "보관본 손상(zip 아님)" };
    return { buf, uploadedAt };
  } catch (e) {
    return { error: `보관소 읽기 실패: ${(e as Error).message}` };
  }
}

async function write(rcept_no: string, buf: Buffer): Promise<string | null> {
  try {
    await withTimeout(signal => backend.put(pathOf(rcept_no), buf, {
      access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/zip", abortSignal: signal,
    }));
    return null;
  } catch (e) {
    return `보관소 저장 실패: ${(e as Error).message}`;
  }
}

/** 보관본 우선 → 없으면 download() 로 받아 보관한다. */
export async function getZipWithCache(rcept_no: string, download: () => Promise<Buffer>): Promise<{ buf: Buffer; cache: CacheInfo }> {
  if (!/^\d{14}$/.test(rcept_no) || !cacheEnabled()) {
    return { buf: await download(), cache: { status: "off", reason: cacheEnabled() ? "접수번호 형식이 달라 보관하지 않음" : "보관소 미설정" } };
  }
  const hit = await read(rcept_no);
  if ("buf" in hit) return { buf: hit.buf, cache: { status: "hit", uploadedAt: hit.uploadedAt.toISOString() } };
  const buf = await download();
  const err = await write(rcept_no, buf);
  const reason = ["miss" in hit ? hit.miss : hit.error, err].filter(Boolean).join(" / ") || undefined;
  return { buf, cache: { status: err ? "error" : "miss", reason } };
}

/** 사람이 읽는 한 줄(시각은 KST) */
export function cacheLine(c: CacheInfo, ms?: number): string {
  const label = { hit: "서버 보관본 사용", miss: "새로 받아 24시간 보관", error: "새로 받음(보관 실패)", off: "새로 받음(보관 안 함)" }[c.status];
  const bits: string[] = [label];
  if (c.uploadedAt) bits.push(`보관 시각 ${new Date(new Date(c.uploadedAt).getTime() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ")} KST`);
  if (ms != null) bits.push(`${(ms / 1000).toFixed(1)}초`);
  if (c.reason) bits.push(c.reason);
  return `원문: ${bits.join(" · ")}`;
}

/** 24시간이 지난 보관본을 지운다(정리 작업용). */
export async function purgeExpired(now = Date.now()): Promise<{ scanned: number; deleted: number }> {
  let cursor: string | undefined; let scanned = 0; const expired: string[] = [];
  do {
    const page = await backend.list({ prefix: CACHE_PREFIX, cursor, limit: 1000 });
    for (const b of page.blobs) { scanned++; if (now - new Date(b.uploadedAt).getTime() > CACHE_TTL_MS) expired.push(b.url); }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  if (expired.length) await backend.del(expired);
  return { scanned, deleted: expired.length };
}
