import type { WebSocket } from 'ws';

export type LogSubscriptionMessage =
  | { type: 'log.subscribe'; deviceId: string }
  | { type: 'log.unsubscribe'; deviceId: string };

const MAX_DEVICE_ID_LENGTH = 128;
const controlCharacterPattern = /[\u0000-\u001f\u007f]/;

/**
 * 解析 Web 事件通道上的日志订阅消息。
 * 仅接受 log.subscribe / log.unsubscribe 两种类型；非法消息返回 undefined。
 */
export function parseLogSubscriptionMessage(raw: string): LogSubscriptionMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  const type = candidate.type;
  if (type !== 'log.subscribe' && type !== 'log.unsubscribe') return undefined;
  const deviceId = candidate.deviceId;
  if (typeof deviceId !== 'string' || deviceId.trim().length === 0 || deviceId.length > MAX_DEVICE_ID_LENGTH || controlCharacterPattern.test(deviceId)) {
    return undefined;
  }
  return { type, deviceId };
}

export interface WebLogSubscriptionsOptions {
  /** 校验设备是否已注册；返回 false 时拒绝订阅 */
  isKnownDevice: (deviceId: string) => boolean;
}

/**
 * 管理 Web 事件连接对设备日志的订阅集合。
 * Server 只向订阅了对应 deviceId 的连接转发 device.log.chunk。
 */
export class WebLogSubscriptions {
  private readonly subscriptions = new Map<WebSocket, Set<string>>();
  private readonly options: WebLogSubscriptionsOptions;

  constructor(options: WebLogSubscriptionsOptions) {
    this.options = options;
  }

  attach(socket: WebSocket): void {
    const onMessage = (data: WebSocket.RawData) => {
      const message = parseLogSubscriptionMessage(data.toString());
      if (!message) return;
      const devices = this.subscriptions.get(socket) ?? new Set<string>();
      if (message.type === 'log.subscribe') {
        if (!this.options.isKnownDevice(message.deviceId)) return;
        devices.add(message.deviceId);
        this.subscriptions.set(socket, devices);
      } else {
        devices.delete(message.deviceId);
        if (devices.size === 0) this.subscriptions.delete(socket);
      }
    };
    const onClose = () => {
      this.subscriptions.delete(socket);
      socket.off('message', onMessage);
      socket.off('close', onClose);
    };
    socket.on('message', onMessage);
    socket.on('close', onClose);
  }

  subscribedDevices(socket: WebSocket): Set<string> {
    return this.subscriptions.get(socket) ?? new Set<string>();
  }
}
