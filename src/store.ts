import { decryptNote, encryptNote } from './crypto';
import type { NotesDB } from './db';
import { IntegrityError, NotFoundError } from './errors';
import type { NoteMeta, NoteRecord } from './types';

/** 便笺数量硬上限 */
export const MAX_NOTES = 100;

export interface NoteContent {
  plaintext: string;
  revision: number;
}

/**
 * 业务层：加解密 + 容量/修订号约束。
 * 只在解锁后的会话内存中持有数据密钥，锁定即销毁本对象。
 */
export class NoteStore {
  constructor(
    private readonly db: NotesDB,
    private readonly dataKey: CryptoKey,
  ) {}

  /** 列表只返回元信息，不触碰明文 */
  async list(): Promise<NoteMeta[]> {
    const records = await this.db.listNotes();
    return records
      .map(({ id, revision, updatedAt }) => ({ id, revision, updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async count(): Promise<number> {
    return this.db.countNotes();
  }

  async read(id: string): Promise<NoteContent> {
    const record = await this.db.getNote(id);
    if (record === undefined) throw new NotFoundError(id);
    return { plaintext: await this.decrypt(record), revision: record.revision };
  }

  /** 解密并校验完整性；篡改会抛 IntegrityError */
  async decrypt(record: NoteRecord): Promise<string> {
    try {
      return await decryptNote(this.dataKey, record.iv, record.ciphertext);
    } catch {
      throw new IntegrityError(`便笺「${record.id}」解密失败：密文可能被篡改`);
    }
  }

  async create(id: string, plaintext: string): Promise<NoteMeta> {
    const { iv, ciphertext } = await encryptNote(this.dataKey, plaintext);
    const record: NoteRecord = { id, iv, ciphertext, revision: 1, updatedAt: Date.now() };
    await this.db.createNote(record, MAX_NOTES);
    return { id, revision: record.revision, updatedAt: record.updatedAt };
  }

  /**
   * 更新便笺：调用方必须给出自己读到的修订号。
   * 若其它标签页已先写入，事务内校验失败并抛 ConflictError，
   * 先写的内容不会被覆盖。
   */
  async update(id: string, plaintext: string, expectedRevision: number): Promise<NoteMeta> {
    const { iv, ciphertext } = await encryptNote(this.dataKey, plaintext);
    const record: NoteRecord = {
      id,
      iv,
      ciphertext,
      revision: expectedRevision + 1,
      updatedAt: Date.now(),
    };
    await this.db.updateNote(record, expectedRevision);
    return { id, revision: record.revision, updatedAt: record.updatedAt };
  }

  async remove(id: string): Promise<void> {
    await this.db.deleteNote(id);
  }
}
