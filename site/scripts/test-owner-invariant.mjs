import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const migration = await readFile(new URL('../migrations/2026-11-13-single-owner.sql', import.meta.url), 'utf8');

test('owner migration is idempotent and SQLite rejects a second owner', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(migration); db.exec(migration);
    db.exec("INSERT INTO admin_users (username,password_hash,salt,is_owner,stamp) VALUES ('owner1','h','s',1,'a')");
    db.exec("INSERT INTO admin_users (username,password_hash,salt,is_owner,stamp) VALUES ('admin1','h','s',0,'b')");
    assert.throws(() => db.exec("INSERT INTO admin_users (username,password_hash,salt,is_owner,stamp) VALUES ('owner2','h','s',1,'c')"));
  } finally { db.close(); }
});

test('migration refuses an existing owner conflict without changing owners', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE admin_users (username TEXT PRIMARY KEY, password_hash TEXT, salt TEXT, is_owner INTEGER, stamp TEXT)");
    db.exec("INSERT INTO admin_users VALUES ('owner1','h','s',1,'a'), ('owner2','h','s',1,'b')");
    assert.throws(() => db.exec(migration));
    assert.equal(db.prepare('SELECT count(*) AS n FROM admin_users WHERE is_owner=1').get().n, 2);
  } finally { db.close(); }
});
