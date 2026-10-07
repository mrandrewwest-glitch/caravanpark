'use strict';

// Local DynamoDB for tests: `dynalite` (pure-JS DynamoDB emulator that speaks the real wire protocol,
// including conditional writes, update expressions and GSIs). Each test gets its own table.
const crypto = require('crypto');
const dynalite = require('dynalite');
const { CreateTableCommand } = require('@aws-sdk/client-dynamodb');
const { DynamoStore, TABLE_DEFINITION } = require('./dynamo-store');

let server = null;
let endpoint = null;

async function ensureServer() {
  if (server) return endpoint;
  server = dynalite({ createTableMs: 0, deleteTableMs: 0, updateTableMs: 0 });
  await new Promise((resolve, reject) => { server.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve())); });
  endpoint = `http://127.0.0.1:${server.address().port}`;
  return endpoint;
}

// A store on a fresh table. Several stores can share one table (tableName) to simulate
// multiple Lambda containers talking to the same database.
async function newDynamoStore({ now, tableName = `onsite-test-${crypto.randomUUID().slice(0, 8)}`, create = true, maxItemBytes } = {}) {
  const ep = await ensureServer();
  const store = DynamoStore.create({ table: tableName, endpoint: ep, region: 'ap-southeast-2', credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, now });
  if (maxItemBytes) store.maxItemBytes = maxItemBytes;
  if (create) await store.rawClient.send(new CreateTableCommand(TABLE_DEFINITION(tableName)));
  return store;
}

async function stopDynamo() {
  if (server) await new Promise((r) => server.close(r));
  server = null;
  endpoint = null;
}

module.exports = { newDynamoStore, stopDynamo };
