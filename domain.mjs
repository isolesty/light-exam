import { createHash, randomInt, randomUUID } from 'node:crypto';

export const TYPES = ['单选', '多选', '判断'];
export const normalizeAnswer = value => [...new Set((String(value ?? '').toUpperCase().replace(/[对错]/g, c => c === '对' ? 'A' : 'B').match(/[A-H]/g) || []))].sort().join('');
const text = value => String(value ?? '').trim();

export function normalizeQuestion(input, index, bankId) {
  const row = index + 1;
  const optionsInput = input.options ?? input.选项 ?? {};
  const options = Array.isArray(optionsInput) ? Object.fromEntries(optionsInput.map((v, i) => ['ABCDEFGH'[i], text(v)])) : Object.fromEntries(Object.entries(optionsInput).map(([k, v]) => [text(k).toUpperCase(), text(v)]));
  for (const key of 'ABCDEFGH') {
    const value = input[`选项 ${key}`] ?? input[`选项${key}`];
    if (value !== undefined && text(value)) options[key] = text(value);
  }
  for (const key of Object.keys(options)) if (!/^[A-H]$/.test(key) || !options[key]) delete options[key];
  const answer = normalizeAnswer(input.answer ?? input.答案);
  const rawTags = input.tags ?? input.标签 ?? [];
  const tags = (Array.isArray(rawTags) ? rawTags : text(rawTags).split(/[,，;；|\n]/)).map(text).filter(Boolean);
  const chapterTags = [...new Set(tags.filter(tag => tag.startsWith('章节:') || tag.startsWith('章节：')).map(tag => text(tag.slice(3))))];
  if (chapterTags.length > 1) throw new Error(`第 ${row} 行有多个不同章节标签`);
  if (chapterTags.some(v => !v)) throw new Error(`第 ${row} 行章节名称为空`);
  const chapter = chapterTags[0] || '未分类';
  const explicitType = text(input.type ?? input.题型);
  const typeTag = tags.find(tag => TYPES.includes(tag) || TYPES.some(type => tag.includes(type)));
  const type = TYPES.find(t => explicitType.includes(t)) ?? TYPES.find(t => typeTag?.includes(t)) ?? (answer.length > 1 ? '多选' : options.A === '对' && options.B === '错' ? '判断' : '单选');
  const stem = text(input.stem ?? input.题干 ?? input.question ?? input.题目);
  if (!stem || stem.length > 10000) throw new Error(`第 ${row} 行题干无效`);
  if (Object.keys(options).length < 2 || !answer || [...answer].some(c => !options[c])) throw new Error(`第 ${row} 行选项或答案无效`);
  if (type !== '多选' && answer.length !== 1) throw new Error(`第 ${row} 行${type}题应只有一个答案`);
  if (type === '多选' && answer.length < 2) throw new Error(`第 ${row} 行多选题至少需要两个答案`);
  const number = text(input.number ?? input.序号 ?? input.id) || String(row);
  const digest = createHash('sha256').update(`${bankId}\0${number}\0${stem}`).digest('hex').slice(0, 24);
  return { id: `${bankId}-${digest}`, bankId, number, type, stem, options, answer, explanation: text(input.explanation ?? input.解析 ?? input.试题解析), chapter, tags: tags.filter(tag => !TYPES.includes(tag) && !/^章节[:：]/.test(tag)) };
}

export function normalizeQuestions(input, bankId) {
  const rows = Array.isArray(input) ? input : input?.questions;
  if (!Array.isArray(rows) || !rows.length || rows.length > 10000) throw new Error('题库须包含 1 至 10000 道题');
  const questions = rows.map((q, i) => normalizeQuestion(q, i, bankId));
  if (new Set(questions.map(q => q.id)).size !== questions.length) throw new Error('题库含重复题号和题干');
  return questions;
}

export function summarize(questions) {
  const types = Object.fromEntries(TYPES.map(t => [t, questions.filter(q => q.type === t).length]));
  const chapters = Object.fromEntries([...new Set(questions.map(q => q.chapter))].sort((a, b) => a.localeCompare(b, 'zh-CN')).map(c => [c, questions.filter(q => q.chapter === c).length]));
  return { count: questions.length, types, chapters, uncategorized: chapters['未分类'] || 0 };
}

export function normalizeTemplate(input, availableChapters) {
  const name = text(input.name);
  if (!name || name.length > 80) throw new Error('考试方案名称须为 1 至 80 个字符');
  const chapters = input.chapters === 'all' ? 'all' : [...new Set(Array.isArray(input.chapters) ? input.chapters.map(text) : [])];
  if (chapters !== 'all' && (!chapters.length || chapters.some(c => !availableChapters.includes(c)))) throw new Error('请选择有效的固定章节范围');
  const rules = {};
  for (const type of TYPES) {
    const count = Number(input.rules?.[type]?.count ?? 0), score = Number(input.rules?.[type]?.score ?? 0);
    if (!Number.isInteger(count) || count < 0 || count > 1000 || !Number.isFinite(score) || score < 0 || score > 100 || Math.abs(Math.round(score * 100) - score * 100) > 1e-8) throw new Error(`${type}题量或分值无效`);
    if (count > 0 && score <= 0) throw new Error(`${type}已配置题量，分值须大于零`);
    rules[type] = { count, score };
  }
  if (!TYPES.some(t => rules[t].count > 0)) throw new Error('至少配置一种题型的题量');
  return { name, chapters, rules, maxScore: Math.round(TYPES.reduce((sum, t) => sum + rules[t].count * rules[t].score, 0) * 100) / 100 };
}

export function shuffle(input) {
  const values = [...input];
  for (let i = values.length - 1; i > 0; i--) { const j = randomInt(i + 1); [values[i], values[j]] = [values[j], values[i]]; }
  return values;
}

export function buildExam(questions, template) {
  const selected = [];
  for (const type of TYPES) {
    const count = template.rules[type].count;
    const byType = questions.filter(q => q.type === type);
    if (byType.length < count) throw new Error(`${type}题不足：需要 ${count} 道，全库只有 ${byType.length} 道`);
    const inside = template.chapters === 'all' ? byType : byType.filter(q => template.chapters.includes(q.chapter));
    const first = shuffle(inside).slice(0, count);
    const rest = count - first.length;
    const outside = rest ? shuffle(byType.filter(q => !first.some(p => p.id === q.id) && !inside.some(p => p.id === q.id))).slice(0, rest) : [];
    selected.push(...first, ...outside);
  }
  return selected.map(q => ({ ...q, score: template.rules[q.type].score }));
}

export function grade(snapshot, answers) {
  let score = 0, correct = 0, blank = 0;
  for (const q of snapshot) { const answer = answers[q.id] || ''; if (!answer) blank++; else if (answer === q.answer) { correct++; score += q.score; } }
  return { score: Math.round(score * 100) / 100, maxScore: Math.round(snapshot.reduce((n, q) => n + q.score, 0) * 100) / 100, correct, blank, incorrect: snapshot.length - correct - blank };
}

export const publicQuestion = q => ({ id: q.id, number: q.number, type: q.type, stem: q.stem, options: q.options, chapter: q.chapter, tags: q.tags, score: q.score });
export const newId = () => randomUUID();
