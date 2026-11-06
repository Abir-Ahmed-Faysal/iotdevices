import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "../../../lib/auth";
import { prisma } from "../../../lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!authenticate(request)) {
    return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  }

  try {
    const cursorValue = request.nextUrl.searchParams.get("cursor");
    if (cursorValue !== null && !/^\d+$/.test(cursorValue)) {
      return NextResponse.json({ error: "Invalid activity cursor." }, { status: 400 });
    }

    const activity = await prisma.activityEvent.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
      ...(cursorValue ? { cursor: { id: BigInt(cursorValue) }, skip: 1 } : {}),
      select: {
        id: true,
        eventType: true,
        message: true,
        createdAt: true,
      },
    });
    const hasMore = activity.length > 50;
    const page = hasMore ? activity.slice(0, 50) : activity;
    return NextResponse.json({
      activity: page.map((event) => ({
        ...event,
        id: event.id.toString(),
      })),
      nextCursor: hasMore ? page[page.length - 1].id.toString() : null,
    });
  } catch (error) {
    console.error("Could not load activity history:", error);
    return NextResponse.json(
      { error: "Activity history is unavailable. Check the database connection and migration." },
      { status: 503 },
    );
  }
}
