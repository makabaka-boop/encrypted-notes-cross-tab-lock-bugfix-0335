import { describe, expect, it, vi } from 'vitest';
import * as cryptoModule from '../src/crypto';
import { AuthError, ConflictError } from '../src/errors';
import { NotesDB } from '../src/db';
import { LocalLockBus } from '../src/lockbus';
import { Session } from '../src/session';
import type { WrappedKeyRecord } from '../src/types';
import { makeSession, makeTabPair, TEST_ITERATIONS } from './helpers';

const META_KEY = 'wrappedDataKey';
const noop = (): void => {};

describe('异步解锁 / 锁定竞争', () => {
  it('解锁尚未完成时锁定：旧解锁结果不能让已锁定页面重新可编辑', async () => {
    const { session } = await makeSession();
    await session.initialize('shared-pass');
    session.lock();

    const unlocking = session.unlock('shared-pass');
    expect(session.unlocked).toBe(false);
    session.lock();

    await expect(unlocking).rejects.toThrow(AuthError);
    expect(session.unlocked).toBe(false);
    expect(() => session.noteStore).toThrow(AuthError);
  });

  it('后发起的解锁会取代尚未完成的旧解锁', async () => {
    const { session } = await makeSession();
    await session.initialize('first-pass');
    session.lock();

    const stale = session.unlock('first-pass');
    const latest = session.unlock('wrong-pass');

    await expect(stale).rejects.toThrow(AuthError);
    await expect(latest).rejects.toThrow(AuthError);
    expect(session.unlocked).toBe(false);
  });
});

describe('锁定与保存竞争', () => {
  it('保存事务进行中锁定：事务被中止，锁定后不会写入修订号或密文', async () => {
    const { db, session } = await makeSession();
    await session.initialize('shared-pass');
    await session.noteStore.create('race-note', 'before');
    const before = await db.getNote('race-note');

    let releaseEncrypt: () => void = () => {};
    const encryptSpy = vi
      .spyOn(cryptoModule, 'encryptNote')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseEncrypt = () => resolve({ iv: new Uint8Array(12), ciphertext: new ArrayBuffer(0) });
          }),
      );

    const saving = session.noteStore.update('race-note', 'after lock', 1);
    await Promise.resolve();
    session.lock();
    releaseEncrypt();

    await expect(saving).rejects.toThrow(AuthError);
    encryptSpy.mockRestore();

    expect(session.unlocked).toBe(false);
    const after = await db.getNote('race-note');
    expect(after?.revision).toBe(1);
    expect(after?.ciphertext).toEqual(before?.ciphertext);
  });

  it('已进入 IndexedDB 的保存在锁定时也会被 abort 回滚', async () => {
    const { db, session } = await makeSession();
    await session.initialize('shared-pass');
    await session.noteStore.create('db-race', 'before');
    const before = await db.getNote('db-race');

    let releasePut: () => void = () => {};
    const updateSpy = vi.spyOn(db, 'updateNote').mockImplementationOnce(
      (() =>
        new Promise<void>((resolve) => {
          releasePut = resolve;
        })) as NotesDB['updateNote'],
    );

    const saving = session.noteStore.update('db-race', 'after lock', 1);
    await waitFor(() => releasePut !== noop);
    session.lock();
    releasePut();

    await expect(saving).rejects.toThrow(AuthError);
    updateSpy.mockRestore();

    const after = await db.getNote('db-race');
    expect(after?.revision).toBe(1);
    expect(after?.ciphertext).toEqual(before?.ciphertext);
  });
});

describe('两个标签页并发改口令', () => {
  it('只有一方的 CAS 写入成功；落败标签页立即锁定，最终只有一个新口令有效', async () => {
    const name = `test-db-passphrase-cas-${Math.random().toString(36).slice(2)}`;
    const a = await makeSession(name);
    const b = await makeSession(name);
    await a.session.initialize('old-pass');
    await b.session.unlock('old-pass');

    let releaseA: () => void = noop;
    let releaseB: () => void = noop;

    const realPutA = NotesDB.prototype.putMeta.bind(a.db);
    vi.spyOn(a.db, 'putMeta').mockImplementationOnce(
      (...args: Parameters<NotesDB['putMeta']>) =>
        new Promise((resolve, reject) => {
          new Promise<void>((resolveGate) => {
            releaseA = resolveGate;
          }).then(() => {
            realPutA(...args).then(resolve, reject);
          });
        }),
    );

    const realPutB = NotesDB.prototype.putMeta.bind(b.db);
    vi.spyOn(b.db, 'putMeta').mockImplementationOnce(
      (...args: Parameters<NotesDB['putMeta']>) =>
        new Promise((resolve, reject) => {
          new Promise<void>((resolveGate) => {
            releaseB = resolveGate;
          }).then(() => {
            realPutB(...args).then(resolve, reject);
          });
        }),
    );

    const changingA = a.session.changePassphrase('old-pass', 'pass-a');
    const changingB = b.session.changePassphrase('old-pass', 'pass-b');
    await waitFor(() => releaseA !== noop && releaseB !== noop);

    releaseA();
    await changingA;
    releaseB();

    await expect(changingB).rejects.toThrow(ConflictError);
    expect(a.session.unlocked).toBe(true);
    expect(b.session.unlocked).toBe(false);
    expect(() => b.session.noteStore).toThrow(AuthError);

    const meta = await a.db.getMeta<WrappedKeyRecord>(META_KEY);
    expect(meta?.keyVersion).toBe(2);
    await expect(canUnlock(a.db, 'pass-a')).resolves.toBe(true);
    await expect(canUnlock(b.db, 'pass-b')).resolves.toBe(false);
    await expect(canUnlock(a.db, 'old-pass')).resolves.toBe(false);
  });

  it('改口令提交成功后，其它标签页立即注销，不会继续显示可编辑状态', async () => {
    const { a, b } = await makeTabPair();
    await a.session.initialize('old-pass');
    await b.session.unlock('old-pass');

    await a.session.changePassphrase('old-pass', 'new-pass');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(a.session.unlocked).toBe(true);
    expect(b.session.unlocked).toBe(false);
    expect(() => b.session.noteStore).toThrow(AuthError);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !predicate(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}

async function canUnlock(db: NotesDB, passphrase: string): Promise<boolean> {
  const session = new Session(db, new LocalLockBus(), { iterations: TEST_ITERATIONS });
  try {
    await session.unlock(passphrase);
    return true;
  } catch (error) {
    if (error instanceof AuthError) return false;
    throw error;
  }
}
