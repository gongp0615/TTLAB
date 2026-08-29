import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import test from 'node:test';
import { probeTvStickPort } from '../apps/client/src/serial.js';

const respondingPtyScript = [
  'import os, pty, sys',
  'master, slave = pty.openpty()',
  'print(os.ttyname(slave), flush=True)',
  'while True:',
  '    try:',
  '        data = os.read(master, 256)',
  '    except OSError:',
  '        break',
  '    if not data:',
  '        break',
  "    if b'AT+PING?' in data:",
  "        os.write(master, b'PING:ok\\r\\n')",
  '    else:',
  "        os.write(master, b'ERROR\\r\\n')",
].join('\n');

const silentPtyScript = [
  'import os, pty, sys',
  'master, slave = pty.openpty()',
  'print(os.ttyname(slave), flush=True)',
  'while True:',
  '    try:',
  '        data = os.read(master, 256)',
  '    except OSError:',
  '        break',
  '    if not data:',
  '        break',
].join('\n');

interface PtyHarness {
  path: string;
  child: ChildProcess;
  close: () => void;
}

function ptyPath(script: string): Promise<PtyHarness> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', script], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('pty creation timeout')); }, 10_000);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      if (lines.length > 1) {
        clearTimeout(timeout);
        child.stdout.off('data', onData);
        resolve({ path: (lines[0] ?? '').trim(), child, close: () => child.kill('SIGKILL') });
      }
    };
    child.stdout.on('data', onData);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`pty process exited with ${code}`)); });
  });
}

test('serial session executes an AT command over a real tty and the probe succeeds', async () => {
  const pty = await ptyPath(respondingPtyScript);
  try {
    const result = await probeTvStickPort(pty.path, 3000);
    assert.equal(result, true);
  } finally {
    pty.close();
  }
});

test('serial session times out cleanly and releases the port when the device is silent', async () => {
  const pty = await ptyPath(silentPtyScript);
  try {
    const started = Date.now();
    const result = await Promise.race([
      probeTvStickPort(pty.path, 1500).then((ok) => ({ ok })),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
    ]);
    assert.notEqual(result, null, 'probe must complete within 8s (close must not hang)');
    assert.equal(result?.ok, false);
    assert.ok(Date.now() - started < 8000, 'probe must not hang');
    // A second session must still be able to open the same port afterwards.
    const again = await Promise.race([
      probeTvStickPort(pty.path, 500).then((ok) => ({ ok })),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
    assert.notEqual(again, null, 'second probe must complete');
    assert.equal(again?.ok, false);
  } finally {
    pty.close();
  }
});
