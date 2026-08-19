const target = Bun.env.LOAD_TEST_URL ?? "http://localhost:3000/api/v1/track";
const siteKey = Bun.env.LOAD_TEST_SITE_KEY;
const requests = Number(Bun.env.LOAD_TEST_REQUESTS ?? 100);

if (!siteKey) throw new Error("LOAD_TEST_SITE_KEY is required");

const started = performance.now();
const results = await Promise.all(Array.from({ length: requests }, async (_, index) => {
  const response = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ siteKey, visitorId: crypto.randomUUID(), eventId: crypto.randomUUID(), path: `/load/${index}` }),
  });
  return response.status;
}));
const durationMs = performance.now() - started;
console.log(JSON.stringify({ requests, durationMs: Math.round(durationMs), requestsPerSecond: Number((requests / (durationMs / 1000)).toFixed(2)), failures: results.filter((status) => status >= 400).length }));
