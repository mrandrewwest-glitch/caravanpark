'use strict';

// DynamoDB implementation of the store interface (see state-store.js).
//
// Single table, one item per key:
//   pk (S, hash key)          the full key, e.g. "bookings:lakeside:NB1001"
//   v                         the value (native DynamoDB map)
//   version (N)               incremented on every write (optimistic concurrency)
//   ttl (N, epoch seconds)    DynamoDB TTL attribute. Deletion is LAZY (up to ~48h), so every read
//                             also treats ttl <= now as "missing"
//   gsi1pk/gsi1sk, gsi2pk/gsi2sk (S)  sparse index attributes; present only when the caller asks
//   lock items: pk "lock:<key>" with owner + lease_until (cross-container mutual exclusion)
const crypto = require('crypto');
const { checkSize, MAX_ITEM_BYTES } = require('./state-store');

const INDEX_ATTRS = { gsi1: ['gsi1pk', 'gsi1sk'], gsi2: ['gsi2pk', 'gsi2sk'] };

// The table definition lives here so tests, docs and sam.yaml agree on it.
const TABLE_DEFINITION = (TableName) => ({
  TableName,
  BillingMode: 'PAY_PER_REQUEST',
  AttributeDefinitions: [
    { AttributeName: 'pk', AttributeType: 'S' },
    { AttributeName: 'gsi1pk', AttributeType: 'S' }, { AttributeName: 'gsi1sk', AttributeType: 'S' },
    { AttributeName: 'gsi2pk', AttributeType: 'S' }, { AttributeName: 'gsi2sk', AttributeType: 'S' },
  ],
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  GlobalSecondaryIndexes: ['gsi1', 'gsi2'].map((IndexName) => ({
    IndexName,
    KeySchema: [{ AttributeName: `${IndexName}pk`, KeyType: 'HASH' }, { AttributeName: `${IndexName}sk`, KeyType: 'RANGE' }],
    Projection: { ProjectionType: 'ALL' },
  })),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isConditionFailure = (err) => err && err.name === 'ConditionalCheckFailedException';

class DynamoStore {
  // doc: a DynamoDBDocumentClient (removeUndefinedValues: true). Use DynamoStore.create() normally.
  constructor({ doc, commands, table, now = Date.now, maxItemBytes = MAX_ITEM_BYTES, logger = null }) {
    this.doc = doc;
    this.cmd = commands;
    this.table = table;
    this.now = now;
    this.maxItemBytes = maxItemBytes;
    this.logger = logger;
  }

  static create({ table, region = process.env.AWS_REGION || 'ap-southeast-2', endpoint, credentials, now, logger } = {}) {
    if (!table) throw new Error('DynamoStore requires a table name (DYNAMODB_TABLE)');
    const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
    const lib = require('@aws-sdk/lib-dynamodb');
    const client = new DynamoDBClient({ region, ...(endpoint ? { endpoint } : {}), ...(credentials ? { credentials } : {}) });
    const doc = lib.DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
    const store = new DynamoStore({ doc, commands: lib, table, now, logger });
    store.rawClient = client;
    return store;
  }

  get nowSec() { return Math.floor(this.now() / 1000); }

  _isExpired(item) { return item.ttl !== undefined && item.ttl <= this.nowSec; }

  // Builds the UpdateItem pieces shared by set() and update().
  _writeParts(opts = {}) {
    const names = { '#v': 'v', '#ver': 'version', '#ttl': 'ttl' };
    const values = { ':one': 1 };
    const sets = ['#v = :v'];
    const removes = [];
    if (opts.ttlSeconds) { sets.push('#ttl = :ttl'); values[':ttl'] = Math.ceil((this.now() + opts.ttlSeconds * 1000) / 1000); } else removes.push('#ttl');
    for (const [name, [pkAttr, skAttr]] of Object.entries(INDEX_ATTRS)) {
      const ix = opts.index && opts.index[name];
      if (ix) {
        names[`#${pkAttr}`] = pkAttr; names[`#${skAttr}`] = skAttr;
        sets.push(`#${pkAttr} = :${pkAttr}`, `#${skAttr} = :${skAttr}`);
        values[`:${pkAttr}`] = String(ix.pk); values[`:${skAttr}`] = String(ix.sk);
      } else {
        names[`#${pkAttr}`] = pkAttr; names[`#${skAttr}`] = skAttr;
        removes.push(`#${pkAttr}`, `#${skAttr}`); // keeps the index sparse as status changes
      }
    }
    return { names, values, expr: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''} ADD #ver :one` };
  }

  async get(key) {
    const res = await this.doc.send(new this.cmd.GetCommand({ TableName: this.table, Key: { pk: key }, ConsistentRead: true }));
    return res.Item && !this._isExpired(res.Item) ? res.Item.v : null;
  }

  async set(key, value, opts = {}) {
    checkSize(key, value, this.maxItemBytes);
    const { names, values, expr } = this._writeParts(opts);
    await this.doc.send(new this.cmd.UpdateCommand({
      TableName: this.table, Key: { pk: key }, UpdateExpression: expr,
      ExpressionAttributeNames: names, ExpressionAttributeValues: { ...values, ':v': value },
    }));
  }

  async putIfAbsent(key, value, opts = {}) {
    checkSize(key, value, this.maxItemBytes);
    const item = { pk: key, v: value, version: 1 };
    if (opts.ttlSeconds) item.ttl = Math.ceil((this.now() + opts.ttlSeconds * 1000) / 1000);
    for (const [name, [pkAttr, skAttr]] of Object.entries(INDEX_ATTRS)) {
      const ix = opts.index && opts.index[name];
      if (ix) { item[pkAttr] = String(ix.pk); item[skAttr] = String(ix.sk); }
    }
    try {
      await this.doc.send(new this.cmd.PutCommand({
        TableName: this.table, Item: item,
        ConditionExpression: 'attribute_not_exists(pk) OR (attribute_exists(#ttl) AND #ttl <= :now)',
        ExpressionAttributeNames: { '#ttl': 'ttl' }, ExpressionAttributeValues: { ':now': this.nowSec },
      }));
      return true;
    } catch (err) {
      if (isConditionFailure(err)) return false;
      throw err;
    }
  }

  // Optimistic concurrency: read (consistent) -> fn -> conditional write on the version we read.
  async update(key, fn, opts, { retries = 12 } = {}) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const res = await this.doc.send(new this.cmd.GetCommand({ TableName: this.table, Key: { pk: key }, ConsistentRead: true }));
      const existing = res.Item || null;
      const current = existing && !this._isExpired(existing) ? existing.v : null;
      const next = fn(current === null ? null : structuredClone(current));
      if (next === undefined) return current;
      checkSize(key, next, this.maxItemBytes);
      const { names, values, expr } = this._writeParts(typeof opts === 'function' ? opts(next) : opts);
      try {
        await this.doc.send(new this.cmd.UpdateCommand({
          TableName: this.table, Key: { pk: key }, UpdateExpression: expr,
          ConditionExpression: existing ? '#ver = :cur' : 'attribute_not_exists(pk)',
          ExpressionAttributeNames: names, ExpressionAttributeValues: { ...values, ':v': next, ...(existing ? { ':cur': existing.version } : {}) },
        }));
        return next;
      } catch (err) {
        if (!isConditionFailure(err)) throw err;
        await sleep(5 + Math.random() * 25 * (attempt + 1)); // lost the race: back off and re-read
      }
    }
    const err = new Error(`Too much contention updating ${key}`);
    err.code = 'CONTENTION';
    throw err;
  }

  async delete(key) {
    await this.doc.send(new this.cmd.DeleteCommand({ TableName: this.table, Key: { pk: key } }));
  }

  async _paged(buildInput, limit) {
    const out = [];
    let startKey;
    do {
      const res = await this.doc.send(buildInput(startKey));
      for (const item of res.Items || []) if (!this._isExpired(item)) out.push(item);
      startKey = res.LastEvaluatedKey;
    } while (startKey && (!limit || out.length < limit));
    return limit ? out.slice(0, limit) : out;
  }

  // GSI reads are eventually consistent: callers must re-read the record (get) before acting on it.
  async query(index, pk, { skMin, skMax, limit } = {}) {
    const [pkAttr, skAttr] = INDEX_ATTRS[index] || [];
    if (!pkAttr) throw new Error(`Unknown index ${index}`);
    const names = { '#pk': pkAttr };
    const values = { ':pk': String(pk) };
    let cond = '#pk = :pk';
    if (skMin !== undefined && skMax !== undefined) { names['#sk'] = skAttr; values[':min'] = String(skMin); values[':max'] = String(skMax); cond += ' AND #sk BETWEEN :min AND :max'; }
    else if (skMin !== undefined) { names['#sk'] = skAttr; values[':min'] = String(skMin); cond += ' AND #sk >= :min'; }
    else if (skMax !== undefined) { names['#sk'] = skAttr; values[':max'] = String(skMax); cond += ' AND #sk <= :max'; }
    const items = await this._paged((ExclusiveStartKey) => new this.cmd.QueryCommand({
      TableName: this.table, IndexName: index, KeyConditionExpression: cond, ExpressionAttributeNames: names, ExpressionAttributeValues: values, ExclusiveStartKey,
    }), limit);
    return items.map((i) => i.v);
  }

  // Full table scan. Tests and dev tooling only; production code paths must use get/query.
  async list(prefix) {
    const items = await this._paged((ExclusiveStartKey) => new this.cmd.ScanCommand({
      TableName: this.table, FilterExpression: 'begins_with(pk, :p)', ExpressionAttributeValues: { ':p': prefix }, ExclusiveStartKey,
    }));
    return items.map((i) => i.v);
  }

  // Lease-based lock: safe across Lambda containers. A holder that dies simply lets the lease lapse.
  // Limitation: a holder that stalls longer than the lease can overlap with the next holder, so
  // critical work must also be idempotent (status checks); leaseMs is generous for that reason.
  async withLock(key, fn, { leaseMs = 30000, waitMs = 15000 } = {}) {
    const lockKey = `lock:${key}`;
    const owner = crypto.randomUUID();
    const began = Date.now(); // real time for the wait loop; this.now() for lease arithmetic
    for (;;) {
      const nowMs = this.now();
      try {
        await this.doc.send(new this.cmd.PutCommand({
          TableName: this.table,
          Item: { pk: lockKey, owner, lease_until: nowMs + leaseMs, ttl: Math.ceil((nowMs + leaseMs) / 1000) + 3600 },
          ConditionExpression: 'attribute_not_exists(pk) OR #lease < :now',
          ExpressionAttributeNames: { '#lease': 'lease_until' },
          ExpressionAttributeValues: { ':now': nowMs },
        }));
        break;
      } catch (err) {
        if (!isConditionFailure(err)) throw err;
        if (Date.now() - began > waitMs) { const e = new Error(`Timed out waiting for lock ${key}`); e.code = 'LOCK_TIMEOUT'; throw e; }
        await sleep(15 + Math.random() * 45);
      }
    }
    try {
      return await fn();
    } finally {
      try {
        await this.doc.send(new this.cmd.DeleteCommand({
          TableName: this.table, Key: { pk: lockKey }, ConditionExpression: '#owner = :o',
          ExpressionAttributeNames: { '#owner': 'owner' }, // OWNER is a DynamoDB reserved word
          ExpressionAttributeValues: { ':o': owner },
        }));
      } catch (err) {
        if (!isConditionFailure(err)) {
          // A lock that can't be released blocks everyone until the lease lapses: make it loud.
          if (this.logger) this.logger.error('lock_release_failed', { key, error: err.message });
          else console.error(`lock_release_failed ${key}: ${err.message}`);
        }
      }
    }
  }
}

module.exports = { DynamoStore, TABLE_DEFINITION, INDEX_ATTRS };
