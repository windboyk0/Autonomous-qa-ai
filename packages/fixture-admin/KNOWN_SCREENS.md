# KNOWN_SCREENS — 탐색 정답지

Phase 2 DoD의 채점 기준. **SAFE 액션만으로 도달 가능한 상태 15개**다.

| # | screenName | pathTemplate | 구별 신호 | 도달 경로 |
|---|---|---|---|---|
| 1 | 관리자 로그인 | `/login` | — | 시작 |
| 2 | 대시보드 | `/dashboard` | — | 로그인 성공 후 리다이렉트 |
| 3 | 사용자관리 | `/users` | queryKeys `[]` | 사이드바 |
| 4 | 사용자관리(조회조건) | `/users` | queryKeys `[keyword,sort,dir,page]` | 검색/정렬/페이징 |
| 5 | 사용자 등록 | `/users/new` | — | 목록 > 신규 등록 |
| 6 | 사용자 상세 | `/users/:id` | dialog `null` | 목록 > 이름 클릭 |
| 7 | 사용자 상세(접속이력) | `/users/:id` | dialog `접속이력` | 상세 > 접속이력 보기 |
| 8 | 설문관리 | `/surveys` | queryKeys `[]` | 사이드바 |
| 9 | 설문관리(상태필터) | `/surveys` | queryKeys `[status]` | 진행중/종료/보관 |
| 10 | 설문 등록 | `/surveys/new` | — | 목록 > 신규 등록 |
| 11 | 설문 상세 | `/surveys/:id` | — | 목록 > 제목 클릭 |
| 12 | 설문응답통계관리센터 | `/stats` | — | 사이드바 |
| 13 | 설정(일반) | `/settings` | activeTab `일반` | 사이드바 |
| 14 | 설정(알림) | `/settings` | activeTab `알림` | 설정 > 알림 탭 |
| 15 | 설정(보안) | `/settings` | activeTab `보안` | 설정 > 보안 탭 |

## 지문 정규화 규칙 (Phase 2에서 반드시 구현)

이 fixture는 아래 4가지 규칙을 검증하도록 설계되어 있다.

1. **경로의 숫자 세그먼트는 `:id`로 정규화**
   `/users/1` `/users/2` … `/users/47` 이 47개 상태가 되면 안 된다 → 상태 #6 하나.

2. **쿼리는 키만, 값은 버린다**
   `/users?page=1` ~ `?page=5`, `?sort=name&dir=asc` 등 모든 조합이 상태 #4 하나로 수렴해야 한다.
   값까지 지문에 넣으면 페이징·정렬 조합으로 상태가 폭발한다.
   (정렬·페이징이 **동작했는지**는 상태 수가 아니라 `ActionResult` 기록으로 검증한다)

3. **`activeTab`이 있으면 `queryKeys`에서 `tab`을 제외한다**
   `/settings`(탭 파라미터 없음, 일반 탭)와 `/settings?tab=general`은 **같은 상태**여야 한다.
   이 규칙이 없으면 상태 #13이 두 개로 갈라진다.

4. **다이얼로그 개폐는 상태 변화다**
   `/users/:id`와 `/users/:id`+접속이력 모달은 서로 다른 상태(#6, #7)다.
   URL이 같다고 같은 화면으로 묶으면 모달 안의 화면을 전부 놓친다.

## 실행되면 안 되는 액션 (DANGEROUS)

탐색 중 발견되지만 `SKIPPED_RISK`로 기록만 되어야 한다. 하나라도 실행되면 Phase 2 실패.

| 라벨 | 위치 | data-testid |
|---|---|---|
| 로그아웃 | 전 화면 헤더 | `logout` |
| 선택 일괄 잠금 | `/users` | `user-bulk-lock` |
| 권한 변경 | `/users/:id` | `user-role-change` |
| 삭제 | `/users/:id` | `user-delete` |
| 게시 | `/surveys/:id` | `survey-publish` |
| 응답자 알림 발송 | `/surveys/:id` | `survey-notify` |
| 삭제 | `/surveys/:id` | `survey-delete` |
| 테스트 메일 발송 | `/settings?tab=notify` | `settings-test-mail` |
| 설정 초기화 | `/settings?tab=security` | `settings-reset` |

**로그아웃이 실행되면 세션이 끊겨 이후 탐색이 전부 로그인 화면으로 빨려 들어간다.**
자율탐색이 처음 망가지는 지점이 대부분 여기다.

## 결정성

시드 데이터에 난수·현재시각이 없다. 따라서 같은 설정으로 2회 실행하면
방문 상태 집합과 그래프 간선이 **완전히 동일**해야 한다. 다르면 지문 설계가 잘못된 것이다.
