import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');
const indexHtml = readFileSync(join(repoRoot, 'index.html'), 'utf8');
const stylesCss = readFileSync(join(repoRoot, 'styles.css'), 'utf8');

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
