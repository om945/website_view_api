import { createHmac, randomUUID } from "node:crypto";
import { config } from "../config/config";

export const hash = (value: string, secret = config.visitorHashSecret) => createHmac("sha256", secret).update(value).digest("hex");
export const newKey = () => `site_${randomUUID().replaceAll("-", "")}`;
