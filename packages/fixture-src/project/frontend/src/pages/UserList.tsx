import { useEffect, useState } from "react";
import { fetchUsers, type UserDto } from "../api/userApi";

export function UserList() {
  const [rows, setRows] = useState<UserDto[]>([]);
  const [keyword, setKeyword] = useState("");

  useEffect(() => {
    void fetchUsers(keyword).then(setRows);
  }, [keyword]);

  return (
    <div>
      <h1>사용자 관리</h1>
      <input value={keyword} onChange={(e) => setKeyword(e.target.value)} />
      <table>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.loginId}</td>
              {/* SRC-10: 서버에서 온 값을 그대로 HTML 로 넣는다. 저장형 XSS 경로다. */}
              <td dangerouslySetInnerHTML={{ __html: r.name }} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
