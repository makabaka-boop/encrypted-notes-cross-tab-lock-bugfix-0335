import {
  deriveKek,
  generateDataKey,
  KDF_ITERATIONS,
  randomBytes,
  unwrapDataKey,
  wrapDataKey,
} from './crypto';
import type { NotesDB } from './db';
import { AuthError } from './errors';
import type { LockBus } from './lockbus';
import { NoteStore } from './store';
import type { WrappedKeyRecord } from './types';

const META_WRAPPED_KEY = 'wrappedDataKey';

export interface SessionOptions {
  /** PBKDF2 迭代次数，测试可注入小值 */
  iterations?: number;
}

/**
 * 会话：负责解锁/锁定/改口令。
 *
 * - 口令只在 unlock / initialize / changePassphrase 调用期间存在于内存，
 *   派生出 KEK 后立即丢弃引用，绝不写盘；
 * - 数据密钥解锁期间驻留内存，锁定（本地或收到广播）时立即销毁，
 *   并触发 onWipe 让 UI 撤去一切明文；
 * - 改口令只重新封装数据密钥（单次原子 put），不触碰任何便笺密文；
 *   写入失败时 IndexedDB 事务回滚，旧封装保持不变。
 */
export class Session {
  private dataKey: CryptoKey | null = null;
  private store: NoteStore | null = null;
  private readonly iterations: number;

  /** 锁定（含其它标签页广播导致的锁定）后回调，UI 用它立即清空明文 */
  onWipe: (() => void) | null = null;

  constructor(
    private readonly db: NotesDB,
    private readonly bus: LockBus,
    options: SessionOptions = {},
  ) {
    this.iterations = options.iterations ?? KDF_ITERATIONS;
    this.bus.onLock(() => this.wipe());
  }

  get unlocked(): boolean {
    return this.store !== null;
  }

  /** 已解锁时返回业务层；锁定状态调用即抛错 */
  get noteStore(): NoteStore {
    if (this.store === null) throw new AuthError('工作台已锁定');
    return this.store;
  }

  async isInitialized(): Promise<boolean> {
    return (await this.db.getMeta<WrappedKeyRecord>(META_WRAPPED_KEY)) !== undefined;
  }

  /** 首次使用：生成随机数据密钥，用口令派生的 KEK 封装后落盘 */
  async initialize(passphrase: string): Promise<void> {
    if (await this.isInitialized()) {
      throw new AuthError('工作台已初始化，请直接解锁');
    }
    const dataKey = await generateDataKey();
    const salt = randomBytes(16);
    const kek = await deriveKek(passphrase, salt, this.iterations);
    const { wrapIv, wrappedKey } = await wrapDataKey(dataKey, kek);
    const record: WrappedKeyRecord = {
      kdf: { salt, iterations: this.iterations },
      wrapIv,
      wrappedKey,
    };
    await this.db.putMeta(META_WRAPPED_KEY, record);
    this.setUnlocked(dataKey);
  }

  /** 解锁：口令错误抛 AuthError，且不会改动任何已存数据 */
  async unlock(passphrase: string): Promise<void> {
    const record = await this.db.getMeta<WrappedKeyRecord>(META_WRAPPED_KEY);
    if (record === undefined) throw new AuthError('工作台尚未初始化');
    const kek = await deriveKek(passphrase, record.kdf.salt, record.kdf.iterations);
    let dataKey: CryptoKey;
    try {
      dataKey = await unwrapDataKey(record.wrappedKey, record.wrapIv, kek);
    } catch {
      throw new AuthError();
    }
    this.setUnlocked(dataKey);
  }

  /**
   * 改口令：先验证当前口令，再用新盐派生 KEK 重新封装同一数据密钥。
   * 便笺密文一个字节都不动；putMeta 是单次原子写入，
   * 中途失败（掉电/配额/异常）时旧封装原样保留，旧口令依然有效。
   */
  async changePassphrase(current: string, next: string): Promise<void> {
    if (this.dataKey === null) throw new AuthError('工作台已锁定');
    const record = await this.db.getMeta<WrappedKeyRecord>(META_WRAPPED_KEY);
    if (record === undefined) throw new AuthError('工作台尚未初始化');

    const oldKek = await deriveKek(current, record.kdf.salt, record.kdf.iterations);
    try {
      await unwrapDataKey(record.wrappedKey, record.wrapIv, oldKek);
    } catch {
      throw new AuthError('当前口令错误');
    }

    const salt = randomBytes(16);
    const newKek = await deriveKek(next, salt, this.iterations);
    const { wrapIv, wrappedKey } = await wrapDataKey(this.dataKey, newKek);
    const nextRecord: WrappedKeyRecord = {
      kdf: { salt, iterations: this.iterations },
      wrapIv,
      wrappedKey,
    };
    await this.db.putMeta(META_WRAPPED_KEY, nextRecord);
  }

  /** 主动锁定：销毁内存中的密钥与明文，并广播给其它标签页 */
  lock(): void {
    this.bus.broadcastLock();
    this.wipe();
  }

  private wipe(): void {
    this.dataKey = null;
    this.store = null;
    this.onWipe?.();
  }

  private setUnlocked(dataKey: CryptoKey): void {
    this.dataKey = dataKey;
    this.store = new NoteStore(this.db, dataKey);
  }
}
