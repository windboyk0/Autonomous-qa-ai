# adb-explorer 사용법

Flutter 출퇴근 앱(`com.attendance.attendance_mobile`)을 Claude Code로 자율 탐색 테스트한다.

## 사전 조건
- PC에 adb 연결 완료 (`adb devices` → `device` 상태)
- 앱이 폰에 설치되어 실행 가능한 상태
- Python 3 설치

## 파일 구성
- `explore.py` — 관찰/조작/이상감지 엔진 (Claude Code가 호출하는 도구)
- `CLAUDE.md` — Claude Code에게 주는 탐색 규칙/목표
- `artifacts/` — 스텝별 스크린샷·덤프 저장 (자동 생성)
- `findings.md` — 탐색 중 발견한 이상 (Claude Code가 작성)
- `report.md` — 최종 개선점 리포트 (Claude Code가 작성)

## 실행 순서

### 1) 윈도우면 adb 경로 지정
```cmd
set ADB=adb.exe
```
(adb.exe가 PATH에 없으면 전체 경로: `set ADB=C:\platform-tools-latest-windows\platform-tools\adb.exe`)

### 2) 도구가 잘 도는지 수동 확인
앱을 폰 화면에 띄운 상태에서:
```cmd
python explore.py reset
python explore.py observe
```
요소 목록과 스크린샷 경로, 이상 징후가 출력되면 정상.

### 3) Claude Code로 탐색 시작
이 디렉터리에서 Claude Code를 실행하고 이렇게 지시:
```
CLAUDE.md를 읽고, 그 규칙대로 앱 탐색적 테스트를 수행해줘.
발견한 이상은 findings.md에 기록하고, 끝나면 report.md로 정리해줘.
```
Claude Code가 observe → 판단 → tap → 이상확인 루프를 자동으로 돈다.

## 커스터마이즈
- `explore.py` 상단 `RISKY_DESCS` — 누르기 전 주의할 버튼 라벨 추가/수정
- `CRASH_PATTERNS` — 이상으로 잡을 로그/화면 키워드 추가
- `CLAUDE.md`의 스텝 상한(기본 40) 조정

## 주의
- "출근하기/퇴근하기"는 실제 근태 기록을 남길 수 있음 → CLAUDE.md 규칙상 맨 마지막에 최소 시도.
- 탐색 중 임시 파일(`/sdcard/ui.xml`, `/sdcard/s.png`)은 pull 후 자동 삭제되어 폰에 남지 않음.
