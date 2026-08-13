import { apiGet } from "@/lib/apiClient";

export function UserList() {
  async function load() {
    const res = await apiGet("/api/users");
    const user = await res.json();
    const { name, email } = user;
    return `${name} ${email}`;
  }

  return load();
}
