import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';

test.describe('Tracker Script Behavior', () => {
  let siteKey: string;
  let htmlContent: string;
  const TEST_URL = 'http://localhost:3000/test.html';

  test.beforeAll(async () => {
    siteKey = `test_site_${randomUUID().replace(/-/g, '')}`;
    htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Tracker Test</title>
      </head>
      <body>
        <h1>Tracker Test Page</h1>
        <script src="http://localhost:3000/script.js" data-site="${siteKey}" data-debug="true"></script>
        <script>
          window.navigateSpa = function(url) {
            window.history.pushState({}, '', url);
          };
        </script>
      </body>
      </html>
    `;
  });

  test.beforeEach(async ({ page }) => {
    // Intercept requests to TEST_URL and fulfill with our custom HTML
    await page.route(TEST_URL, route => {
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: htmlContent
      });
    });
  });

  test('visitor ID creation and persistence', async ({ page, context }) => {
    const requestPromise = page.waitForRequest(req => req.url().includes('/api/v1/track') && req.method() === 'POST');
    await page.goto(TEST_URL);
    const request = await requestPromise;
    const postData = JSON.parse(request.postData() || '{}');
    
    expect(postData.siteKey).toBe(siteKey);
    expect(postData.visitorId).toBeTruthy();

    const visitorId = postData.visitorId;

    // Check localStorage
    const storageKey = `website_tracker_visitor_${siteKey}`;
    const localStorageVid = await page.evaluate((key) => localStorage.getItem(key), storageKey);
    expect(localStorageVid).toBe(visitorId);

    // Reload the page and ensure the same visitor ID is sent
    const reloadRequestPromise = page.waitForRequest(req => req.url().includes('/api/v1/track') && req.method() === 'POST');
    await page.reload();
    const reloadRequest = await reloadRequestPromise;
    const reloadPostData = JSON.parse(reloadRequest.postData() || '{}');
    
    expect(reloadPostData.visitorId).toBe(visitorId);
  });

  test('SPA route tracking via pushState', async ({ page }) => {
    const initialRequestPromise = page.waitForRequest(req => req.url().includes('/api/v1/track'));
    await page.goto(TEST_URL);
    await initialRequestPromise;

    // Trigger a pushState navigation
    const spaRequestPromise = page.waitForRequest(req => req.url().includes('/api/v1/track'));
    await page.evaluate(() => (window as any).navigateSpa('/spa-route-123'));
    
    const spaRequest = await spaRequestPromise;
    const spaPostData = JSON.parse(spaRequest.postData() || '{}');
    
    expect(spaPostData.path).toContain('/spa-route-123');
  });

  test('tracker.track() custom events', async ({ page }) => {
    const initialRequestPromise = page.waitForRequest(req => req.url().includes('/api/v1/track'));
    await page.goto(TEST_URL);
    await initialRequestPromise;

    // Trigger a custom event
    const eventRequestPromise = page.waitForRequest(req => req.url().includes('/api/v1/events') && req.method() === 'POST');
    await page.evaluate(() => {
      (window as any).YourTracker.track('button_click', { button_name: 'test_btn' });
    });
    
    const eventRequest = await eventRequestPromise;
    const eventPostData = JSON.parse(eventRequest.postData() || '{}');
    
    expect(eventPostData.name).toBe('button_click');
    expect(eventPostData.properties.button_name).toBe('test_btn');
  });
  
  test('exactly one WebSocket connection and reconnect behavior', async ({ page }) => {
    let wsCount = 0;
    let activeSockets = 0;
    const routedSockets: import('@playwright/test').WebSocketRoute[] = [];
    await page.routeWebSocket(/\/ws\/track$/, ws => {
      wsCount++;
      activeSockets++;
      routedSockets.push(ws);
      ws.onMessage(() => {});
      ws.onClose(() => activeSockets--);
    });

    await page.goto(TEST_URL);
    await page.waitForFunction(() => (window as any).__YourTrackerTestState?.heartbeatActive === true);

    // Healthy navigation must not call connectPresence or create another socket.
    const healthyState = await page.evaluate(() => ({ ...(window as any).__YourTrackerTestState }));
    expect(wsCount).toBe(1);
    expect(routedSockets).toHaveLength(1);
    await page.evaluate(() => (window as any).navigateSpa('/healthy-route'));
    await page.waitForTimeout(100);
    const afterNavigation = await page.evaluate(() => ({ ...(window as any).__YourTrackerTestState }));
    expect(wsCount).toBe(1);
    expect(afterNavigation.connectCalls).toBe(healthyState.connectCalls);
    expect(afterNavigation.heartbeatStarts).toBe(1);
    expect(afterNavigation.reconnectTimerActive).toBe(false);

    // Explicitly close the original routed connection. This is the failure
    // condition that should exercise the tracker's bounded reconnect backoff.
    await routedSockets[0].close({ code: 1001, reason: 'intentional test disconnect' });
    await expect.poll(() => routedSockets.length, { timeout: 5000 }).toBe(2);
    await page.waitForFunction(() => (window as any).__YourTrackerTestState?.connectCalls === 2);

    expect(wsCount).toBe(2);
    expect(routedSockets).toHaveLength(2);
    expect(activeSockets).toBe(1);
    const reconnectState = await page.evaluate(() => ({ ...(window as any).__YourTrackerTestState }));
    expect(reconnectState.connectCalls).toBe(2);
    expect(reconnectState.heartbeatStarts).toBe(2);
    expect(reconnectState.heartbeatClears).toBe(1);
    expect(reconnectState.reconnectSchedules).toBe(1);
    expect(reconnectState.reconnectTimerActive).toBe(false);

    // Route changes after reconnect still reuse the replacement socket.
    await page.evaluate(() => (window as any).navigateSpa('/after-reconnect'));
    await page.waitForTimeout(100);
    const finalState = await page.evaluate(() => ({ ...(window as any).__YourTrackerTestState }));
    expect(wsCount).toBe(2);
    expect(finalState.connectCalls).toBe(2);
    expect(finalState.heartbeatStarts).toBe(2);
    expect(finalState.reconnectSchedules).toBe(1);
  });
});
