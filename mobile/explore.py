#!/usr/bin/env python3
"""
adb-explorer : Flutter 앱 탐색적 테스트용 관찰/조작 엔진

Claude Code가 이 스크립트를 도구로 호출해서 앱을 자율 탐색한다.
접근성 트리(uiautomator dump)가 잘 잡히는 앱을 전제로,
content-desc + bounds 기반으로 clickable 요소를 뽑아 탭한다.

사용법:
  python explore.py observe          # 현재 화면 관찰 (요소 목록 + 스크린샷 + 이상 징후)
  python explore.py tap <x> <y>      # 좌표 탭
  python explore.py tap-desc "출근하기"   # content-desc로 요소 찾아 탭
  python explore.py back             # 뒤로가기
  python explore.py swipe up|down    # 스크롤
  python explore.py focus            # 현재 포그라운드 앱 패키지 확인
  python explore.py relaunch         # 앱 재실행 (탐색 이탈 시 복귀)
  python explore.py logcat-check     # 마지막 관찰 이후 크래시/예외 로그 확인
  python explore.py reset            # 방문 기록/로그 초기화
"""

import subprocess
import sys
import os
import re
import json
import time
import xml.etree.ElementTree as ET

# ── 설정 ──────────────────────────────────────────────
ADB = os.environ.get("ADB", "adb")          # 윈도우면 adb.exe 로 환경변수 지정 가능
PACKAGE = "com.attendance.attendance_mobile"  # 대상 앱 패키지
WORK = os.path.dirname(os.path.abspath(__file__))
ART = os.path.join(WORK, "artifacts")         # 스크린샷/덤프 저장
os.makedirs(ART, exist_ok=True)

VISITED_FILE = os.path.join(WORK, "visited.json")     # 눌러본 요소 기록
LOGMARK_FILE = os.path.join(WORK, "logmark.txt")      # logcat 읽은 위치 마커
STEP_FILE = os.path.join(WORK, "step.txt")            # 현재 스텝 번호

# 탐색 중 "누르기 전에 반드시 확인"이 필요한 위험 요소 (되돌리기 어려움)
RISKY_DESCS = {"로그아웃", "출근하기", "퇴근하기"}

# 크래시/이상으로 간주할 logcat 키워드
CRASH_PATTERNS = [
    "FATAL EXCEPTION", "ANR in", "E/AndroidRuntime",
    "Unhandled Exception", "TimeoutException",
    "StateError", "RangeError", "NoSuchMethodError",
    "Null check operator used on a null value",
]


def adb(*args, capture=True, timeout=30):
    cmd = [ADB] + list(args)
    try:
        r = subprocess.run(cmd, capture_output=capture, text=True,
                           timeout=timeout, encoding="utf-8", errors="replace")
        return r.stdout or ""
    except subprocess.TimeoutExpired:
        return "__TIMEOUT__"


def step_no():
    if not os.path.exists(STEP_FILE):
        return 0
    return int(open(STEP_FILE).read().strip() or "0")


def bump_step():
    n = step_no() + 1
    open(STEP_FILE, "w").write(str(n))
    return n


# ── 관찰: UI 덤프 → 요소 파싱 ─────────────────────────
def dump_ui():
    """uiautomator dump를 받아 XML 문자열 반환"""
    for attempt in range(3):
        out = adb("shell", "uiautomator", "dump", "/sdcard/ui.xml")
        if "dumped to" in out or "UI hierchary" in out or "UI hierarchy" in out:
            break
        time.sleep(1)
    xml = adb("shell", "cat", "/sdcard/ui.xml")
    adb("shell", "rm", "/sdcard/ui.xml", capture=True)
    return xml


