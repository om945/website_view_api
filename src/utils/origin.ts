export function isLocalDevelopmentOrigin(value: string) {
  try {
    const origin = new URL(value);
    if (origin.protocol !== "http:") return false;
    if (origin.hostname !== "localhost" && origin.hostname !== "127.0.0.1") return false;
    return origin.port === "" || (Number(origin.port) >= 1 && Number(origin.port) <= 65535);
  } catch {
    return false;
  }
}

export function isHttpsOrigin(value: string) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
