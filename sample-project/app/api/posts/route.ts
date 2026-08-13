import { prisma } from "@/lib/prisma";
import { formatTitle } from "@/lib/helper";

export async function GET() {
  const posts = await prisma.post.findMany({
    select: {
      id: true,
      title: true,
      author: true,
    },
    where: {
      published: true,
    },
  });
  return Response.json(posts.map((p) => ({ ...p, title: formatTitle(p.title) })));
}

export async function POST(req: Request) {
  const body = (await req.json()) as { title: string; content?: string; authorId: number };
  const post = await prisma.post.create({
    data: {
      title: body.title,
      content: body.content,
      authorId: body.authorId,
    },
  });
  return Response.json(post);
}
