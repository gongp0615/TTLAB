import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');
const indexHtml = readFileSync(join(repoRoot, 'index.html'), 'utf8');
const stylesCss = readFileSync(join(repoRoot, 'styles.css'), 'utf8');
const appJs = readFileSync(join(repoRoot, 'app.js'), 'utf8');

test('agent panel is docked inside the center workspace, not the left sidebar', () => {
  const mainStart = indexHtml.indexOf('<main class="main-content">');
  const agentStart = indexHtml.indexOf('<aside class="agent-panel"');
  const bodyWrapper = indexHtml.indexOf('<div class="main-content-body">');
  const mainEnd = indexHtml.indexOf('</main>');
  const sidebarEnd = indexHtml.indexOf('</aside>', indexHtml.indexOf('<aside class="sidebar"'));
  assert.ok(mainStart > 0, 'main-content should be present');
  assert.ok(sidebarEnd > 0, 'sidebar should be present');
  assert.ok(mainStart > sidebarEnd, 'main-content must come after the sidebar');
  assert.ok(agentStart > mainStart, 'agent-panel must be inside main-content');
  assert.ok(bodyWrapper > agentStart, 'main-content-body must wrap the workspace after the agent panel');
  assert.ok(mainEnd > bodyWrapper, 'main-content-body must be closed before </main>');
});

test('agent panel defaults to width 0 and only adds border and shadow when open', () => {
  const panelRule = stylesCss.match(/\.agent-panel\s*\{[^}]*\}/);
  const openRule = stylesCss.match(/\.agent-panel\.open\s*\{[^}]*\}/);
  assert.ok(panelRule !== null, '.agent-panel rule must exist');
  assert.ok(openRule !== null, '.agent-panel.open rule must exist');
  const panelBody = panelRule[0];
  const openBody = openRule[0];

  assert.match(panelBody, /width:\s*0/, 'closed panel must have width 0');
  assert.doesNotMatch(panelBody, /box-shadow/, 'closed panel must not have a box-shadow');
  assert.doesNotMatch(panelBody, /border-right/, 'closed panel must not have a visible right border');

  assert.match(openBody, /width:\s*380px/, 'open panel must be 380px wide');
  assert.match(openBody, /box-shadow/, 'open panel must show a box-shadow');
  assert.match(openBody, /border-right/, 'open panel must show a right border');
});

test('agent launcher is positioned at the workspace left edge on desktop and mobile', () => {
  const lines = stylesCss.split('\n');
  const baseLine = lines.find((line) => line.includes('.agent-launcher') && line.includes('calc(230px + 20px)'));
  assert.ok(baseLine !== undefined, 'launcher should sit 20px right of the 230px sidebar on desktop');
  const mobileLine = lines.find((line) => line.includes('@media (max-width: 900px)') && line.includes('left: 80px'));
  assert.ok(mobileLine !== undefined, 'launcher should sit 80px from the left on the collapsed 64px sidebar');
});

test('firmware management lives on its own page and is listed before system settings in the sidebar', () => {
  const secondaryNav = indexHtml.slice(indexHtml.indexOf('<nav class="nav-group secondary-nav"'), indexHtml.indexOf('</nav>', indexHtml.indexOf('<nav class="nav-group secondary-nav"')));
  const agentIndex = secondaryNav.indexOf('data-page="智能体"');
  const integrationIndex = secondaryNav.indexOf('data-page="集成中心"');
  const firmwareIndex = secondaryNav.indexOf('data-page="固件管理"');
  const settingsIndex = secondaryNav.indexOf('data-page="系统设置"');
  assert.ok(firmwareIndex > -1, '固件管理 nav item must exist');
  assert.ok(firmwareIndex > integrationIndex && firmwareIndex < settingsIndex, '固件管理 must be ordered before 系统设置');
  assert.ok(agentIndex > -1 && integrationIndex > agentIndex, 'existing nav order must be preserved');
  assert.ok(indexHtml.includes('id="firmwarePage"'), 'firmware management must be a dedicated page');
  assert.ok(indexHtml.includes('id="firmwareUploadForm"'), 'firmware upload form must still exist');
  assert.ok(!indexHtml.slice(indexHtml.indexOf('id="settingsPage"'), indexHtml.indexOf('</section>', indexHtml.indexOf('id="settingsPage"'))).includes('firmwareUploadForm'), 'system settings page must no longer contain the firmware form');
  assert.ok(indexHtml.includes('id="firmwareDeviceTypes"'), 'firmware upload form must expose a device category multi-select');
});

test('dashboard content-wrap fills the workspace when the agent panel is closed', () => {
  const rule = stylesCss.match(/\.content-wrap\s*\{[^}]*\}/);
  assert.ok(rule !== null, '.content-wrap rule must exist');
  const body = rule[0];
  assert.match(body, /width:\s*100%/, 'content-wrap must declare an explicit width so it fills the flex container');
  assert.match(body, /max-width:\s*1535px/, 'content-wrap must cap at 1535px so wide screens stay readable');
  assert.match(body, /margin:\s*0\s+auto/, 'content-wrap must center itself with auto horizontal margins');
  // Mobile breakpoint must keep the explicit width so the fix survives responsive collapse
  const mobileRule = stylesCss.match(/@media\s*\(max-width:\s*1280px\)\s*\{\s*\.content-wrap\s*\{[^}]*\}\s*\}/);
  assert.ok(mobileRule === null || !/width\s*:/.test(mobileRule[0]), 'mobile override must not strip the content-wrap width');
});

test('per-device serial log toggle lives at the end of the device action row and defaults to off', () => {
  assert.ok(appJs.includes('device-log-toggle'), 'device card must render a serial log toggle');
  assert.ok(appJs.includes('data-log-toggle'), 'toggle must carry the device id');
  assert.ok(appJs.includes('device-log-box'), 'toggle must reveal a per-device log box');
  assert.match(appJs, /logEnabled\s*=\s*Boolean\(logState\.get\(device\.deviceId\)\?\.enabled\)/, 'toggle must be driven by logState and default to off');
});

test('unoperable devices are unsubscribed and their log state is cleaned up', () => {
  // 设备不再可操作（如离线）时自动退订，避免日志持续推送但界面不可见
  assert.match(appJs, /logState\.set\(device\.deviceId,\s*\{\s*enabled:\s*false,\s*buffer:\s*'',\s*subscribed:\s*false\s*\}\)/, 'log state must be reset when the device is no longer operable');
  assert.match(appJs, /sendLogSubscription\(device\.deviceId,\s*'log\.unsubscribe'\)/, 'unoperable device must send log.unsubscribe');
});

test('history backfill skips when the toggle is switched off during load', () => {
  // 回填期间用户关闭开关时不再填充日志，也不再订阅
  assert.ok(appJs.includes("if (!logState.get(deviceId)?.enabled) return;"), 'backfill must abort when the toggle was switched off');
  assert.ok(appJs.includes("if (!logState.get(deviceId)?.enabled) return;\n    sendLogSubscription(deviceId, 'log.subscribe');"), 'subscribe must be skipped after backfill aborts');
});

