import type { EvidenceRecord, TaskCheckpoint, TaskRun, TaskRunEvent } from './types';

const DB_NAME = 'sft-ai-task-runs';
const DB_VERSION = 2;

export interface TaskRunDatabase {
  runs: TaskRun;
  events: TaskRunEvent;
  checkpoints: TaskCheckpoint;
  evidence: EvidenceRecord;
}

export function openTaskRunDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable in this environment'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error('Failed to open task database'));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('runs')) {
        const store = db.createObjectStore('runs', { keyPath: 'id' });
        store.createIndex('status', 'status', { unique: false });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('events')) {
        const store = db.createObjectStore('events', { keyPath: ['runId', 'sequence'] });
        store.createIndex('runId', 'runId', { unique: false });
      }
      if (!db.objectStoreNames.contains('checkpoints')) {
        db.createObjectStore('checkpoints', { keyPath: 'runId' });
      }
      if (!db.objectStoreNames.contains('evidence')) {
        const store = db.createObjectStore('evidence', { keyPath: 'id' });
        store.createIndex('runId', 'runId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

export async function withTaskRunTransaction<T>(
  stores: Array<keyof TaskRunDatabase>,
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await openTaskRunDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores as string[], mode);
    let value: T | undefined;
    Promise.resolve(fn(tx))
      .then(result => {
        value = result;
      })
      .catch(reject);
    tx.onerror = () => reject(tx.error ?? new Error('Task transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('Task transaction aborted'));
    tx.oncomplete = () => {
      db.close();
      if (value === undefined) {
        reject(new Error('Task transaction completed without a result'));
      } else {
        resolve(value);
      }
    };
  });
}
