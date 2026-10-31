# valuation-mcp

한국 상장사 밸류에이션용 계산·조회 MCP 서버입니다. Vercel 서버리스 함수(`api/mcp.ts`)로 동작하고, 접근은 게이트키(`?k=`)로 제한합니다.

## 도구

| 도구 | 하는 일 | 데이터 출처 |
|---|---|---|
| `ecos_get_market_rates` | 평가기준일의 국고채(1~50년)·회사채(3년 AA-, BBB-)·CD·KORIBOR 등. 휴일이면 직전 영업일 | 한국은행 ECOS 817Y002 |
| `wacc_calculate` | CAPM + 세후 타인자본비용. Rf·Kd 는 비워 두면 ECOS 에서 채움. 입력별 출처 반환 | ECOS / 계산 |
| `peer_statistics` | 피어 EV/매출·EV/영업이익·EV/EBITDA·PER·PBR·언레버드 베타의 중앙값·사분위·중앙값 부트스트랩 95% 구간·제외 사유 | 계산(입력은 외부) |
| `dcf_calculate` | DCF 기업가치·주주가치·주당가치·민감도. dart-mcp 의 같은 이름 도구와 출력이 같고, 금리 자동조회가 추가됨 | 계산 / ECOS |
| `beta_regression` | 주간(1·2·3년)·월간(3·5년) 베타, 결정계수·표준오차, KOSPI/KOSDAQ 선택 | 네이버 금융 수정주가 |
| `naver_market_snapshot` | 당일 시세·PER·PBR·컨센서스·네이버 동종업종 | 네이버 금융 |
| `dart_business_section` | 사업보고서 "II. 사업의 내용" 장 전체를 마크다운으로(표 포함), 하위 항목 선택·쪽 나눠 받기. 원본은 Vercel Blob 비공개 저장소(`valuation-doc-cache`)에 접수번호 단위로 24시간 보관(`lib/doc-cache.ts`, 끄려면 `DOC_CACHE_DISABLED=1`). 만료분은 `api/doc-cache-cleanup.ts`가 매일 03:10 KST에 지운다(Vercel Cron, `CRON_SECRET` 인증) | OpenDART 원본 |
| `dart_ebitda_inputs` | 감가상각비(유형·사용권자산·무형·투자부동산)와 영업이익·매출·지배주주순이익을 연간 또는 최근 12개월(TTM)로. 결과의 `peerRow`를 `peer_statistics`에 넣으면 EV/EBITDA 계산. 감가상각 태그가 없는 소형사는 원문 주석 표 발췌 | OpenDART XBRL 원본·원문 |

피어 모집단(`peergroup_get_population`)과 이자부부채가 포함된 분기말 밸류에이션 데이터(`valuation_get_data`)는 이 서버에 없습니다. 외부 서버 [kr-valuation-data](https://github.com/procpalee/DCF-Peergroup-Search)를 그대로 쓰고, 그 결과를 `peer_statistics` 에 넘기는 구성입니다. 이 서버의 일부 도구는 그 서버와 결과를 대조하는 용도로도 씁니다(아래 검증).

## 산식·관례

- **베타**: 단순수익률 OLS, 조정베타 = 실질 × 2/3 + 1/3. 주간은 금요일 종가(휴장이면 목요일, 목·금 모두 휴장인 주는 제외)이고 기준일이 속한 진행 중인 주는 쓰지 않습니다. 월간은 월 마지막 거래일 종가이고 기준일이 속한 달은 기준일 종가를 씁니다.
- **피어 통계**: 대표값은 중앙값, 사분위는 선형보간(R type 7 = 엑셀 QUARTILE.INC), 중앙값 구간은 고정 시드 부트스트랩 10,000회. 분모 ≤ 0·EV ≤ 0·결측·12개월 미만 누적 손익은 정의상 제외하고 사유를 셉니다. 이상치는 기본적으로 제외하지 않고 Tukey 1.5·IQR 밖 값을 표시만 합니다.
- **WACC**: 시장위험프리미엄·법인세율·Rf 만기·자본구조는 평가자 판단이라 기본값이 없습니다.
- **감가상각비(EBITDA)**: 현금흐름표 조정 항목을 기준으로 하고, 사용권자산·투자부동산 상각은 현금흐름표 별도 행이 있으면 더하고, 없으면 유형자산 변동표 감가상각에 어느 항목을 더해야 현금흐름표 금액과 맞는지로 포함 여부를 판정합니다(맞는 조합이 없으면 더하지 않고 표시). 회사 고유 계정의 현금흐름표 행은 한글 라벨로 찾습니다. 사용권자산 상각 포함이 기본이고 제외 금액도 함께 줍니다. TTM = 직전 사업연도 + 당기 누적 − 전년 동기 누적.

## 검증 (2026-10-21, 감가상각비 2026-10-22)

| 대상 | 방법 | 결과 |
|---|---|---|
| `dcf_calculate` | dart-mcp 원본과 8개 입력(오류 3건 포함) 텍스트·구조 출력 대조 | 전부 일치 |
| `beta_regression` | kr-valuation-data `compute_beta` 와 5종목 × 기준일 3개 × 주간·월간 30건 | 실질·조정베타·R²·관측치 전부 소수점 6자리 일치 |
| `dart_business_section` | kr-valuation-data `get_business_content` 와 3개사 숫자 토큰 집합 비교 | 288·237·368개 전부 일치 |
| `dart_ebitda_inputs` | 현금흐름표 본문에 감가상각비가 있는 8개사(2025 사업보고서)의 본문 합계와 대조, 공시 형태 5가지 합성 시험 | 8곳 전부 일치, 5가지 전부 통과 |

`npm test` 로 다시 돌릴 수 있습니다(`ECOS_API_KEY`, `DART_API_KEY` 필요. 외부 호출 없이 계산만 보려면 `npm run test:offline`).

## 환경변수 (Vercel)

| 이름 | 용도 |
|---|---|
| `ECOS_API_KEY` | 한국은행 ECOS 인증키 |
| `DART_API_KEY` | OpenDART 인증키 |
| `MCP_GATE_KEYS` | 허용 게이트키(쉼표 구분) |
| `MCP_GATE_MODE` | `enforce` 면 키 없는 호출 401 |

`data/listed-corps.json`(상장사 종목코드 ↔ DART 고유번호)은 GitHub Actions 가 매주 갱신합니다(저장소 Secret `DART_API_KEY` 필요).

## 출처 표기

- `lib/dcf.ts` 와 `lib/dart.ts` 의 원본 내려받기·인코딩 판별은 같은 계정의 [dart-mcp](https://github.com/Sejin-Koo/dart-mcp) 코드를 옮긴 것입니다.
- 베타 표본 관례는 공개 문서가 아니라 kr-valuation-data 의 결과값과의 대조로 확정했습니다. 그 서버의 코드는 사용하지 않았습니다.
- 데이터: 한국은행 경제통계시스템(ECOS), 금융감독원 OpenDART, 네이버 금융.
