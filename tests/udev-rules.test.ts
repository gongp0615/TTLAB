import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const scriptPath = join(repoRoot, 'scripts', 'install-udev-rules.sh');
const rulesSource = join(repoRoot, 'udev', '99-ttlab-serial.rules');

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runBash(args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile('bash', args, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        reject(error);
        return;
      }
      resolve({ exitCode: error ? (error.code as number) : 0, stdout, stderr });
    });
  });
}

test('install-udev-rules.sh parses without syntax errors', async () => {
  const result = await runBash(['-n', scriptPath]);
  assert.equal(result.exitCode, 0, result.stderr);
});

test('udev rules file matches the TTLAB device vendor and product ids', async () => {
  const rules = await runBash(['-c', `cat '${rulesSource}'`]);
  assert.equal(rules.exitCode, 0, rules.stderr);
  assert.match(rules.stdout, /SUBSYSTEM=="tty", ATTRS\{idVendor\}=="28e9", ATTRS\{idProduct\}=="018a", MODE="0666"/);
  assert.match(rules.stdout, /SUBSYSTEM=="tty", ATTRS\{idVendor\}=="10c4", ATTRS\{idProduct\}=="ea70", MODE="0666"/);
});

test('install-udev-rules.sh status runs without root', async () => {
  const result = await runBash([scriptPath, 'status']);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /TTLAB udev rules/);
});
