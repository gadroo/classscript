import { proxyJsonPost } from "../../../_lib/upstream";

export async function POST(request: Request): Promise<Response> {
  return proxyJsonPost(request, "/v1/pipeline/run");
}
