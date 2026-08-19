import { randomUUID } from "node:crypto";

const ids = new WeakMap<Request, string>();
const validRequestId = /^[A-Za-z0-9_-]{8,128}$/;

export function requestId(request: Request) {
  const existing = ids.get(request);
  if (existing) return existing;
  const candidate = request.headers.get("x-request-id");
  const id = candidate && validRequestId.test(candidate) ? candidate : randomUUID();
  ids.set(request, id);
  return id;
}
