import React from "react";

interface PostCardProps {
  post: {
    id: number;
    headline: string;
    content?: string | null;
    published: boolean;
    status: string;
  };
}

export default function PostCard({ post }: PostCardProps) {
  return (
    <div className="p-4 border rounded-lg shadow-sm bg-white dark:bg-gray-800">
      <h2 className="text-xl font-bold mb-2">{post.headline}</h2>
      {post.content && <p className="text-gray-600 dark:text-gray-300 mb-4">{post.content}</p>}
      <div className="flex items-center justify-between text-sm text-gray-500">
        <span>Status: {post.status}</span>
        <span>{post.published ? "Published" : "Draft"}</span>
      </div>
    </div>
  );
}