/**
 * 锁定广播：任一标签页锁定时通知其它标签页立即撤去明文。
 * 浏览器里用 BroadcastChannel；测试里用进程内实现。
 */
export interface LockBus {
  broadcastLock(): void;
  onLock(handler: () => void): void;
  close(): void;
}

export class BroadcastLockBus implements LockBus {
  private readonly channel: BroadcastChannel;

  constructor(channelName = 'secure-notes-workbench-lock') {
    this.channel = new BroadcastChannel(channelName);
  }

  broadcastLock(): void {
    this.channel.postMessage({ type: 'lock' });
  }

  onLock(handler: () => void): void {
    this.channel.onmessage = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type === 'lock') handler();
    };
  }

  close(): void {
    this.channel.close();
  }
}

/** 进程内总线：同一实例的广播会送达所有监听者（供测试与降级使用） */
export class LocalLockBus implements LockBus {
  private readonly handlers = new Set<() => void>();

  broadcastLock(): void {
    for (const handler of this.handlers) handler();
  }

  onLock(handler: () => void): void {
    this.handlers.add(handler);
  }

  close(): void {
    this.handlers.clear();
  }
}
