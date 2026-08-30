import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { nativeImage } from "electron";

/**
 * 아이콘 만들기.
 *
 * 원본 JPEG 하나에서 Windows 용 `.ico` 를 만든다. 외부 도구를 쓰지 않는 이유는
 * 이 저장소가 이미 Electron 을 갖고 있고, Electron 의 `nativeImage` 가 JPEG 디코딩과
 * 리사이즈를 둘 다 하기 때문이다. 아이콘 하나 만들자고 의존성을 늘리지 않는다.
 *
 * **여러 크기를 넣는다.** 256 하나만 넣으면 작업 표시줄과 파일 탐색기의 작은
 * 아이콘이 뭉개진다. Windows 는 필요한 크기를 골라 쓴다.
 *
 * 실행: ELECTRON_RUN_AS_NODE 없이 electron 으로 돌린다.
 *   npx electron scripts/make-icon.mjs
 */

const SIZES = [256, 128, 64, 48, 32, 16];

const root = resolve(import.meta.dirname, "..", "..", "..");
const source = resolve(root, "AI_QA_icon_15KB.jpg");
const outIco = resolve(import.meta.dirname, "..", "build", "icon.ico");
const outPng = resolve(import.meta.dirname, "..", "build", "icon.png");

const original = nativeImage.createFromPath(source);
if (original.isEmpty()) throw new Error(`아이콘 원본을 읽지 못했습니다: ${source}`);

const { width, height } = original.getSize();
if (width < 256 || height < 256) {
  throw new Error(`원본이 너무 작습니다 (${width}x${height}). 256x256 이상이어야 합니다.`);
}

mkdirSync(dirname(outIco), { recursive: true });

// electron-builder 가 다른 플랫폼용으로도 쓸 수 있게 PNG 를 같이 남긴다.
writeFileSync(outPng, original.resize({ width: 256, height: 256, quality: "best" }).toPNG());

/*
 * ICO 컨테이너를 직접 쓴다.
 * 헤더(6바이트) + 크기마다 디렉터리 항목(16바이트) + 이어지는 이미지 데이터.
 * Vista 이후로는 항목이 PNG 여도 되므로 BMP 로 바꿀 필요가 없다.
 */
const images = SIZES.map((size) => ({
  size,
  png: original.resize({ width: size, height: size, quality: "best" }).toPNG(),
}));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // 예약
header.writeUInt16LE(1, 2); // 1 = 아이콘
header.writeUInt16LE(images.length, 4);

const entries = [];
let offset = 6 + images.length * 16;
for (const { size, png } of images) {
  const e = Buffer.alloc(16);
  // 256 은 0 으로 적는다. 이 자리가 1바이트라 256 이 안 들어간다.
  e.writeUInt8(size >= 256 ? 0 : size, 0);
  e.writeUInt8(size >= 256 ? 0 : size, 1);
  e.writeUInt8(0, 2); // 팔레트 없음
  e.writeUInt8(0, 3); // 예약
  e.writeUInt16LE(1, 4); // 컬러 플레인
  e.writeUInt16LE(32, 6); // 비트 깊이
  e.writeUInt32LE(png.length, 8);
  e.writeUInt32LE(offset, 12);
  entries.push(e);
  offset += png.length;
}

writeFileSync(outIco, Buffer.concat([header, ...entries, ...images.map((i) => i.png)]));

const bytes = readFileSync(outIco).length;
console.log(`[icon] ${source}`);
console.log(`[icon] → build/icon.ico  ${SIZES.join("/")}px  ${Math.round(bytes / 1024)}KB`);
console.log(`[icon] → build/icon.png  256px`);

// Electron 은 창이 없어도 이벤트 루프를 붙잡고 있다. 할 일이 끝났으니 바로 나간다.
process.exit(0);
