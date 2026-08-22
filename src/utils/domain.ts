export function normalizeDomain(value: string) {
  const parsed = new URL(value.includes("://") ? value : `https://${value}`);
  return parsed.hostname.toLowerCase().replace(/^www\./, "");
}

export function domainOk(value: string) {
  try {
    const hostname = normalizeDomain(value);
    const isLocalhost = hostname === "localhost";
    const isIpv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname);
    return (
      (hostname.includes(".") || isLocalhost || isIpv4) &&
      !hostname.includes(" ") &&
      !hostname.includes("/")
    );
  } catch {
    return false;
  }
}
