/**
 * 고정 시드 데이터. 난수 금지 — fixture는 항상 같은 결과를 내야 한다.
 * (탐색 결정성 DoD가 여기에 걸려 있다)
 */

export interface User {
  id: number;
  loginId: string;
  name: string;
  dept: string;
  role: "ADMIN" | "MANAGER" | "VIEWER";
  status: "ACTIVE" | "LOCKED";
  createdAt: string;
}

export interface Survey {
  id: number;
  title: string;
  owner: string;
  status: "DRAFT" | "OPEN" | "CLOSED" | "ARCHIVED";
  responses: number;
  createdAt: string;
}

const DEPTS = ["경영지원팀", "영업1팀", "영업2팀", "개발팀", "품질관리팀"];
const ROLES: User["role"][] = ["ADMIN", "MANAGER", "VIEWER"];

export const users: User[] = Array.from({ length: 47 }, (_, i) => {
  const n = i + 1;
  return {
    id: n,
    loginId: `user${String(n).padStart(3, "0")}`,
    name: `테스트사용자${n}`,
    dept: DEPTS[n % DEPTS.length]!,
    role: ROLES[n % ROLES.length]!,
    status: n % 11 === 0 ? "LOCKED" : "ACTIVE",
    createdAt: `2026-0${(n % 8) + 1}-${String((n % 27) + 1).padStart(2, "0")}`,
  };
});

export const surveys: Survey[] = Array.from({ length: 23 }, (_, i) => {
  const n = i + 1;
  const statuses: Survey["status"][] = ["DRAFT", "OPEN", "CLOSED", "ARCHIVED"];
  return {
    id: n,
    title: `2026년 ${n}차 만족도 조사`,
    owner: `테스트사용자${(n % 47) + 1}`,
    status: statuses[n % statuses.length]!,
    responses: n * 13,
    createdAt: `2026-0${(n % 8) + 1}-${String((n % 27) + 1).padStart(2, "0")}`,
  };
});

/**
 * 부서. **모달로 등록하는 SPA 화면**을 흉내내기 위한 데이터다.
 * 실측 관리자웹은 등록 화면이 `/new` 주소가 아니라 버튼 뒤의 모달이었고,
 * 그 탓에 Create·Update·Delete 가 전부 미실행으로 끝났다.
 */
export interface Dept {
  id: number;
  name: string;
  owner: string;
}

export const depts: Dept[] = Array.from({ length: 5 }, (_, i) => ({
  id: i + 1,
  name: DEPTS[i]!,
  owner: `테스트사용자${i + 1}`,
}));

export const createdDepts: Dept[] = [];

/** 런타임에 추가되는 데이터. QA가 만든 AUTO-QA-* 데이터가 여기 쌓인다. */
export const createdSurveys: Survey[] = [];
export const createdUsers: User[] = [];

export function resetRuntimeData(): void {
  createdSurveys.length = 0;
  createdUsers.length = 0;
  createdDepts.length = 0;
}

export const CREDENTIALS = { id: "admin", pw: "admin123!" };
