import { config } from "../config/config";
import { isLocalDevelopmentOrigin } from "./origin";

type CorsOptions = {
  allowedOrigins: readonly string[];
  nodeEnv: string;
  allowLocalhostCorsInProduction: boolean;
};

export function corsOriginAllowed(origin: string, path: string, options: CorsOptions) {
  const isPublicRoute = path.startsWith("/api/v1/public/") || path.includes("/api/v1/track") || path.includes("/api/v1/events");
  if (isPublicRoute) return true;

  return options.allowedOrigins.includes(origin) || ((options.nodeEnv !== "production" || options.allowLocalhostCorsInProduction) && isLocalDevelopmentOrigin(origin));
}

export function corsAllows(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  const path = new URL(request.url).pathname;
  return corsOriginAllowed(origin, path, {
    allowedOrigins: config.corsOrigins,
    nodeEnv: config.nodeEnv,
    allowLocalhostCorsInProduction: config.allowLocalhostCorsInProduction,
  });
}
