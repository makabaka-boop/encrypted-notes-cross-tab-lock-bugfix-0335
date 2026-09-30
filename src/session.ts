import {
  deriveKek,
  generateDataKey,
  KDF_ITERATIONS,
  randomBytes,
  unwrapDataKey,
  wrapDataKey,
} from './crypto';
import type { NotesDB } from './db';
import { AuthError, ConflictError } from './errors';
import type { LockBus, LockBusMessage } from './lockbus';
import type { SessionOperation } from './guard';
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
 * - generation 是当前标签页内的会话代次：新解锁会取代旧解锁，锁定/收到跨页
 *   状态事件会注销当前会话；旧异步流程的返回值不能再次 setUnlocked；
 * - 每个 NoteStore 操作都绑定 AbortController，锁定时立即中止尚未提交的
 *   IndexedDB 事务，避免“锁定前发起的保存”在锁定后落盘；
 * - 改口令用 keyVersion 做单事务 compare-and-set；并发改口令只有一方成功，
 *   成功后广播注销其它仍拿着旧状态的标签页。
 */
export class Session {
  private dataKey: CryptoKey | null = null;
  private store: NoteStore | null = null;
  private readonly iterations: number;
  private generation = 0;
  private readonly activeOperations = new Set<AbortController>();
  private changingPassphrase = false;

  /** 锁定（含其它标签页广播导致的锁定）后回调，UI 用它立即清空明文 */
  onWipe: (() => void) | null = null;

  constructor(
    private readonly db: NotesDB,
    private readonly bus: LockBus,
    options: SessionOptions = {},
  ) {
    this.iterations = options.iterations ?? KDF_ITERATIONS;
    this.bus.onMessage((message) => this.handleBusMessage(message));
  }

  get unlocked(): boolean {
    return this.store !== null;
  }

  /** 已解锁时返回业务层；锁定状态调用即抛错 */
  get noteStore(): NoteStore {
    if (this.store === null) throw new AuthError('工作台已锁定');
    return this.store;
  }

  async isInitialized(signal?: AbortSignal): Promise<boolean> {
    return (await this.db.getMeta<WrappedKeyRecord>(META_WRAPPED_KEY, signal)) !== undefined;
  }

  /** 首次使用：生成随机数据密钥，用口令派生的 KEK 封装后落盘 */
  async initialize(passphrase: string): Promise<void> {
    const { generation, operation } = this.beginAuthAttempt();
    try {
      operation.assertActive();
      if (await this.isInitialized(operation.signal)) {
        throw new AuthError('工作台已初始化，请直接解锁');
      }
      operation.assertActive();

      const dataKey = await generateDataKey();
      const salt = randomBytes(16);
      const kek = await deriveKek(passphrase, salt, this.iterations);
      const { wrapIv, wrappedKey } = await wrapDataKey(dataKey, kek);
      const record: WrappedKeyRecord = {
        keyVersion: 1,
        kdf: { salt, iterations: this.iterations },
        wrapIv,
        wrappedKey,
      };
      await this.db.putMeta(META_WRAPPED_KEY, record, undefined, operation.signal);
      operation.assertActive();
      this.setUnlocked(dataKey, generation);
    } catch (error) {
      throw this.mapAuthFailure(operation, error);
    } finally {
      this.endOperation(operation);
    }
  }

  /** 解锁：口令错误抛 AuthError，且不会改动任何已存数据 */
  async unlock(passphrase: string): Promise<void> {
    const { generation, operation } = this.beginAuthAttempt();
    try {
      const record = await this.db.getMeta<WrappedKeyRecord>(
        META_WRAPPED_KEY,
        operation.signal,
      );
      operation.assertActive();
      if (record === undefined) throw new AuthError('工作台尚未初始化');

      const kek = await deriveKek(passphrase, record.kdf.salt, record.kdf.iterations);
      let dataKey: CryptoKey;
      try {
        dataKey = await unwrapDataKey(record.wrappedKey, record.wrapIv, kek);
      } catch (error) {
        if (operation.signal.aborted) throw this.mapAuthFailure(operation, error);
        throw new AuthError();
      }
      operation.assertActive();
      this.setUnlocked(dataKey, generation);
    } catch (error) {
      throw this.mapAuthFailure(operation, error);
    } finally {
      this.endOperation(operation);
    }
  }

