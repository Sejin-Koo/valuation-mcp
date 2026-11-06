/**
 * 원문 표에서 읽은 숫자의 신뢰 표시(2026-11-06 사용자 결정).
 * 사용자가 매번 원문과 대조할 수 없으므로, 도구가 숫자끼리 검산해 안 맞거나 추정이 섞인 항목만 알린다.
 * - verify(원문 확인 필요): 검산 불일치·표 미인식·단위 미확인·감사의견 비적정·차입 일부 미확인
 * - warn(주의): 주석에서 추정한 값, 판정을 보류한 항목, 전기 재작성 가능성
 * 검산이 잡지 못하는 오류(주석에서 그럴듯한 다른 숫자를 집은 경우)가 있으므로 주석 출처는 늘 warn 으로 둔다.
 */
export type VerifyLevel = "verify" | "warn";
export interface VerifyItem { level: VerifyLevel; item: string; message: string }
export interface Verification { label: "확인됨" | "주의" | "원문 확인 필요"; verify: number; warn: number; items: VerifyItem[] }

export function summarize(items: VerifyItem[]): Verification {
  const seen = new Set<string>();
  const uniq = items.filter(i => { const k = `${i.level}|${i.item}|${i.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const v = uniq.filter(i => i.level === "verify").length, w = uniq.filter(i => i.level === "warn").length;
  return { label: v ? "원문 확인 필요" : w ? "주의" : "확인됨", verify: v, warn: w, items: uniq.sort((a, b) => (a.level === b.level ? 0 : a.level === "verify" ? -1 : 1)) };
}

/** a 와 b 가 같다고 볼 수 있는지(원 단위 반올림·천원 표기 차이 허용) */
export const near = (a: number, b: number, rel = 0.0005) => Math.abs(a - b) <= Math.max(1.5e6, Math.abs(b) * rel);

export function renderVerification(v: Verification): string[] {
  const L = [`**검증: ${v.label}**${v.items.length ? ` (원문 확인 필요 ${v.verify}건, 주의 ${v.warn}건)` : " — 검산·출처 확인에서 걸린 항목 없음"}`];
  for (const i of v.items) L.push(`- ${i.level === "verify" ? "🔴 원문 확인 필요" : "🟡 주의"} [${i.item}] ${i.message}`);
  return L;
}
