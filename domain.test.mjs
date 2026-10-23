import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeQuestions, normalizeTemplate, buildExam, grade, summarize, shuffleQuestionOptions } from './domain.mjs';
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


test('同卷按内容去重，忽略题号、章节、空白、选项顺序和答案解析差异',()=>{
  const base=make(1,'单选','第一章');
  const rows=normalizeQuestions([
    base,
    {...base,number:2,tags:['章节:第二章'],stem:'第\n １ 题',options:{C:'选项二',A:'选项三',B:'选项一'},answer:'B',explanation:'另一份解析'},
    make(3,'单选','第二章'),
    {...base,number:4,options:{A:'另一个选项',B:'选项二',C:'选项三'}},
    make(5,'多选','第一章'),
    {...make(5,'多选','第二章'),number:6},
    make(7,'判断','第一章'),
    {...make(7,'判断','第二章'),number:8},
  ],bank);
  const config=normalizeTemplate({name:'去重模拟卷',chapters:['第一章'],rules:{单选:{count:3,score:.5},多选:{count:1,score:1.5},判断:{count:1,score:1}}},['第一章','第二章']);
  for(let i=0;i<100;i++){
    const exam=buildExam([...rows,rows[0]],config);
    assert.equal(exam.length,5);
    assert.equal(new Set(exam.map(q=>q.id)).size,5);
    assert.ok(!exam.some(q=>['2','6','8'].includes(q.number)));
    assert.ok(exam.some(q=>q.number==='4'),'相同题干但不同选项应保留');
    assert.equal(grade(exam,Object.fromEntries(exam.map(q=>[q.id,q.answer]))).score,4);
  }
  assert.equal(rows.length,8,'抽题不得修改原始题库');
  assert.throws(()=>buildExam(rows,{...config,rules:{...config.rules,单选:{count:4,score:.5}}}),/去重后全库只有 3 道/);
  const all={...config,chapters:'all'};
  for(let i=0;i<100;i++){
    const exam=buildExam(rows,all);
    assert.equal(exam.length,5);
    assert.equal(exam.filter(q=>q.type==='单选').length,3);
    assert.equal(exam.filter(q=>q.type==='多选').length,1);
    assert.equal(exam.filter(q=>q.type==='判断').length,1);
  }
});


test('选项重排同步答案，保留原题与解析',()=>{
  const original={id:'multi',type:'多选',options:{A:'甲',B:'乙',C:'丙',D:'丁',E:'戊'},answer:'ACE',explanation:'A、C、E 正确，公式 A = B + C。',score:1.5};
  const before=structuredClone(original);
  const reversed=shuffleQuestionOptions(original,entries=>[...entries].reverse());
  assert.deepEqual(reversed.options,{A:'戊',B:'丁',C:'丙',D:'乙',E:'甲'});
  assert.equal(reversed.answer,'ACE');
  assert.ok(reversed.explanation.endsWith(original.explanation));
  assert.match(reversed.explanation,/A→E，B→D，C→C，D→B，E→A/);
  const moved=shuffleQuestionOptions({...original,answer:'AB'},entries=>[...entries].reverse());
  assert.equal(moved.answer,'DE');
  assert.deepEqual(grade([moved],{multi:'DE'}),{score:1.5,maxScore:1.5,correct:1,blank:0,incorrect:0});
  assert.equal(grade([moved],{multi:'AB'}).score,0);
  const orders=new Set();
  for(let i=0;i<100;i++){
    const q=shuffleQuestionOptions(original);orders.add(JSON.stringify(q.options));
    assert.deepEqual([...q.answer].map(c=>q.options[c]).sort(),['丙','戊','甲'].sort());
    assert.deepEqual(Object.values(q.options).sort(),Object.values(original.options).sort());
    assert.deepEqual(Object.keys(q.options),['A','B','C','D','E']);
  }
  assert.ok(orders.size>1);
  assert.deepEqual(original,before);
  for(const [type,options,correct] of [['单选',{A:'正确项',B:'错误一',C:'错误二',D:'错误三'},'正确项'],['判断',{A:'对',B:'错'},'对']]){
    const q={id:type,type,options,answer:'A',explanation:'原题 A 正确',score:1};
    const reversed=shuffleQuestionOptions(q,entries=>[...entries].reverse());
    assert.equal(reversed.options[reversed.answer],correct);
    assert.notEqual(reversed.answer,'A');
    assert.equal(grade([reversed],{[type]:reversed.answer}).score,1);
    assert.equal(grade([reversed],{[type]:'A'}).score,0);
    assert.ok(reversed.explanation.endsWith(q.explanation));
    assert.deepEqual(q.options,options);assert.equal(q.answer,'A');
    const seen=new Set();
    for(let i=0;i<100;i++){const randomized=shuffleQuestionOptions(q);seen.add(JSON.stringify(randomized.options));assert.equal(randomized.options[randomized.answer],correct)}
    assert.ok(seen.size>1);
  }
  const sparse=shuffleQuestionOptions({...original,options:{B:'乙',D:'丁',H:'辛'},answer:'BH',explanation:''},entries=>[...entries].reverse());
  assert.deepEqual(sparse.options,{A:'辛',B:'丁',C:'乙'});assert.equal(sparse.answer,'AC');
});
