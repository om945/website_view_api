import { config } from "../config/config";

export const securityHeaders: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cross-origin-resource-policy": "cross-origin",
  ...(config.nodeEnv === "production" ? { "strict-transport-security": "max-age=31536000; includeSubDomains" } : {}),
};