def parse_bounds(b):
    m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", b or "")
    if not m:
        return None
    x1, y1, x2, y2 = map(int, m.groups())
    return (x1, y1, x2, y2, (x1 + x2) // 2, (y1 + y2) // 2)


def extract_elements(xml):
    """clickable 요소 + 텍스트/에러성 요소를 뽑는다"""
    elements = []
    errors = []
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return elements, ["__UI_DUMP_PARSE_FAILED__"]

    for node in root.iter("node"):
        desc = node.get("content-desc", "") or ""
        text = node.get("text", "") or ""
        label = desc or text
        clickable = node.get("clickable") == "true"
        bounds = parse_bounds(node.get("bounds"))

        # 이상 징후로 보이는 텍스트(예외 메시지 등)를 화면에서도 포착
        combined = f"{desc} {text}"
        for pat in CRASH_PATTERNS:
            if pat.lower() in combined.lower():
                errors.append(f"[화면표시] {combined.strip()}")

        if clickable and bounds and label:
            x1, y1, x2, y2, cx, cy = bounds
            elements.append({
                "label": label,
                "cx": cx, "cy": cy,
                "bounds": [x1, y1, x2, y2],
                "risky": label in RISKY_DESCS,
            })
    return elements, errors


def load_visited():
    if os.path.exists(VISITED_FILE):
        return set(json.load(open(VISITED_FILE)))
    return set()


def save_visited(s):
    json.dump(sorted(s), open(VISITED_FILE, "w"), ensure_ascii=False, indent=2)


def observe():
    n = step_no()
    xml = dump_ui()
    elements, screen_errors = extract_elements(xml)

    # 스크린샷도 함께 저장 (비전 보조 / 증적)
    shot = os.path.join(ART, f"step_{n:03d}.png")
    adb("shell", "screencap", "-p", "/sdcard/s.png")
    adb("pull", "/sdcard/s.png", shot, capture=True)
    adb("shell", "rm", "/sdcard/s.png")

    visited = load_visited()
    focus = current_focus()
    log_errors = logcat_check(silent=True)

    print(f"=== STEP {n} 관찰 ===")
    print(f"현재 포그라운드: {focus}")
    print(f"우리 앱 안: {'예' if PACKAGE in focus else '아니오 (이탈!)'}")
    print(f"스크린샷: {shot}")
    print()

    print("클릭 가능 요소:")
    for i, e in enumerate(elements):
        mark = "★위험" if e["risky"] else ""
        seen = "✓방문" if e["label"] in visited else "  신규"
        print(f"  [{i}] {seen} {mark} '{e['label']}' → tap {e['cx']} {e['cy']}")
    print()

    all_errors = screen_errors + log_errors
    if all_errors:
        print("⚠️ 이상 징후 감지:")
        for er in all_errors:
            print(f"  - {er}")
    else:
        print("이상 징후 없음")

    # 기계가 읽기 쉬운 JSON도 함께 출력
    print("\n---JSON---")
    print(json.dumps({
        "step": n, "focus": focus, "in_app": PACKAGE in focus,
        "screenshot": shot, "elements": elements,
        "errors": all_errors,
    }, ensure_ascii=False))


def current_focus():
    out = adb("shell", "dumpsys", "window")
    m = re.search(r"mCurrentFocus=Window\{[^}]*\s+([\w.]+/[\w.]+)", out)
    if m:
        return m.group(1)
    m = re.search(r"mCurrentFocus=.*?([\w.]+\.[\w.]+)/", out)
    return m.group(1) if m else "unknown"


# ── 조작 ─────────────────────────────────────────────
def tap(x, y):
    bump_step()
    adb("shell", "input", "tap", str(x), str(y))
    time.sleep(1.5)  # 화면 전환 대기
    print(f"tapped ({x},{y})")


def tap_desc(desc):
    xml = dump_ui()
    elements, _ = extract_elements(xml)
    for e in elements:
        if e["label"] == desc:
            visited = load_visited()
            visited.add(desc)
            save_visited(visited)
            tap(e["cx"], e["cy"])
            return
    print(f"요소를 찾지 못함: '{desc}'")


def back():
    bump_step()
    adb("shell", "input", "keyevent", "KEYCODE_BACK")
    time.sleep(1.2)
    print("back")


def swipe(direction):
    bump_step()
    if direction == "up":
        adb("shell", "input", "swipe", "540", "1300", "540", "500", "300")
    else:
        adb("shell", "input", "swipe", "540", "500", "540", "1300", "300")
    time.sleep(1)
    print(f"swipe {direction}")


def relaunch():
    adb("shell", "monkey", "-p", PACKAGE,
        "-c", "android.intent.category.LAUNCHER", "1")
    time.sleep(2)
    print(f"relaunched {PACKAGE}")


# ── 이상 감지: logcat ────────────────────────────────
def logcat_check(silent=False):
    """마지막 마커 이후의 크래시성 로그만 확인"""
    out = adb("shell", "logcat", "-d", "-v", "time")
    lines = out.splitlines()

    last_mark = ""
    if os.path.exists(LOGMARK_FILE):
        last_mark = open(LOGMARK_FILE).read().strip()

    # 마커 이후 라인만
    new_lines = lines
    if last_mark and last_mark in out:
        idx = out.rfind(last_mark)
        new_lines = out[idx + len(last_mark):].splitlines()

    if lines:
        open(LOGMARK_FILE, "w").write(lines[-1])

    hits = []
    for ln in new_lines:
        for pat in CRASH_PATTERNS:
            if pat in ln:
                hits.append(f"[logcat] {ln.strip()[:200]}")
                break

    if not silent:
        if hits:
            print("⚠️ logcat 이상:")
            for h in hits:
                print(f"  {h}")
        else:
            print("logcat 이상 없음")
    return hits


def reset():
    for f in (VISITED_FILE, LOGMARK_FILE, STEP_FILE):
        if os.path.exists(f):
            os.remove(f)
    adb("logcat", "-c")  # 로그 버퍼 비우기
    print("reset 완료 (방문기록/로그마커/스텝/logcat 초기화)")


# ── 엔트리포인트 ─────────────────────────────────────
def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    cmd = sys.argv[1]
    if cmd == "observe":
        observe()
    elif cmd == "tap":
        tap(int(sys.argv[2]), int(sys.argv[3]))
    elif cmd == "tap-desc":
        tap_desc(sys.argv[2])
    elif cmd == "back":
        back()
    elif cmd == "swipe":
        swipe(sys.argv[2] if len(sys.argv) > 2 else "up")
    elif cmd == "focus":
        print(current_focus())
    elif cmd == "relaunch":
        relaunch()
    elif cmd == "logcat-check":
        logcat_check()
    elif cmd == "reset":
        reset()
    else:
        print(f"알 수 없는 명령: {cmd}")
        print(__doc__)


if __name__ == "__main__":
    main()
