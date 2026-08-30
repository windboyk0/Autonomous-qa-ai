// SRC-11: API 토큰이 소스에 하드코딩되어 있다. 번들에 그대로 실려 나간다.
// (fixture 전용 가짜 값이다)
const API_TOKEN = "sk-fixture-DO-NOT-USE-0000";

export interface UserDto {
  id: number;
  loginId: string;
  name: string;
}

export async function fetchUsers(keyword: string): Promise<UserDto[]> {
  // SRC-08: res.ok 를 확인하지 않는다. 500 이 와도 json() 을 시도하고,
  //         화면에는 빈 목록이 정상처럼 보인다.
  const res = await fetch("/api/users?keyword=" + keyword, {
    headers: { Authorization: "Bearer " + API_TOKEN },
  });
  return res.json();
}

export async function createUser(body: unknown): Promise<void> {
  // SRC-09: 실패해도 catch 가 없어 조용히 묻힌다.
  fetch("/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function deleteUser(id: number): Promise<Response> {
  return fetch("/api/users/" + id, { method: "DELETE" });
}
