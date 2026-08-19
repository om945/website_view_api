import { config } from "../config/config";

type RequestServer = { requestIP?: (request: Request) => { address: string } | null };

export function clientIp(request: Request, server?: RequestServer | null) {
  if (config.trustedProxy) return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip") ?? "unknown";
  return server?.requestIP?.(request)?.address ?? request.headers.get("x-real-ip") ?? "unknown";
}
