'use strict';

// Async interface so a DynamoDB (or Redis) implementation can replace this
// without touching conversation logic. Lambda containers do NOT share memory,
// so the in-memory store is only safe for local runs / a single container.
// DynamoDB sketch: table keyed on call_sid, TTL attribute ~1h, get/set/delete
// map to GetItem/PutItem/DeleteItem.
class MemoryStore {
  constructor({ ttlMs = 7 * 24 * 60 * 60 * 1000, maxEntries = 50000 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.map = new Map();
  }

  async get(callSid) {
    const entry = this.map.get(callSid);
    if (!entry) return null;
    if (entry.expires < Date.now()) {
      this.map.delete(callSid);
      return null;
    }
    return structuredClone(entry.value);
  }

  async set(callSid, value) {
    this.map.set(callSid, { value: structuredClone(value), expires: Date.now() + this.ttlMs });
    if (this.map.size > this.maxEntries) this.evict();
  }

  // Values whose key starts with prefix (e.g. all held bookings for the expiry job).
  // DynamoDB: a GSI on (status, hold_expires_at) instead of a scan.
  async list(prefix) {
    const now = Date.now();
    const out = [];
    for (const [k, v] of this.map) if (k.startsWith(prefix) && v.expires >= now) out.push(structuredClone(v.value));
    return out;
  }

  async delete(callSid) {
    this.map.delete(callSid);
  }

  evict() {
    const now = Date.now();
    for (const [k, v] of this.map) if (v.expires < now) this.map.delete(k);
    // Still over the cap: drop oldest insertions.
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value);
  }
}

module.exports = { MemoryStore };
