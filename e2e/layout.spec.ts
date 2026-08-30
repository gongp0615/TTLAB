import { expect, test, type Page } from '@playwright/test';

const collectPageErrors = (page: Page): string[] => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // 外部 CDN（lucide）或字体在离线环境下的网络错误不属于应用错误。
    if (/net::ERR|Failed to load resource|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED/.test(text)) return;
    errors.push(text);
  });
  return errors;
};

const openDashboard = async (page: Page) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#deployButton')).toBeVisible();
};

test.describe('desktop layout', () => {
  test('renders the desktop shell with a persistent sidebar', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openDashboard(page);

    // Sidebar is docked inside the viewport; the hamburger toggle is hidden.
    const sidebar = page.locator('.sidebar');
    await expect(sidebar).toBeVisible();
    const sidebarBox = await sidebar.boundingBox();
    expect(sidebarBox!.x).toBeGreaterThanOrEqual(0);
    await expect(page.locator('#sidebarToggle')).toBeHidden();

    // Metric cards sit side by side.
    const clientMetric = page.locator('#clientMetric');
    const deviceMetric = page.locator('#deviceMetric');
    await expect(clientMetric).toBeVisible();
    await expect(deviceMetric).toBeVisible();
    const clientBox = await clientMetric.boundingBox();
    const deviceBox = await deviceMetric.boundingBox();
    expect(Math.abs(clientBox!.y - deviceBox!.y)).toBeLessThan(2);
    expect(deviceBox!.x).toBeGreaterThan(clientBox!.x);

    // Agent panel opens as a 380px docked panel.
    await page.locator('#agentLauncher').click();
    const panel = page.locator('.agent-panel.open');
    await expect(panel).toBeVisible();
    await expect(async () => {
      const panelBox = await panel.boundingBox();
      expect(Math.abs(panelBox!.width - 380)).toBeLessThan(2);
    }).toPass();
    await page.locator('#agentPanelClose').click();
    await expect(page.locator('.agent-panel.open')).toHaveCount(0);

    expect(errors).toEqual([]);
  });
});

test.describe('mobile layout', () => {
  test('uses a drawer navigation and stacks content', async ({ page }) => {
    const errors = collectPageErrors(page);
    await openDashboard(page);

    // Sidebar starts off-canvas; the hamburger toggle is visible.
    const sidebar = page.locator('.sidebar');
    const closedBox = await sidebar.boundingBox();
    expect(closedBox!.x + closedBox!.width).toBeLessThanOrEqual(1);
    await expect(page.locator('#sidebarToggle')).toBeVisible();

    // Opening the drawer slides the sidebar in and shows the backdrop.
    await page.locator('#sidebarToggle').tap();
    await expect(sidebar).toHaveClass(/open/);
    const openedBox = await sidebar.boundingBox();
    expect(openedBox!.x).toBeGreaterThanOrEqual(0);
    await expect(page.locator('#drawerBackdrop.open')).toBeVisible();

    // Navigating via the drawer closes it and switches the page.
    await page.locator('.nav-item[data-page="系统设置"]').tap();
    await expect(sidebar).not.toHaveClass(/open/);
    await expect(page.locator('#settingsPage')).toBeVisible();
    await expect(page.locator('#breadcrumbPage')).toHaveText('系统设置');

    // Back to the dashboard via the drawer.
    await page.locator('#sidebarToggle').tap();
    await page.locator('.nav-item[data-page="概览"]').tap();
    await expect(page.locator('.content-wrap')).toBeVisible();

    // Metric cards stack vertically on a phone.
    const clientMetric = page.locator('#clientMetric');
    const deviceMetric = page.locator('#deviceMetric');
    await expect(clientMetric).toBeVisible();
    await expect(deviceMetric).toBeVisible();
    const clientBox = await clientMetric.boundingBox();
    const deviceBox = await deviceMetric.boundingBox();
    expect(Math.abs(clientBox!.x - deviceBox!.x)).toBeLessThan(2);
    expect(deviceBox!.y).toBeGreaterThan(clientBox!.y);

    // Agent panel covers the full screen on mobile.
    await page.locator('#agentLauncher').tap();
    const panel = page.locator('.agent-panel.open');
    await expect(panel).toBeVisible();
    const panelBox = await panel.boundingBox();
    expect(panelBox!.width).toBeGreaterThanOrEqual(page.viewportSize()!.width - 1);
    await page.locator('#agentPanelClose').tap();
    await expect(page.locator('.agent-panel.open')).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('closes the drawer via backdrop and via Escape', async ({ page }) => {
    await openDashboard(page);

    const sidebar = page.locator('.sidebar');
    await page.locator('#sidebarToggle').tap();
    await expect(sidebar).toHaveClass(/open/);
    await page.locator('#drawerBackdrop').tap({ position: { x: 380, y: 400 } });
    await expect(sidebar).not.toHaveClass(/open/);

    await page.locator('#sidebarToggle').tap();
    await expect(sidebar).toHaveClass(/open/);
    await page.keyboard.press('Escape');
    await expect(sidebar).not.toHaveClass(/open/);
  });
});
