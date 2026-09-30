import { decryptNote, encryptNote } from './crypto';
import type { NotesDB } from './db';
import { AuthError, IntegrityError, NotFoundError } from './errors';
import type { SessionOperation, SessionOperationFactory } from './guard';
import type { NoteMeta, NoteRecord } from './types';

/** 便笺数量硬上限 */
export const MAX_NOTES = 100;

export interface NoteContent {
  plaintext: string;
  revision: number;
}

function toAuthError(error: unknown): AuthError {
  if (error instanceof AuthError) return error;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new AuthError('工作台已锁定');
  }
  return new AuthError(error instanceof Error ? error.message : String(error));
}

/**
 * 业务层：加解密 + 容量/修订号约束。
 *
 * 每次调用都从 Session 获取一次性栅栏：锁定或口令更换会 abort 尚未完成的
 * IndexedDB 事务，异步回调也不能用旧会话继续读取或写入。
 */
export class NoteStore {
  private readonly beginOperation: SessionOperationFactory;

  constructor(
    private readonly db: NotesDB,
    private readonly dataKey: CryptoKey,
    beginOperation?: SessionOperationFactory,
  ) {
    this.beginOperation =
      beginOperation ??
      (() => {
        const controller = new AbortController();
        const operation: SessionOperation = {
          signal: controller.signal,
          assertActive() {},
          end() {
            controller.abort();
          },
        };
        return operation;
      });
  }

  private async run<T>(work: (operation: SessionOperation) => Promise<T>): Promise<T> {
    const operation = this.beginOperation();
    try {
      return await work(operation);
    } catch (error) {
      if (operation.signal.aborted) throw toAuthError(error);
      throw error;
    } finally {
      operation.end();
    }
  }

  /** 列表只返回元信息，不触碰明文 */
  async list(): Promise<NoteMeta[]> {
    return this.run(async (operation) => {
      operation.assertActive();
      const records = await this.db.listNotes(operation.signal);
      operation.assertActive();
      return records
        .map(({ id, revision, updatedAt }) => ({ id, revision, updatedAt }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    });
  }

  async count(): Promise<number> {
    return this.run(async (operation) => {
      operation.assertActive();
      return this.db.countNotes(operation.signal);
    });
  }

  async read(id: string): Promise<NoteContent> {
    return this.run(async (operation) => {
      operation.assertActive();
      const record = await this.db.getNote(id, operation.signal);
      operation.assertActive();
      if (record === undefined) throw new NotFoundError(id);
      try {
        const plaintext = await decryptNote(
          this.dataKey,
          record.iv,
          record.ciphertext,
        );
        operation.assertActive();
        return { plaintext, revision: record.revision };
      } catch (error) {
        if (operation.signal.aborted) throw toAuthError(error);
        throw new IntegrityError(`便笺「${record.id}」解密失败：密文可能被篡改`);
      }
    });
  }

  /** 解密并校验完整性；篡改会抛 IntegrityError */
  async decrypt(record: NoteRecord): Promise<string> {
    return this.run(async (operation) => {
      operation.assertActive();
      try {
        const plaintext = await decryptNote(
          this.dataKey,
          record.iv,
          record.ciphertext,
        );
        operation.assertActive();
        return plaintext;
      } catch (error) {
        if (operation.signal.aborted) throw toAuthError(error);
        throw new IntegrityError(`便笺「${record.id}」解密失败：密文可能被篡改`);
      }
    });
  }

  async create(id: string, plaintext: string): Promise<NoteMeta> {
    return this.run(async (operation) => {
      operation.assertActive();
      const { iv, ciphertext } = await encryptNote(this.dataKey, plaintext);
      operation.assertActive();
      const record: NoteRecord = {
        id,
        iv,
        ciphertext,
        revision: 1,
        updatedAt: Date.now(),
      };
      await this.db.createNote(record, MAX_NOTES, operation.signal);
      operation.assertActive();
      return { id, revision: record.revision, updatedAt: record.updatedAt };
    });
  }

  /**
   * 更新便笺：调用方必须给出自己读到的修订号。
   * 若其它标签页已先写入，事务内校验失败并抛 ConflictError，
   * 先写的内容不会被覆盖。
   */
  async update(id: string, plaintext: string, expectedRevision: number): Promise<NoteMeta> {
    return this.run(async (operation) => {
      operation.assertActive();
      const { iv, ciphertext } = await encryptNote(this.dataKey, plaintext);
      operation.assertActive();
      const record: NoteRecord = {
        id,
        iv,
        ciphertext,
        revision: expectedRevision + 1,
        updatedAt: Date.now(),
      };
      await this.db.updateNote(record, expectedRevision, operation.signal);
      operation.assertActive();
      return { id, revision: record.revision, updatedAt: record.updatedAt };
    });
  }

  async remove(id: string): Promise<void> {
    return this.run(async (operation) => {
      operation.assertActive();
      await this.db.deleteNote(id, operation.signal);
      operation.assertActive();
    });
  }
}
