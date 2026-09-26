import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { passwordHash, validatePassword, verifyPassword } from './auth.mjs';
import { openStore } from './store.mjs';

test('密码强度与摘要验证',()=>{
  for(const weak of ['short1A','alllower123','ALLUPPER123','NoDigitsHere'])assert.throws(()=>validatePassword(weak),/密码至少 8 位/);
  const hash=passwordHash('ValidPass123');
  assert.ok(hash.startsWith('scrypt:'));
  assert.equal(verifyPassword('ValidPass123',hash),true);
  assert.equal(verifyPassword('WrongPass123',hash),false);
});

test('现有版本数据库升级并只创建一次 admin',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'le-migrate-'));
  try{
    const filename=path.join(dir,'light-exam.sqlite');
    const legacy=new DatabaseSync(filename);
    legacy.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO meta(key,value) VALUES('schema_version','1'); CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_sub TEXT NOT NULL,name TEXT NOT NULL,groups_json TEXT NOT NULL,expires_at INTEGER NOT NULL);");
    legacy.close();
    const db=openStore(dir);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value,'2');
    assert.ok(db.prepare('PRAGMA table_info(sessions)').all().some(column=>column.name==='auth_method'));
    const admin=db.prepare("SELECT * FROM users WHERE username='admin'").get();
    assert.equal(admin.must_change,0);
    assert.equal(verifyPassword('Unconfigured123',admin.password_hash),false);
    db.prepare("UPDATE users SET password_hash=?,must_change=1 WHERE username='admin'").run(passwordHash('LegacyPass123')); 
    db.close();
    const again=openStore(dir);
    assert.equal(again.prepare('SELECT COUNT(*) AS count FROM users').get().count,1);
    const upgraded=again.prepare("SELECT password_hash,must_change FROM users WHERE username='admin'").get();
    assert.equal(upgraded.must_change,0);
    assert.equal(verifyPassword('LegacyPass123',upgraded.password_hash),false);
    again.close();
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
