import { NextResponse } from "next/server";

const DEFAULT_LOCAL_API_ORIGIN = "http://127.0.0.1:4000";

function resolveApiOrigin(): string {
  const value = process.env.CURRICULUM_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_LOCAL_API_ORIGIN;
  return value.replace(/\/+$/, "");
}

export async function proxyJsonPost(request: Request, upstreamPath: string): Promise<Response> {
  const upstreamUrl = `${resolveApiOrigin()}${upstreamPath}`;
  const body = await request.text();

  try {
    const response = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": request.headers.get("content-type") ?? "application/json",
      },
      body,
      cache: "no-store",
    });

    const contentType = response.headers.get("content-type") ?? "application/json";
    const payload = await response.text();
    return new Response(payload, {
      status: response.status,
      headers: {
        "Content-Type": contentType,
      },
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : "unknown network failure";
    return NextResponse.json(
      {
        error:
          "Unable to reach curriculum API upstream. Set CURRICULUM_API_URL in the web deployment environment.",
        details,
        upstreamUrl,
      },
      { status: 502 },
    );
  }
}
