# KNOWN_BUGS — 정답지

fixture-admin에 **의도적으로** 심어둔 결함 10건. 이 표가 QA 엔진의 채점 기준이다.

- Phase 3 DoD: **10건 중 8건 이상 탐지, 오탐 3건 이하**
- Phase 6 DoD: BUG-06을 Create FAIL로 판정
- 여기 없는 것을 Issue로 올리면 **오탐(false positive)** 으로 센다.

| ID | 화면 | 결함 | 탐지 주체 | 기대 ruleId | 기대 Severity | 검출 단계 |
|---|---|---|---|---|---|---|
| BUG-01 | `/stats` | `GET /api/stats/export` 가 항상 **500**. 화면에는 아무 오류 안내도 없음 | Network | `NET-5XX` | HIGH | Phase 3 |
| BUG-02 | 전 화면 | `GET /api/notice/badge` 가 항상 **404**. 모든 페이지에서 반복 발생 | Network | `NET-4XX` | MEDIUM | Phase 3 |
| BUG-03 | `/users` | `permissionMatrix` 미정의 참조로 **TypeError** 발생, 그리드 초기화 로그 중단 | Console | `CON-UNCAUGHT` | HIGH | Phase 3 |
| BUG-04 | `/dashboard` | 처리되지 않은 **Promise rejection** (`metrics endpoint not configured`) | Console | `CON-REJECTION` | MEDIUM | Phase 3 |
| BUG-05 | `/surveys/new` | 필수(*) 표시된 **담당자 이메일 검증 누락**. 빈 값으로 저장되고 서버도 거르지 않음 | Functional | `FUNC-VALIDATION-MISSING` | MEDIUM | Phase 6 |
| BUG-06 | `/users/new` | **저장 버튼 무반응**. 핸들러 미연결 → 네트워크 요청·토스트·화면이동 전부 없음 | Functional | `FUNC-NO-RESPONSE` | HIGH | Phase 6 |
| BUG-07 | `/stats` | 통계 테이블(`min-width:2400px`)이 컨테이너를 넘쳐 **body 가로 스크롤** 발생 | Visual | `VIS-OVERFLOW` | MEDIUM | Phase 3 |
| BUG-08 | `/users/:id` | 상태 뱃지가 `position:absolute` 로 **제목과 겹침** | Visual | `VIS-OVERLAP` | LOW | Phase 3 |
| BUG-09 | 전 화면 사이드바 | 메뉴 `설문응답통계관리센터` 가 고정폭 160px에서 **텍스트 잘림** | Visual | `VIS-TRUNCATE` | LOW | Phase 3 |
| BUG-10 | `/surveys?status=ARCHIVED` | 필터 적용 시 스피너가 켜진 채 **무한 로딩**, 표가 영원히 안 보임 | Functional | `FUNC-INFINITE-LOADING` | HIGH | Phase 3 |

## 중복 제거 검증 포인트

**BUG-02는 방문하는 모든 화면에서 발생한다.** 15개 화면을 탐색하면 후보가 15건 생기지만,
최종 `issues.json`에는 **Issue 1건 + Evidence 15건**으로 나와야 한다.
`dedupKey = network + NET-4XX + /api/notice/badge + 404` 로 묶인다.

Issue Judge가 이걸 15건으로 뱉으면 Phase 3 DoD 실패로 본다.

## 오탐 유발 함정 (Issue로 올리면 안 되는 것들)

이 요소들은 **정상**이다. 검출기가 여기에 반응하면 오탐으로 센다.

| 항목 | 위치 | 설명 |
|---|---|---|
| `alert()` 를 띄우는 위험 버튼 | 여러 화면 | 삭제·권한변경·게시·발송·일괄잠금 버튼. **DANGEROUS로 분류되어 실행되지 않아야** 하며, 실행 안 된 것 자체는 Issue가 아니다 (미검증 영역으로만 기록) |
| 빈 결과 화면 | `/users?keyword=존재하지않는값` | "검색 결과가 없습니다" 는 정상적인 empty state |
| 401 응답 | `/api/*` (로그인 전) | 인증 전 접근 차단은 정상 동작 |
| 404 페이지 | `/없는경로` | 정상적인 404 화면 |
| `LOCKED` 상태 사용자 | `/users` 목록 | 데이터 값이지 결함이 아니다 |

## 리셋

런타임 생성 데이터(`AUTO-QA-*`)를 비우려면:

```
POST http://localhost:3100/__reset
```

시드 데이터는 난수를 쓰지 않으므로 서버 재시작 없이도 항상 같은 상태로 돌아간다.
