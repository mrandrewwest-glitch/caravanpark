'use strict';

// Store interface used everywhere (values are plain JSON-able objects):
//
//   get(key)                         -> value | null            (strongly consistent)
//   set(key, value, opts)            -> void                    unconditional write
//   putIfAbsent(key, value, opts)    -> boolean                 atomic "claim"; false if the key is live
//   update(key, fn, opts)            -> value                   optimistic read-modify-write; fn(current|null)
//                                                               is SYNC and may be retried; return undefined to skip
//   delete(key)
//   query(index, pk, {skMin,skMax,limit}) -> values, ascending by sort key   (eventually consistent in DynamoDB)
//   list(prefix)                     -> values                  full scan: tests/dev only, never on a hot path
//   withLock(key, fn, {leaseMs,waitMs}) -> fn()                 mutual exclusion across processes (lease based)
//
// opts: { ttlSeconds?: number  (omit = never expires),
//         index?: { gsi1?: {pk, sk}, gsi2?: {pk, sk} }  (omit an index = the item is not in it: "sparse") }
// For update(), opts may be a function of the NEW value, so indexes follow the data.
//
// MemoryStore (this file) is for local runs and tests. DynamoStore (dynamo-store.js) is production.
const { withLock } = require('./util');

const MAX_ITEM_BYTES = 350 * 1024; // DynamoDB's hard limit is 400 KB including attribute names

function checkSize(key, value, max = MAX_ITEM_BYTES) {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > max) {
    const err = new Error(`Item too large (${bytes} bytes) for key ${key}`);
    err.code = 'ITEM_TOO_LARGE';
    throw err;
  }
}

class MemoryStore {
  constructor({ now = Date.now, maxItemBytes = MAX_ITEM_BYTES } = {}) {
    this.now = now;
    this.maxItemBytes = maxItemBytes;
    this.map = new Map();
  }

  _live(key) {
    const e = this.map.get(key);
    if (!e) return null;
    if (e.expiresMs !== null && e.expiresMs <= this.now()) { this.map.delete(key); return null; }
    return e;
  }

  _write(key, value, opts = {}) {
    checkSize(key, value, this.maxItemBytes);
    const prev = this.map.get(key);
    this.map.set(key, {
      value: JSON.parse(JSON.stringify(value)), // the persisted shape: undefined dropped, like a real database
      expiresMs: opts.ttlSeconds ? this.now() + opts.ttlSeconds * 1000 : null,
      index: opts.index ? structuredClone(opts.index) : {},
      version: (prev ? prev.version : 0) + 1,
    });
  }

  async get(key) {
    const e = this._live(key);
    return e ? structuredClone(e.value) : null;
  }

  async set(key, value, opts) { this._write(key, value, opts); }

  async putIfAbsent(key, value, opts) {
    if (this._live(key)) return false;
    this._write(key, value, opts);
    return true;
  }

  async update(key, fn, opts) {
    const e = this._live(key);
    const next = fn(e ? structuredClone(e.value) : null);
    if (next === undefined) return e ? structuredClone(e.value) : null;
    this._write(key, next, typeof opts === 'function' ? opts(next) : opts);
    return structuredClone(next);
  }

  async delete(key) { this.map.delete(key); }

  async query(index, pk, { skMin, skMax, limit } = {}) {
    const rows = [];
    for (const key of [...this.map.keys()]) {
      const e = this._live(key);
      const ix = e && e.index[index];
      if (!ix || ix.pk !== pk) continue;
      if (skMin !== undefined && ix.sk < skMin) continue;
      if (skMax !== undefined && ix.sk > skMax) continue;
      rows.push({ sk: ix.sk, value: e.value });
    }
    rows.sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0));
    return rows.slice(0, limit || rows.length).map((r) => structuredClone(r.value));
  }

  async list(prefix) {
    const out = [];
    for (const key of [...this.map.keys()]) if (key.startsWith(prefix) && this._live(key)) out.push(structuredClone(this.map.get(key).value));
    return out;
  }

  // In-process only; DynamoStore.withLock is the cross-container version.
  async withLock(key, fn) { return withLock(`store:${key}`, fn); }
}

module.exports = { MemoryStore, checkSize, MAX_ITEM_BYTES };
