import { useState } from "react";
import { createUser } from "../api/userApi";

export function UserForm() {
  const [loginId, setLoginId] = useState("");
  const [name, setName] = useState("");
  const [departmentId, setDepartmentId] = useState<number | null>(null);

  // 부서를 고르지 않아도 저장이 막히지 않는다. 서버의 SRC-07 과 짝을 이룬다.
  const save = () => {
    void createUser({ loginId, name, departmentId });
  };

  return (
    <div>
      <h1>사용자 등록</h1>
      <input value={loginId} onChange={(e) => setLoginId(e.target.value)} />
      <input value={name} onChange={(e) => setName(e.target.value)} />
      <select onChange={(e) => setDepartmentId(Number(e.target.value) || null)}>
        <option value="">부서 선택</option>
      </select>
      <button onClick={save}>저장</button>
    </div>
  );
}
