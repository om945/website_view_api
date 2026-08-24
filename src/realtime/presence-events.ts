type PresenceSubscriber = {
  send: (message: string) => unknown;
};

const subscribers = new Map<string, Set<PresenceSubscriber>>();

export function subscribePresence(siteId: string, ws: PresenceSubscriber) {
  let siteSubscribers = subscribers.get(siteId);
  if (!siteSubscribers) {
    siteSubscribers = new Set();
    subscribers.set(siteId, siteSubscribers);
  }
  siteSubscribers.add(ws);
}

export function unsubscribePresence(siteId: string, ws: PresenceSubscriber) {
  const siteSubscribers = subscribers.get(siteId);
  if (!siteSubscribers) return;
  siteSubscribers.delete(ws);
  if (siteSubscribers.size === 0) subscribers.delete(siteId);
}

export function publishPresence(siteId: string, activeVisitors: number) {
  const siteSubscribers = subscribers.get(siteId);
  if (!siteSubscribers) return;

  const message = JSON.stringify({
    ok: true,
    type: "presence_update",
    activeVisitors,
  });

  for (const ws of siteSubscribers) {
    try {
      ws.send(message);
    } catch {
      siteSubscribers.delete(ws);
    }
  }
}
