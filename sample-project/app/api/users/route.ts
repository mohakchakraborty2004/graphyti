import { prisma } from "../../../src/lib/prisma";

export async function GET() {
  const users = await prisma.user.findFirst({
    select: {
      id: true,
      name: true,
      email: true,
    },
  });
  return Response.json(users);
}
