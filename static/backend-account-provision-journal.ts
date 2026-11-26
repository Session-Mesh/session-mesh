// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

type Entry = {id: string; value: string};
export type ProvisionJournal = {
  load(): Promise<Entry | null>;
  // A single readwrite transaction checks for all pending entries and inserts
  // the intent. Concurrent tabs cannot both acquire the same empty journal.
  acquire(): Promise<{entry: Entry; acquired: boolean}>;
  save(id: string, value: string | null): Promise<void>;
  clearUncertain?(id: string): Promise<'cleared' | 'missing' | 'mismatch'>;
};

export function provisionJournal(storage: Storage, indexedDB: IDBFactory, random: Crypto): ProvisionJournal {
  const legacy = 'mesh.backendAccounts.provision.v1';
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('mesh.backendAccounts.provision.v2', 1);
    let abandoned = false;
    request.onupgradeneeded = () => request.result.createObjectStore('entries', {keyPath: 'id'});
    request.onsuccess = () => { if (abandoned) request.result.close(); else resolve(request.result); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { abandoned = true; reject(new Error('provision-journal-unavailable')); };
  });
  function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, done: (value: T) => void) => void): Promise<T> {
    return open().then(db => new Promise<T>((resolve, reject) => {
      const tx = db.transaction('entries', mode), store = tx.objectStore('entries');
      let result: T;
      try { run(store, value => { result = value; }); }
      catch (error) { db.close(); reject(error); return; }
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new Error('provision-journal-transaction-failed')); };
    }));
  }
  return {
    async clearUncertain(id) {
      if (!/^[a-f0-9]{32}$/.test(id)) return 'mismatch' as const;
      let result: 'cleared' | 'missing' | 'mismatch' = 'mismatch';
      await transact('readwrite', (store, done) => {
        const request = store.get(id);
        request.onsuccess = () => {
          if (request.result === undefined) result = 'missing';
          else if (request.result.id === id && request.result.value === 'uncertain') { store.delete(id); result = 'cleared'; }
          done(undefined);
        };
      });
      return result;
    },
    async load() {
      const old = storage.getItem(legacy);
      if (old !== null) return {id: legacy, value: old};
      return transact('readonly', (store, done) => {
        const cursor = store.openCursor();
        cursor.onsuccess = () => done(cursor.result?.value ?? null);
      });
    },
    async acquire() {
      const old = storage.getItem(legacy);
      if (old !== null) return {entry: {id: legacy, value: old}, acquired: false};
      const bytes = random.getRandomValues(new Uint8Array(16));
      const id = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
      return transact('readwrite', (store, done) => {
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          if (cursor.result) done({entry: cursor.result.value, acquired: false});
          else {
            const entry = {id, value: 'uncertain'};
            store.add(entry); // collision aborts; never replace an existing intent.
            done({entry, acquired: true});
          }
        };
      });
    },
    async save(id, value) {
      if (id === legacy) {
        if (value === null) storage.removeItem(legacy);
        else storage.setItem(legacy, value);
        return;
      }
      if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('invalid-provision-journal-id');
      return transact('readwrite', (store, done) => {
        if (value === null) store.delete(id);
        else store.put({id, value});
        done(undefined);
      });
    },
  };
}

/** One durable, compare-and-set acknowledgement shared by all tabs. */
export function provisionRecoveryJournal(indexedDB: IDBFactory) {
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('mesh.backendAccounts.recovery.v1', 1);
    let abandoned = false;
    request.onupgradeneeded = () => request.result.createObjectStore('entries');
    request.onsuccess = () => { if (abandoned) request.result.close(); else resolve(request.result); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { abandoned = true; reject(new Error('recovery-journal-unavailable')); };
  });
  const transaction = async (mode: IDBTransactionMode, f: (store: IDBObjectStore, done: (value: string | null) => void) => void) => {
    const db = await open();
    return new Promise<string | null>((resolve, reject) => {
      const tx = db.transaction('entries', mode), store = tx.objectStore('entries');
      let value: string | null = null;
      try { f(store, result => { value = result; }); } catch (error) { tx.abort(); db.close(); reject(error); return; }
      tx.oncomplete = () => { db.close(); resolve(value); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error ?? new Error('recovery-journal-failed')); };
    });
  };
  return {
    load: () => transaction('readonly', (store, done) => { const req = store.get('proof'); req.onsuccess = () => done(req.result ?? null); }),
    claim: (proof: string) => transaction('readwrite', (store, done) => {
      const req = store.get('proof'); req.onsuccess = () => {
        if (req.result !== undefined && req.result !== proof) { done(req.result); return; }
        store.put(proof, 'proof'); done(proof);
      };
    }),
    clear: (proof: string) => transaction('readwrite', (store, done) => {
      const req = store.get('proof'); req.onsuccess = () => {
        if (req.result === proof) { store.delete('proof'); done(null); } else done(req.result ?? null);
      };
    }),
  };
}
