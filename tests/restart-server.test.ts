import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const scriptPath = join(repoRoot, 'scripts', 'restart-server.sh');

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

const psFixture = `    PID COMMAND         ARGS
    100 node            node dist/apps/server/src/index.js
    101 node            node dist/apps/client/src/index.js
    102 bash            bash scripts/start-server.sh
    103 node            /home/user/.nvm/versions/node/v22/bin/node dist/apps/server/src/index.js
`;

test('restart-server.sh parses without syntax errors', async () => {
  const result = await runBash(['-n', scriptPath]);
  assert.equal(result.exitCode, 0, result.stderr);
});

test('server_pids awk filter matches only node server processes', async () => {
  const result = await runBash(['-c', `printf '%s' '${psFixture}' | awk -v module="dist/apps/server/src/index.js" '$2 == "node" && index($0, module) > 0 { print $1 }'`]);
  assert.equal(result.exitCode, 0, result.stderr);
  const pids = result.stdout.trim().split('\n').filter(Boolean);
  assert.deepEqual(pids, ['100', '103'], 'must match both relative and absolute node server paths, but not the client or bash wrapper');
});
