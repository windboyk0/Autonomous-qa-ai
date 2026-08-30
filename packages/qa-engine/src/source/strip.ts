/**
 * 주석을 지운다. **줄 번호와 길이는 그대로 둔다.**
 *
 * 룰을 원문에 그대로 돌리면 주석이 판정을 바꾼다. 실측에서 바로 걸렸다 —
 * `// res.ok 를 확인하지 않는다` 라고 적힌 주석 때문에 룰이 "이 함수는 res.ok 를
 * 확인한다"고 판단해 결함을 놓쳤다. 반대 방향도 마찬가지로 위험하다.
 * fixture 주석에 `SRC-02` 가 있다고 그것을 근거로 결함을 맞히면 채점이 거짓말이 된다.
 *
 * 그래서 **룰은 주석이 지워진 텍스트만 본다.** 공백으로 치환하므로
 * 오프셋이 유지되고 줄 번호 계산이 그대로 맞는다.
 */

/** 문자열 리터럴 안의 `//` 는 주석이 아니다. `"http://x"` 가 잘리면 안 된다. */
export function stripComments(text: string, opts: { hash?: boolean } = {}): string {
  const out = text.split("");
  let i = 0;
  const n = text.length;

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k += 1) {
      if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
    }
  };

  while (i < n) {
    const ch = text[i]!;
    const next = text[i + 1];

    // 문자열 리터럴은 통째로 건너뛴다.
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < n) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          i += 1;
          break;
        }
        // 따옴표가 안 닫힌 채 줄이 끝나면 리터럴이 아니다. 빠져나온다.
        if (quote !== "`" && text[i] === "\n") break;
        i += 1;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      blank(i, end < 0 ? n : end);
      i = end < 0 ? n : end;
      continue;
    }

    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }

    // yml / properties 주석. JS/TS 의 #private 필드와 구분해야 하므로 기본은 끈다.
    if (opts.hash === true && ch === "#") {
      const end = text.indexOf("\n", i);
      blank(i, end < 0 ? n : end);
      i = end < 0 ? n : end;
      continue;
    }

    i += 1;
  }

  return out.join("");
}