  /**
   * 改口令：先验证当前口令，再用新盐派生 KEK 重新封装同一数据密钥。
   * keyVersion 的读取与写入在同一个 IndexedDB 事务中完成；并发时只有一方
   * 可提交，另一方得到冲突并注销旧会话。成功后通知其它标签页注销。
   */
  async changePassphrase(current: string, next: string): Promise<void> {
    if (this.dataKey === null) throw new AuthError('工作台已锁定');
    if (this.changingPassphrase) {
      throw new AuthError('口令修改正在进行，请稍候');
    }
    this.changingPassphrase = true;
    const operation = this.beginUnlockedOperation();
    try {
      const record = await this.db.getMeta<WrappedKeyRecord>(
        META_WRAPPED_KEY,
        operation.signal,
      );
      operation.assertActive();
      if (record === undefined) throw new AuthError('工作台尚未初始化');

      const oldKek = await deriveKek(current, record.kdf.salt, record.kdf.iterations);
      try {
        await unwrapDataKey(record.wrappedKey, record.wrapIv, oldKek);
      } catch (error) {
        if (operation.signal.aborted) throw this.mapAuthFailure(operation, error);
        throw new AuthError('当前口令错误');
      }

      const salt = randomBytes(16);
      const newKek = await deriveKek(next, salt, this.iterations);
      const { wrapIv, wrappedKey } = await wrapDataKey(this.dataKey, newKek);
      const expectedVersion = record.keyVersion ?? 0;
      const nextRecord: WrappedKeyRecord = {
        keyVersion: expectedVersion + 1,
        kdf: { salt, iterations: this.iterations },
        wrapIv,
        wrappedKey,
      };
      await this.db.putMeta(
        META_WRAPPED_KEY,
        nextRecord,
        expectedVersion,
        operation.signal,
      );
      operation.assertActive();
      this.bus.broadcastPassphraseChanged();
    } catch (error) {
      const conflict =
        error instanceof ConflictError ||
        (error instanceof Error && error.name === 'ConflictError');
      if (conflict) {
        // 并发改口令落败：本标签页持有的会话状态已过期，立即本地注销。
        this.wipe('passphrase-changed');
        throw error;
      }
      throw this.mapAuthFailure(operation, error);
    } finally {
      this.changingPassphrase = false;
      this.endOperation(operation);
    }
  }

  /** 主动锁定：销毁内存中的密钥与明文，并广播给其它标签页 */
  lock(): void {
    this.bus.broadcastLock();
    this.wipe('lock');
  }

  private handleBusMessage(message: LockBusMessage): void {
    if (message.type === 'lock' || message.type === 'passphrase-changed') {
      this.wipe(message.type);
    }
  }

  private wipe(reason: 'lock' | 'passphrase-changed' | 'auth-replaced' = 'lock'): void {
    this.generation += 1;
    this.changingPassphrase = false;
    for (const controller of [...this.activeOperations]) {
      controller.abort(reason);
    }
    this.activeOperations.clear();
    this.dataKey = null;
    this.store = null;
    this.onWipe?.();
  }

  private beginAuthAttempt(): { generation: number; operation: SessionOperation } {
    // 新的解锁/初始化尝试必须取代尚未返回的旧尝试，旧尝试完成后不得重新上屏。
    this.wipe('auth-replaced');
    return { generation: this.generation, operation: this.createOperation() };
  }

  private beginUnlockedOperation(): SessionOperation {
    if (this.store === null) throw new AuthError('工作台已锁定');
    return this.createOperation();
  }

  private createOperation(): SessionOperation {
    const generation = this.generation;
    const controller = new AbortController();
    this.activeOperations.add(controller);
    return {
      signal: controller.signal,
      assertActive: () => {
        if (controller.signal.aborted || this.generation !== generation) {
          if (!controller.signal.aborted) controller.abort('stale-generation');
          throw new AuthError('工作台已锁定');
        }
      },
      end: () => {
        this.activeOperations.delete(controller);
      },
    };
  }

  private endOperation(operation: SessionOperation): void {
    operation.end();
  }

  private setUnlocked(dataKey: CryptoKey, generation: number): void {
    if (generation !== this.generation) return;
    this.dataKey = dataKey;
    this.store = new NoteStore(this.db, dataKey, () => this.createOperation());
  }

  private mapAuthFailure(operation: SessionOperation, error: unknown): unknown {
    const isConflict =
      error instanceof ConflictError ||
      (error instanceof Error && error.name === 'ConflictError');
    if (operation.signal.aborted && !isConflict) {
      return new AuthError('工作台已锁定');
    }
    return error;
  }
}
