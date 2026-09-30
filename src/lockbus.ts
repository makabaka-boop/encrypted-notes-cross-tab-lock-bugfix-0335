export type LockBusMessage =
  | { type: 'lock' }
  | { type: 'passphrase-changed' };

/**
 * 跨标签页状态广播：
 * - lock：任一标签页锁定，所有标签页立即撤去明文；
 * - passphrase-changed：数据密钥封装已更换，使用旧会话代次的标签页必须注销。
 */
export interface LockBus {
  broadcastLock(): void;
  broadcastPassphraseChanged(): void;
  onMessage(handler: (message: LockBusMessage) => void): void;

  /** 兼容旧调用；新代码请使用 onMessage */
  onLock(handler: () => void): void;
  close(): void;
}

interface BroadcastEnvelope {
  source: string;
  message: LockBusMessage;
}

export class BroadcastLockBus implements LockBus {
  private readonly channel: BroadcastChannel;
  private handler: ((message: LockBusMessage) => void) | null = null;

  constructor(
    channelName = 'secure-notes-workbench-lock',
    private readonly source = globalThis.crypto.randomUUID(),
  ) {
    this.channel = new BroadcastChannel(channelName);
    this.channel.onmessage = (event: MessageEvent<BroadcastEnvelope>) => {
      if (event.data?.source === this.source) return;
      if (event.data?.message?.type === undefined) return;
      this.handler?.(event.data.message);
    };
  }

  broadcastLock(): void {
    const envelope: BroadcastEnvelope = {
      source: this.source,
      message: { type: 'lock' },
    };
    this.channel.postMessage(envelope);
  }

  broadcastPassphraseChanged(): void {
    const envelope: BroadcastEnvelope = {
      source: this.source,
      message: { type: 'passphrase-changed' },
    };
    this.channel.postMessage(envelope);
  }

  onMessage(handler: (message: LockBusMessage) => void): void {
    this.handler = handler;
  }

  onLock(handler: () => void): void {
    const previous = this.handler;
    this.handler = (message) => {
      previous?.(message);
      if (message.type === 'lock') handler();
    };
  }

  close(): void {
    this.handler = null;
    this.channel.close();
  }
}

type LocalPeer = {
  source: string;
  deliver(message: LockBusMessage): void;
};

export type LocalLockHub = Set<LocalPeer>;

/**
 * 进程内总线。默认每个实例独立（供普通测试）；传入共享 hub 时模拟多个标签页。
 * 广播不会回送发送者。
 */
export class LocalLockBus implements LockBus {
  private handler: ((message: LockBusMessage) => void) | null = null;
  private readonly peer: LocalPeer;

  constructor(
    private readonly hub: Set<LocalPeer> = new Set(),
    source = globalThis.crypto.randomUUID(),
  ) {
    this.peer = {
      source,
      deliver: (message) => this.handler?.(message),
    };
    this.hub.add(this.peer);
  }

  broadcastLock(): void {
    this.publish({ type: 'lock' });
  }

  broadcastPassphraseChanged(): void {
    this.publish({ type: 'passphrase-changed' });
  }

  onMessage(handler: (message: LockBusMessage) => void): void {
    this.handler = handler;
  }

  onLock(handler: () => void): void {
    const previous = this.handler;
    this.handler = (message) => {
      previous?.(message);
      if (message.type === 'lock') handler();
    };
  }

  close(): void {
    this.handler = null;
    this.hub.delete(this.peer);
  }

  private publish(message: LockBusMessage): void {
    for (const peer of [...this.hub]) {
      if (peer.source !== this.peer.source) peer.deliver(message);
    }
  }
}
