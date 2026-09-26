import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeQuestions, normalizeTemplate, buildExam, grade, summarize } from './domain.mjs';
import { openStore, transaction } from './store.mjs';

const bank='bank-1';
const make=(number,type,chapter,answer=type==='多选'?'AC':'A')=>({number,stem:`第 ${number} 题`,type,options:{A:'选项一',B:'选项二',C:'选项三'},answer,tags:[`章节:${chapter}`]});

test('章节标签、重复章节、答案和题型校验',()=>{
  const rows=normalizeQuestions([make(1,'单选','第一章'),{...make(2,'判断','第二章'),tags:[]}],bank);
  assert.deepEqual(summarize(rows).chapters,{'未分类':1,'第一章':1});
  assert.throws(()=>normalizeQuestions([{...make(3,'单选','第一章'),tags:['章节:第一章','章节:第二章']}],bank),/多个不同章节/);
  assert.throws(()=>normalizeQuestions([{...make(4,'多选','第一章'),answer:'A'}],bank),/至少需要两个答案/);
});

test('优先固定章节，缺额跨章节补齐，题型不足阻止开考',()=>{
  const rows=normalizeQuestions([make(1,'单选','第一章'),make(2,'单选','第二章'),make(3,'单选','第二章'),make(4,'多选','第二章'),make(5,'判断','第一章')],bank);
  const config=normalizeTemplate({name:'模拟卷',chapters:['第一章'],rules:{单选:{count:2,score:.5},多选:{count:1,score:2},判断:{count:1,score:1}}},['第一章','第二章']);
  const exam=buildExam(rows,config);
  assert.equal(exam.length,4);
  assert.equal(new Set(exam.map(q=>q.id)).size,4);
  assert.equal(exam.find(q=>q.type==='判断').chapter,'第一章');
  assert.equal(exam.find(q=>q.type==='多选').chapter,'第二章');
  const answers=Object.fromEntries(exam.map(q=>[q.id,q.answer]));
  assert.deepEqual(grade(exam,answers),{score:4,maxScore:4,correct:4,blank:0,incorrect:0});
  assert.throws(()=>buildExam(rows,{...config, rules:{...config.rules,多选:{count:2,score:2}}}),/全库只有 1/);
});

test('SQLite 事务失败后保持原题库',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'light-exam-test-'));
  try{
    const db=openStore(dir);
    db.prepare('INSERT INTO banks(id,name,updated_at) VALUES(?,?,?)').run(bank,'测试题库',new Date().toISOString());
    assert.throws(()=>transaction(db,()=>{
      db.prepare('INSERT INTO questions(id,bank_id,number,type,stem,options_json,answer,explanation,chapter,tags_json) VALUES(?,?,?,?,?,?,?,?,?,?)').run('q1',bank,'1','单选','题干','{}','A','','第一章','[]');
      throw Error('模拟写入故障');
    }),/模拟写入故障/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM questions').get().count,0);
    db.close();
  }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
