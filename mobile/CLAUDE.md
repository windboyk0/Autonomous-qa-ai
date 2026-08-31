# 출퇴근 앱 탐색적 테스트 하네스

## 목표
`com.attendance.attendance_mobile` (Flutter 출퇴근 관리 앱)을 자율 탐색하여
**크래시, 예외, 멈춤, UX 이상, 개선점**을 찾아내고, 마지막에 리포트로 정리한다.

정해진 시나리오는 없다. 앱의 모든 화면·기능을 최대한 넓게 훑는 것이 목적이다.

## 도구 (반드시 이 스크립트로만 조작)
작업 디렉터리에서 아래 명령을 bash로 실행한다. (윈도우면 `set ADB=adb.exe` 후 실행)

- `python explore.py observe` — 현재 화면 관찰. 클릭 가능 요소 목록(방문 여부·위험 표시), 스크린샷 경로, 이상 징후(화면+logcat)를 출력. **매 조작 전후로 반드시 호출.**
- `python explore.py tap <x> <y>` — 좌표 탭. observe가 알려준 `tap x y` 좌표를 그대로 사용.
- `python explore.py tap-desc "라벨"` — 라벨(content-desc)로 찾아 탭. 방문 기록에 자동 추가됨.
- `python explore.py back` — 뒤로가기.
- `python explore.py swipe up|down` — 스크롤(숨은 요소 확인용).
- `python explore.py relaunch` — 앱 재실행(앱 밖으로 이탈 시 복귀).
- `python explore.py logcat-check` — 마지막 관찰 이후 크래시/예외 로그 확인.
- `python explore.py reset` — 시작 시 1회 호출(방문기록/로그/스텝 초기화).

## 탐색 루프 (매 스텝 이 순서를 지킬 것)
1. `observe` 실행.
2. 출력의 `우리 앱 안` 확인. **"아니오(이탈)"이면 즉시 `relaunch`** 후 다시 observe.
3. 이상 징후가 있으면 → **직전에 한 조작과 함께 `findings.md`에 기록**(아래 형식).
4. 요소 목록에서 **`신규`(미방문) 요소를 우선** 하나 골라 탭. 모두 방문했으면 `swipe up`으로 숨은 요소를 찾거나 `back`으로 상위로 이동.
5. `★위험` 표시 요소(로그아웃/출근하기/퇴근하기)는 **일반 요소를 모두 탐색한 뒤 맨 마지막에** 한 번씩만 시도. 누르기 전에 findings.md에 "위험 동작 시도" 메모를 남길 것.
6. 스텝 수가 **40회**에 도달하거나 더 탐색할 신규 요소가 없으면 종료하고 리포트 작성.

## 이상 징후 판단 기준
다음은 모두 기록 대상이다.
- logcat의 FATAL EXCEPTION / AndroidRuntime / Flutter Unhandled Exception
- 화면에 노출된 예외 문자열(TimeoutException, StateError, Null check 등) — **사용자에게 raw 예외가 그대로 보이는 것 자체가 UX 결함**
- 탭했는데 화면이 3초 이상 반응 없음(멈춤 의심)
- 앱이 갑자기 종료되어 포그라운드가 바뀜
- 버튼인데 눌러도 아무 일도 안 일어남(데드 버튼)
- 로딩이 끝나지 않고 계속 도는 화면

## findings.md 기록 형식
발견 즉시 아래 형식으로 append:
```
## [발견 N] 한 줄 요약
- 스텝: (observe가 출력한 STEP 번호)
- 재현 경로: (어떤 요소들을 순서대로 눌렀는지)
- 증상: (관찰된 이상)
- 로그: (logcat/화면의 예외 메시지 원문)
- 스크린샷: artifacts/step_XXX.png
- 심각도: 높음/중간/낮음
- 개선 제안: (원인 추정 + 어떻게 고치면 좋을지)
```

## 이미 알려진 것 (참고)
첫 화면에 `TimeoutException after 0:00:15.000000: Future not completed` 가
"위치 새로고침" 영역에 노출되어 있었다. 위치 조회 비동기 로직의 타임아웃으로 추정.
이것부터 재현·확인하고 findings에 넣을 것.

## 안전 규칙
- 개발자 본인의 앱/계정이다. 다만 "출근하기/퇴근하기"는 실제 근태 기록을 남길 수 있으니
  위 5번 규칙대로 맨 마지막에 최소 횟수만 시도하고, 시도 사실을 명확히 기록한다.
- 앱 삭제, 계정 삭제, 결제류 버튼이 새로 발견되면 누르지 말고 findings에 "미시도(위험)"로만 남긴다.

## 최종 리포트 (탐색 종료 후 report.md 생성)
findings.md를 종합하여 다음을 담은 report.md를 작성:
1. 탐색 요약(방문 화면 수, 총 스텝, 발견 건수)
2. 심각도별 이슈 목록(높음→낮음)
3. 화면별 개선점 정리
4. 우선순위 top 3 (개발자가 먼저 고쳐야 할 것)
