'use strict';

// Store contract tests. The SAME behavioural suite runs against MemoryStore and DynamoStore
// (dynalite), plus DynamoDB-specific concurrency/multi-container tests. Usage: node tests-store.js
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
const { MemoryStore } = require('./state-store');
const { newDynamoStore, stopDynamo } = require('./test-dynamo');
const { makeChecker, makeClock } = require('./test-helpers');
const repos = require('./repos');
const fs = require('fs');
const { TABLE_DEFINITION } = require('./dynamo-store');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ids = (rows) => rows.map((r) => r.id);

// Behaviour every store must have. make({now}) returns a fresh, empty store.
async function contract(label, make, { check }) {
  const clock = makeClock();
  const now = () => clock.t;
  const s = await make({ now });
  const c = (name, ok) => check(`[${label}] ${name}`, ok);

  await s.set('k1', { a: 1, nested: { list: [1, { x: null }], u: undefined }, s: '' });
  const got = await s.get('k1');
  c('set/get round-trips nested data (undefined dropped, null and empty string kept)', got.a === 1 && got.nested.list[1].x === null && !('u' in got.nested) && got.s === '');
  c('get of a missing key is null', (await s.get('nope')) === null);
  got.a = 99;
  c('returned values are copies (mutating them does not change the store)', (await s.get('k1')).a === 1);
  await s.delete('k1');
  c('delete removes the key', (await s.get('k1')) === null);

  c('putIfAbsent claims a free key', (await s.putIfAbsent('claim', { by: 'a' })) === true);
  c('putIfAbsent refuses a live key and does not overwrite', (await s.putIfAbsent('claim', { by: 'b' })) === false && (await s.get('claim')).by === 'a');

  await s.set('ttl1', { x: 1 }, { ttlSeconds: 60 });
  c('item is readable before its TTL', (await s.get('ttl1')) !== null);
  clock.advance(61000);
  c('expired item reads as missing (DynamoDB deletes lazily, so reads must filter)', (await s.get('ttl1')) === null);
  c('an expired key can be claimed again', (await s.putIfAbsent('ttl1', { x: 2 }, { ttlSeconds: 60 })) === true && (await s.get('ttl1')).x === 2);
  await s.set('forever', { x: 1 });
  clock.advance(400 * 86400000);
  c('items with no TTL never expire', (await s.get('forever')) !== null);

  const upd = await s.update('counter', (cur) => ({ n: (cur ? cur.n : 0) + 1 }));
  const upd2 = await s.update('counter', (cur) => ({ n: cur.n + 1 }));
  c('update creates then modifies', upd.n === 1 && upd2.n === 2 && (await s.get('counter')).n === 2);
  const same = await s.update('counter', () => undefined);
  c('update returning undefined leaves the item unchanged', same.n === 2 && (await s.get('counter')).n === 2);

  // Sparse secondary indexes
  const pad = repos.pad;
  const held = (id, exp, status = 'held') => ({ id, status, exp });
  const hOpts = (v) => ({ index: v.status === 'held' ? { gsi1: { pk: 'bookings#held', sk: pad(v.exp) } } : undefined });
  await s.set('b:c', held('c', 300), hOpts(held('c', 300)));
  await s.set('b:a', held('a', 100), hOpts(held('a', 100)));
  await s.set('b:b', held('b', 200), hOpts(held('b', 200)));
  c('query returns items ordered by sort key', JSON.stringify(ids(await s.query('gsi1', 'bookings#held'))) === '["a","b","c"]');
  c('query supports sort-key ranges', JSON.stringify(ids(await s.query('gsi1', 'bookings#held', { skMin: pad(150), skMax: pad(250) }))) === '["b"]' && JSON.stringify(ids(await s.query('gsi1', 'bookings#held', { skMax: pad(100) }))) === '["a"]');
  c('query respects limit', (await s.query('gsi1', 'bookings#held', { limit: 2 })).length === 2);
  await s.update('b:a', (v) => ({ ...v, status: 'confirmed' }), hOpts);
  c('index is sparse: changing status removes the item from the index', JSON.stringify(ids(await s.query('gsi1', 'bookings#held'))) === '["b","c"]' && (await s.get('b:a')).status === 'confirmed');
  await s.set('b:x', held('x', 50), { ttlSeconds: 10, index: { gsi1: { pk: 'bookings#held', sk: pad(50) } } });
  clock.advance(11000);
  c('expired items are excluded from queries', JSON.stringify(ids(await s.query('gsi1', 'bookings#held'))) === '["b","c"]');
  c('a second index works independently', (await s.query('gsi2', 'calls#park')).length === 0);

  c('list(prefix) finds only matching live keys (dev/test helper)', ids(await s.list('b:')).sort().join() === 'a,b,c');

  let tooBig = null;
  try { await s.set('big', { blob: 'x'.repeat(500 * 1024) }); } catch (err) { tooBig = err; }
  c('oversized items fail loudly (DynamoDB 400 KB limit)', tooBig && tooBig.code === 'ITEM_TOO_LARGE');

  // Locks
  let order = [];
  await Promise.all([1, 2, 3].map((n) => s.withLock('lk', async () => { order.push(`in${n}`); await sleep(15); order.push(`out${n}`); })));
  c('withLock serialises contenders (no interleaving)', order.every((e, i) => (i % 2 === 0 ? e.startsWith('in') : e.startsWith('out') && e.slice(3) === order[i - 1].slice(2))));
  let thrown = null;
  try { await s.withLock('lk2', async () => { throw new Error('boom'); }); } catch (err) { thrown = err; }
  const reacquired = await Promise.race([s.withLock('lk2', async () => 'again', { waitMs: 300 }), sleep(1500).then(() => 'STUCK')]);
  c('lock is released even when the work throws, and the error propagates', thrown && thrown.message === 'boom' && reacquired === 'again');
  const quick = await Promise.race([s.withLock('lk3', async () => 'one').then(() => s.withLock('lk3', async () => 'two', { waitMs: 300 })), sleep(1500).then(() => 'STUCK')]);
  c('lock is free again immediately after a normal release (no leaked locks)', quick === 'two');
  return s;
}

