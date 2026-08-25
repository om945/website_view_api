import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';

test.describe('Tracker Script Behavior', () => {
  let siteKey: string;
  let htmlContent: string;
  const TEST_URL = 'http://localhost:3100/test.html';

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
        <script src="http://localhost:3100/script.js" data-site="${siteKey}" data-debug="true"></script>
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
  
});
