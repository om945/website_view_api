import { config } from "../config/config";

function isLocalDevelopmentOrigin(value: string) {
  try {
    const origin = new URL(value);
    if (origin.protocol !== "http:") return false;
    if (origin.hostname !== "localhost" && origin.hostname !== "127.0.0.1") return false;
    return origin.port === "" || (Number(origin.port) >= 1 && Number(origin.port) <= 65535);
  } catch {
    return false;
  }
}

export function corsAllows(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  const path = new URL(request.url).pathname;
  const isPublicRoute = path.startsWith("/api/v1/public/") || path.includes("/api/v1/track") || path.includes("/api/v1/events");
  if (isPublicRoute) return true;

  return config.corsOrigins.includes(origin) || (config.nodeEnv !== "production" && isLocalDevelopmentOrigin(origin));
}