const suites = {
  contract: {
    name: 'Store contract: identical behaviour on MemoryStore and DynamoStore',
    async run({ check }) {
      await contract('memory', async ({ now }) => new MemoryStore({ now }), { check });
      await contract('dynamodb', async ({ now }) => newDynamoStore({ now }), { check });
    },
  },

  dynamo: {
    name: 'DynamoDB: contention, multi-container behaviour, leases, pagination',
    async run({ check }) {
      const clock = makeClock();
      const now = () => clock.t;
      const a = await newDynamoStore({ now });
      const tableName = a.table;
      // Three "Lambda containers": separate store instances (and clients) over one table.
      const b = await newDynamoStore({ now, tableName, create: false });
      const c3 = await newDynamoStore({ now, tableName, create: false });
      const containers = [a, b, c3];

      const claims = await Promise.all(Array.from({ length: 40 }, (_, i) => containers[i % 3].putIfAbsent('evt:1', { winner: i })));
      check('putIfAbsent: exactly one of 40 concurrent claims across 3 containers wins', claims.filter(Boolean).length === 1);

      await Promise.all(Array.from({ length: 45 }, (_, i) => containers[i % 3].update('ctr', (cur) => ({ n: (cur ? cur.n : 0) + 1 }))));
      check('update (optimistic): 45 concurrent increments across 3 containers lose no updates', (await a.get('ctr')).n === 45);

      let inside = 0; let maxInside = 0; let done = 0;
      await Promise.all(Array.from({ length: 12 }, (_, i) => containers[i % 3].withLock('crit', async () => {
        inside += 1; maxInside = Math.max(maxInside, inside);
        const v = (await a.get('shared')) || { n: 0 };
        await sleep(8);
        await a.set('shared', { n: v.n + 1 }); // deliberately NOT atomic: only the lock protects it
        inside -= 1; done += 1;
      })));
      check('withLock: mutual exclusion across containers (non-atomic read-modify-write stays correct)', maxInside === 1 && done === 12 && (await a.get('shared')).n === 12);

      // A holder that died: lock item with a live lease blocks others until the lease lapses.
      await a.doc.send(new a.cmd.PutCommand({ TableName: a.table, Item: { pk: 'lock:ghost', owner: 'dead-container', lease_until: clock.t + 1000, ttl: Math.ceil(clock.t / 1000) + 7200 } }));
      let timeout = null;
      try { await b.withLock('ghost', async () => 'x', { waitMs: 200 }); } catch (err) { timeout = err; }
      check('a live lease blocks other containers; waiting times out with LOCK_TIMEOUT', timeout && timeout.code === 'LOCK_TIMEOUT');
      clock.advance(2000);
      check('after the dead holder\'s lease lapses another container takes over', (await b.withLock('ghost', async () => 'recovered', { waitMs: 300 })) === 'recovered');

      // Pagination: >1 MB result sets span several Query pages.
      for (let i = 0; i < 14; i += 1) await a.set(`big:${i}`, { id: i, pad: 'x'.repeat(100 * 1024) }, { index: { gsi2: { pk: 'calls#bigpark', sk: repos.pad(1000 + i) } } });
      const all = await b.query('gsi2', 'calls#bigpark');
      check('query follows pagination (14 x 100 KB items, ~1.4 MB, all returned in order)', all.length === 14 && all[0].id === 0 && all[13].id === 13);
      check('list(prefix) follows pagination too', (await c3.list('big:')).length === 14);

      // Record-level: stale index vs. truth. The held-bookings index is eventually consistent in real
      // DynamoDB, so jobs re-read each record (get) under a lock; that contract is covered in platform tests.
      await a.set('v1', { x: 1 });
      await a.set('v1', { x: 2 });
      const raw = await a.doc.send(new a.cmd.GetCommand({ TableName: a.table, Key: { pk: 'v1' }, ConsistentRead: true }));
      check('every write bumps the item version', raw.Item.version === 2);

      const huge = await newDynamoStore({ now, maxItemBytes: 1024 });
      let big = null;
      try { await huge.update('h', () => ({ blob: 'x'.repeat(5000) })); } catch (err) { big = err; }
      check('update enforces the item size limit too', big && big.code === 'ITEM_TOO_LARGE');
    },
  },

  repos: {
    name: 'Repos: retention and indexes for bookings and calls',
    async run({ check }) {
      const clock = makeClock();
      const now = () => clock.t;
      for (const [label, store] of [['memory', new MemoryStore({ now })], ['dynamodb', await newDynamoStore({ now })]]) {
        const rec = { park_id: 'lakeside', booking_ref: 'NB1', status: 'held', hold_expires_ms: clock.t + 45 * 60000 };
        await repos.saveBooking(store, rec);
        check(`[${label}] held booking appears in the held index`, (await repos.heldBookings(store)).map((r) => r.booking_ref).join() === 'NB1');
        await repos.saveBooking(store, { ...rec, status: 'confirmed' });
        check(`[${label}] confirmed booking leaves the held index but stays readable`, (await repos.heldBookings(store)).length === 0 && (await repos.getBooking(store, 'lakeside', 'NB1')).status === 'confirmed');
        clock.advance(91 * 86400000);
        check(`[${label}] booking records expire after the 90 day retention`, (await repos.getBooking(store, 'lakeside', 'NB1')) === null);

        const t0 = clock.t;
        await repos.updateCall(store, 'c1', () => ({ call_sid: 'c1', park_id: 'lakeside', started_at: t0, last_turn_at: t0, finalized_at: null }));
        await repos.updateCall(store, 'c2', () => ({ call_sid: 'c2', park_id: 'riverbend', started_at: t0, last_turn_at: t0 - 3600000, finalized_at: null }));
        check(`[${label}] open calls are found by last activity`, (await repos.openCallsBefore(store, t0 - 1800000)).map((r) => r.call_sid).join() === 'c2');
        await repos.updateCall(store, 'c2', (r) => ({ ...r, finalized_at: t0 }));
        check(`[${label}] finalised calls leave the open index`, (await repos.openCallsBefore(store, t0 + 1)).map((r) => r.call_sid).join() === 'c1');
        check(`[${label}] calls are indexed per park for statements`, (await repos.parkCalls(store, 'riverbend', t0 - 1000, t0 + 1000)).length === 1 && (await repos.parkCalls(store, 'lakeside', t0 - 1000, t0 + 1000)).length === 1);
        clock.advance(2000 * 86400000);
        check(`[${label}] billing ledger records have no TTL by default`, (await repos.getCall(store, 'c1')) !== null);
      }
    },
  },

  infra: {
    name: 'Infrastructure template matches the schema the code expects',
    async run({ check }) {
      const yaml = fs.readFileSync('sam.yaml', 'utf8');
      const def = TABLE_DEFINITION('x');
      check('every attribute in the code\'s table definition is declared in sam.yaml', def.AttributeDefinitions.every((a) => new RegExp(`AttributeName: ${a.AttributeName}, AttributeType: ${a.AttributeType}`).test(yaml)));
      check('both indexes exist with the same key attributes', def.GlobalSecondaryIndexes.every((g) => yaml.includes(`IndexName: ${g.IndexName}`) && g.KeySchema.every((k) => new RegExp(`AttributeName: ${k.AttributeName}, KeyType: ${k.KeyType}`).test(yaml))));
      check('DynamoDB TTL is enabled on the "ttl" attribute the store writes', /TimeToLiveSpecification:\s+AttributeName: ttl\s+Enabled: true/.test(yaml));
      check('table is retained on stack deletion, backed up (PITR), encrypted, on-demand', /DeletionPolicy: Retain/.test(yaml) && /PointInTimeRecoveryEnabled: true/.test(yaml) && /SSEEnabled: true/.test(yaml) && /BillingMode: PAY_PER_REQUEST/.test(yaml));
      check('both Lambda functions get table access and select the DynamoDB backend', (yaml.match(/DynamoDBCrudPolicy/g) || []).length === 2 && (yaml.match(/STORE_BACKEND: dynamodb/g) || []).length === 2);
    },
  },
};

async function main() {
  const arg = process.argv[2] || 'all';
  const keys = arg === 'all' ? Object.keys(suites) : [arg];
  if (keys.some((k) => !suites[k])) { console.error(`Unknown suite "${arg}". Use ${Object.keys(suites).join(', ')} or all.`); process.exit(2); }
  console.log('OnSite store tests | MemoryStore vs DynamoStore (dynalite, real DynamoDB wire protocol)');
  const all = [];
  for (const k of keys) {
    const s = suites[k];
    console.log(`\n==================== ${s.name} ====================`);
    const { check, results } = makeChecker();
    try { await s.run({ check }); } catch (err) { console.error(err); check(`suite threw: ${err.message}`, false); }
    const pass = results.every((r) => r.ok);
    console.log(`\n>>> ${k}: ${pass ? 'PASS' : 'FAIL'} (${results.filter((r) => r.ok).length}/${results.length} checks)`);
    all.push({ name: k, pass });
  }
  await stopDynamo();
  console.log('\n==================== SUMMARY ====================');
  for (const a of all) console.log(`${a.pass ? 'PASS' : 'FAIL'}  ${a.name}`);
  process.exit(all.every((a) => a.pass) ? 0 : 1);
}

main();
