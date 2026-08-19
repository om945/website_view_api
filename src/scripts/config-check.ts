import { config } from "../config/config";

console.log(JSON.stringify({
  ok: true,
  environment: config.nodeEnv,
  trustedProxy: config.trustedProxy,
  corsOriginCount: config.corsOrigins.length,
  retentionDays: config.dataRetentionDays,
}));
