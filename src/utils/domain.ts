export function normalizeDomain(value: string) {
  const parsed = new URL(value.includes("://") ? value : `https://${value}`);
  return parsed.hostname.toLowerCase().replace(/^www\./, "");
}

export function domainOk(value: string) {
  try {
    const hostname = normalizeDomain(value);
    return hostname.includes(".") && !hostname.includes(" ") && !hostname.includes("/");
  } catch {
    return false;
  }
}
