import type { Page } from "playwright";

/**
 * 폼 분석 (CLAUDE.md §10).
 *
 * 화면에 있는 입력 요소를 찾아 무엇을 채워야 하는지 판단한다.
 * **여기서는 아무것도 채우지 않는다** — 사실만 모으고, 채우는 것은 crud.ts가 한다.
 */

export type FieldKind =
  | "text"
  | "email"
  | "number"
  | "date"
  | "tel"
  | "url"
  | "textarea"
  | "select"
  | "checkbox"
  | "radio"
  | "file"
  | "password"
  | "unknown";

export interface FormField {
  kind: FieldKind;
  selector: string;
  name: string;
  label: string;
  /** `required` 속성 또는 라벨의 `*` 로 판단한다. */
  required: boolean;
  /** select의 첫 유효 옵션 값. 빈 값("선택하세요")은 건너뛴다. */
  firstOption: string | null;
  disabled: boolean;
}

export interface FormInfo {
  /** 폼을 특정하는 셀렉터. 폼 태그가 없으면 화면 전체를 대상으로 본다. */
  formSelector: string | null;
  fields: FormField[];
  /** 저장·등록으로 보이는 버튼. 없으면 null. */
  submitSelector: string | null;
  submitLabel: string | null;
}

const SUBMIT_WORDS = /(저장|등록|추가|확인|제출|생성|수정|완료|submit|save)/;

export async function analyzeForm(page: Page): Promise<FormInfo | null> {
  return page.evaluate((submitPattern: string) => {
    const submitRe = new RegExp(submitPattern);

    const visible = (el: Element): boolean => {
      if (typeof (el as HTMLElement).checkVisibility === "function") {
        return (el as HTMLElement).checkVisibility();
      }
      const s = window.getComputedStyle(el);
      return s.display !== "none" && s.visibility !== "hidden";
    };

    const describe = (el: Element): string => {
      const testid = el.getAttribute("data-testid");
      if (testid) return `[data-testid="${testid}"]`;
      if (el.id) return `#${CSS.escape(el.id)}`;
      const name = el.getAttribute("name");
      if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
      return "";
    };

    /** 라벨 문구. for=id 연결이 우선, 없으면 감싼 label. */
    const labelOf = (el: Element): string => {
      const id = el.getAttribute("id");
      if (id) {
        const bound = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (bound) return (bound.textContent ?? "").trim();
      }
      const wrapper = el.closest("label");
      return wrapper ? (wrapper.textContent ?? "").trim() : "";
    };

    const form = document.querySelector("form");
    const root: ParentNode = form ?? document;

    const controls = Array.from(
      root.querySelectorAll<HTMLElement>("input, select, textarea"),
    ).filter(visible);

    const fields: FormField[] = [];
    for (const el of controls) {
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") ?? "text").toLowerCase();
      if (tag === "input" && (type === "submit" || type === "button" || type === "hidden")) continue;

      const selector = describe(el);
      if (!selector) continue;

      const inputKinds: FieldKind[] = [
        "text",
        "email",
        "number",
        "date",
        "tel",
        "url",
        "checkbox",
        "radio",
        "file",
        "password",
      ];
      let kind: FieldKind = "unknown";
      if (tag === "textarea") kind = "textarea";
      else if (tag === "select") kind = "select";
      else {
        const matched = inputKinds.find((k) => k === type);
        if (matched) kind = matched;
      }

      const label = labelOf(el);
      let firstOption: string | null = null;
      if (tag === "select") {
        const options = Array.from((el as HTMLSelectElement).options).filter(
          (o) => o.value.trim() !== "" && !o.disabled,
        );
        firstOption = options[0]?.value ?? null;
      }

      fields.push({
        kind,
        selector,
        name: el.getAttribute("name") ?? el.getAttribute("id") ?? "",
        label,
        // `required` 속성이 없어도 라벨의 * 는 필수라는 관례다.
        required: el.hasAttribute("required") || /\*/.test(label),
        firstOption,
        disabled: (el as HTMLInputElement).disabled,
      });
    }

    // 저장 버튼: 폼 안의 버튼 중 라벨이 저장/등록 계열인 것.
    let submitSelector: string | null = null;
    let submitLabel: string | null = null;
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("button, input[type=submit]"))) {
      if (!visible(el)) continue;
      const text = (el.getAttribute("value") ?? el.textContent ?? "").trim();
      if (!submitRe.test(text)) continue;
      const selector = describe(el);
      if (!selector) continue;
      submitSelector = selector;
      submitLabel = text;
      break;
    }

    return {
      formSelector: form ? describe(form) || "form" : null,
      fields,
      submitSelector,
      submitLabel,
    };
  }, SUBMIT_WORDS.source);
}

/** 채울 수 있는 필드인가. 비밀번호·파일은 기본적으로 건드리지 않는다. */
export function isFillable(field: FormField): boolean {
  if (field.disabled) return false;
  if (field.kind === "file" || field.kind === "password") return false;
  return true;
}
