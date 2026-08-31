import { Adb, listDevices, resolveAdb, searchedAdbLocations, type AdbDevice } from "./adb.js";

/**
 * 앱 QA 사전 점검.
 *
 * **시작하기 전에 막는다.** 웹에서 Claude 연결을 탐색이 끝난 뒤에야 확인해
 * 4분을 버린 적이 있다(1.0.1). 같은 실수를 반복하지 않는다.
 *
 * 막는 이유를 단계별로 나눠 돌려준다 — adb 가 없는 것, 기기가 없는 것,
 * USB 디버깅을 허용하지 않은 것, 앱이 안 깔린 것은 각각 조치가 다르다.
 */

export interface AppPreflight {
  ok: boolean;
  adbPath: string | null;
  devices: AdbDevice[];
  /** 실제로 쓸 기기. 정하지 못했으면 null */
  device: AdbDevice | null;
  packageInstalled: boolean | null;
  screen: { width: number; height: number } | null;
  detail: string;
  remediation: string | null;
}

export function preflightApp(input: {
  adbPath: string;
  deviceSerial: string;
  packageName: string;
}): AppPreflight {
  const base: AppPreflight = {
    ok: false,
    adbPath: null,
    devices: [],
    device: null,
    packageInstalled: null,
    screen: null,
    detail: "",
    remediation: null,
  };

  const adbPath = resolveAdb(input.adbPath);
  if (!adbPath) {
    return {
      ...base,
      detail: "adb 를 찾지 못했습니다.",
      remediation:
        "설치본에는 adb 가 동봉되어 있습니다. 그래도 못 찾으면 Android SDK platform-tools 의 " +
        `adb 경로를 설정에서 직접 지정하세요. 찾아본 곳: ${searchedAdbLocations().join(", ")}`,
    };
  }

  const devices = listDevices(adbPath);
  if (devices.length === 0) {
    return {
      ...base,
      adbPath,
      detail: "연결된 Android 기기가 없습니다.",
      remediation:
        "USB 로 기기를 연결하고 개발자 옵션에서 USB 디버깅을 켜세요. " +
        "무선 디버깅을 쓴다면 먼저 adb connect 로 붙여 두어야 합니다.",
    };
  }

  const ready = devices.filter((d) => d.state === "device");
  if (ready.length === 0) {
    const unauthorized = devices.filter((d) => d.state === "unauthorized");
    return {
      ...base,
      adbPath,
      devices,
      detail:
        unauthorized.length > 0
          ? "기기는 보이지만 USB 디버깅이 허용되지 않았습니다."
          : `기기 상태가 ${devices.map((d) => d.state).join(", ")} 입니다.`,
      remediation:
        unauthorized.length > 0
          ? "폰 화면에 뜬 'USB 디버깅을 허용하시겠습니까?' 에서 허용을 누르세요."
          : "기기를 다시 연결하거나 adb kill-server 후 재시도하세요.",
    };
  }

  /*
   * 같은 폰이 여러 항목으로 잡힐 수 있다. 무선 디버깅에서는 직접 연결한 `ip:port` 와
   * mDNS 가 찾은 이름이 **둘 다** 나온다. 하드웨어 일련번호로 묶어 한 대로 센다 —
   * 없는 문제로 사용자를 멈춰 세우면 안 된다.
   */
  const unique: AdbDevice[] = [];
  const seenHardware = new Set<string>();
  for (const d of ready) {
    const hw = new Adb(adbPath, d.serial).hardwareSerial();
    const key = hw ?? d.serial;
    if (seenHardware.has(key)) continue;
    seenHardware.add(key);
    unique.push(d);
  }

  /*
   * 그래도 여러 대면 **아무거나 고르지 않는다.**
   * 남의 기기에서 QA 가 돌면 되돌릴 수 없다.
   */
  const chosen =
    input.deviceSerial.trim() !== ""
      ? (unique.find((d) => d.serial === input.deviceSerial) ?? null)
      : unique.length === 1
        ? unique[0]!
        : null;

  if (!chosen) {
    return {
      ...base,
      adbPath,
      devices,
      detail:
        input.deviceSerial.trim() !== ""
          ? `지정한 기기(${input.deviceSerial})를 찾지 못했습니다.`
          : `기기가 ${unique.length}대 연결되어 있습니다. 어느 것을 쓸지 골라야 합니다.`,
      remediation: `연결된 기기: ${unique.map((d) => `${d.serial}${d.model ? ` (${d.model})` : ""}`).join(", ")}`,
    };
  }

  const adb = new Adb(adbPath, chosen.serial);
  const installed = input.packageName.trim() === "" ? null : adb.isInstalled(input.packageName);
  if (installed === false) {
    return {
      ...base,
      adbPath,
      devices,
      device: chosen,
      packageInstalled: false,
      detail: `${chosen.serial} 에 ${input.packageName} 가 설치되어 있지 않습니다.`,
      remediation:
        "패키지명이 맞는지 확인하세요. 기기에 설치된 목록은 adb shell pm list packages 로 볼 수 있습니다.",
    };
  }

  /*
   * 화면이 꺼졌거나 잠겨 있으면 탐색이 잠금화면을 훑는다.
   * 시작하기 전에 막는다 — 끝나고 나서 "화면 1개"를 보고 원인을 찾게 하면 안 된다.
   */
  const display = adb.displayState();
  if (!display.awake || display.locked) {
    return {
      ...base,
      adbPath,
      devices,
      device: chosen,
      packageInstalled: installed,
      detail: display.awake ? "기기 화면이 잠겨 있습니다." : "기기 화면이 꺼져 있습니다.",
      remediation:
        "폰 화면을 켜고 잠금을 푼 뒤 다시 확인하세요. " +
        "탐색 중에 화면이 꺼지지 않도록 개발자 옵션의 '충전 중 화면 켜짐 유지'를 켜 두면 편합니다.",
    };
  }

  const screen = adb.screenSize();
  return {
    ok: true,
    adbPath,
    devices,
    device: chosen,
    packageInstalled: installed,
    screen,
    detail:
      `기기 연결됨 · ${chosen.serial}${chosen.model ? ` (${chosen.model})` : ""}` +
      `${screen ? ` · ${screen.width}x${screen.height}` : ""}` +
      `${installed ? ` · ${input.packageName} 설치 확인` : ""}`,
    remediation: null,
  };
}
