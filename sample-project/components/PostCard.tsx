import React from "react";
import { formatTitle } from "../src/lib/helper";

interface PostCardProps {
  post: {
    id: number;
    title?: string | null;
    content?: string | null;
    published: boolean;
    status: string;
    priority?: number;
    author?: {
      name?: string | null;
      email: string;
    } | null;
  };
}

export default function PostCard({ post }: PostCardProps) {
  const formattedTitle = formatTitle(post.title || "");

  return (
    <div className="border rounded-lg p-4 shadow-sm bg-white dark:bg-zinc-900">
      <div className="flex justify-between items-start mb-2">
        <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{formattedTitle || "Untitled"}</h3>
        <div className="flex items-center gap-2">
          {post.priority !== undefined && (
            <span className="text-xs px-2 py-1 bg-gray-100 text-gray-800 dark:bg-zinc-800 dark:text-zinc-200 rounded">
              Priority: {post.priority}
            </span>
          )}
          <span className="px-2 py-1 text-xs font-medium rounded bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
            {post.status}
          </span>
        </div>
      </div>
      <p className="text-zinc-600 dark:text-zinc-300 text-sm mb-4">{post.content || "No content"}</p>
      <div className="flex justify-between items-center text-xs text-zinc-500 dark:text-zinc-400">
        <span>By {post.author?.name || post.author?.email || "Anonymous"}</span>
        <span>{post.published ? "Published" : "Draft"}</span>
      </div>
    </div>
  );
}