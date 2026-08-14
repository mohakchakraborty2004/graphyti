import { formatTitle } from "../src/lib/helper";

export function PostCard() {
  async function load() {
    const res = await fetch("/api/posts");
    const post = await res.json();
    return formatTitle(post.title);
  }

  return load();
}
