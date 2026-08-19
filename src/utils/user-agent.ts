import { UAParser } from "ua-parser-js";

export function parseUserAgent(userAgent: string) {
  const result = new UAParser(userAgent).getResult();
  const deviceType = result.device.type === "mobile" ? "mobile" : result.device.type === "tablet" ? "tablet" : result.device.type ? "unknown" : "desktop";
  return { deviceType, browser: result.browser.name ?? null, browserVersion: result.browser.version ?? null, os: result.os.name ?? null, osVersion: result.os.version ?? null };
}
