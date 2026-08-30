import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { parseLogSubscriptionMessage, WebLogSubscriptions } from '../apps/server/src/web-events.js';

test('parseLogSubscriptionMessage accepts valid subscribe and unsubscribe messages', () => {
  assert.deepEqual(parseLogSubscriptionMessage(JSON.stringify({ type: 'log.subscribe', deviceId: 'tvbox:abc' })), { type: 'log.subscribe', deviceId: 'tvbox:abc' });
  assert.deepEqual(parseLogSubscriptionMessage(JSON.stringify({ type: 'log.unsubscribe', deviceId: 'usb:vid-pid-serial' })), { type: 'log.unsubscribe', deviceId: 'usb:vid-pid-serial' });
});

test('parseLogSubscriptionMessage rejects invalid messages', () => {
  assert.equal(parseLogSubscriptionMessage('not json'), undefined);
  assert.equal(parseLogSubscriptionMessage(JSON.stringify({ type: 'log.subscribe' })), undefined);
  assert.equal(parseLogSubscriptionMessage(JSON.stringify({ type: 'log.subscribe', deviceId: '' })), undefined);
  assert.equal(parseLogSubscriptionMessage(JSON.stringify({ type: 'log.subscribe', deviceId: '  ' })), undefined);
  assert.equal(parseLogSubscriptionMessage(JSON.stringify({ type: 'log.subscribe', deviceId: 'x'.repeat(129) })), undefined);
  assert.equal(parseLogSubscriptionMessage(JSON.stringify({ type: 'log.subscribe', deviceId: 'bad\u0000id' })), undefined);
  assert.equal(parseLogSubscriptionMessage(JSON.stringify({ type: 'unknown.type', deviceId: 'tvbox:abc' })), undefined);
  assert.equal(parseLogSubscriptionMessage(JSON.stringify({ type: 'log.subscribe', deviceId: 42 })), undefined);
});

test('WebLogSubscriptions tracks subscriptions per connection and clears on close', async () => {
  const known = new Set(['tvbox:a', 'tvbox:b']);
  const manager = new WebLogSubscriptions({ isKnownDevice: (deviceId) => known.has(deviceId) });
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const sockets: WebSocket[] = [];
  try {
    server.on('connection', (socket) => {
      sockets.push(socket);
      manager.attach(socket);
    });

    const clientA = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(clientA, 'open');
    const clientB = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(clientB, 'open');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const serverSockets = sockets;
    assert.equal(serverSockets.length, 2);
    const [socketA, socketB] = serverSockets as [WebSocket, WebSocket];

    clientA.send(JSON.stringify({ type: 'log.subscribe', deviceId: 'tvbox:a' }));
    clientA.send(JSON.stringify({ type: 'log.subscribe', deviceId: 'tvbox:b' }));
    clientA.send(JSON.stringify({ type: 'log.unsubscribe', deviceId: 'tvbox:b' }));
    clientB.send(JSON.stringify({ type: 'log.subscribe', deviceId: 'tvbox:b' }));
    // 订阅不存在的设备应被忽略
    clientA.send(JSON.stringify({ type: 'log.subscribe', deviceId: 'tvbox:missing' }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual([...manager.subscribedDevices(socketA)], ['tvbox:a']);
    assert.deepEqual([...manager.subscribedDevices(socketB)], ['tvbox:b']);

    clientA.close();
    await once(clientA, 'close');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(manager.subscribedDevices(socketA).size, 0);
    assert.deepEqual([...manager.subscribedDevices(socketB)], ['tvbox:b']);
  } finally {
    for (const socket of sockets) socket.close();
    server.close();
  }
});
