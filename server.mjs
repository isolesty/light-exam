import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openStore, transaction, json, parse } from './store.mjs';
import { TYPES, normalizeAnswer, normalizeQuestions, normalizeTemplate, summarize, buildExam, grade, publicQuestion, shuffle, newId } from './domain.mjs';
import { ADMIN_SUB, passwordHash, verifyPassword, validatePassword, validateUsername } from './auth.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const db = openStore(process.env.DATA_DIR || path.join(root, 'runtime'));
const port = Number(process.env.PORT || 8080);
const oidc = {
  clientId: process.env.LAZYCAT_AUTH_OIDC_CLIENT_ID || process.env.OIDC_CLIENT_ID,
  clientSecret: process.env.LAZYCAT_AUTH_OIDC_CLIENT_SECRET || process.env.OIDC_CLIENT_SECRET,
  issuer: process.env.LAZYCAT_AUTH_OIDC_ISSUER_URI || process.env.OIDC_ISSUER,
  auth: process.env.LAZYCAT_AUTH_OIDC_AUTH_URI || process.env.OIDC_AUTH_URI,
  token: process.env.LAZYCAT_AUTH_OIDC_TOKEN_URI || process.env.OIDC_TOKEN_URI,
  userinfo: process.env.LAZYCAT_AUTH_OIDC_USERINFO_URI || process.env.OIDC_USERINFO_URI,
};
const appOrigin = process.env.APP_ORIGIN || (process.env.LAZYCAT_APP_DOMAIN ? `https://${process.env.LAZYCAT_APP_DOMAIN}` : 'http://localhost:8080');
const callbackUrl = `${appOrigin}/auth/oidc/callback`;
const b64 = bytes => Buffer.from(bytes).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const randomToken = () => b64(randomBytes(32));
const now = () => new Date().toISOString();
const loginFailures = new Map();
const fail = (status, message) => Object.assign(new Error(message), { status });
const readJson = value => parse(value);
const send = (res, status, data, headers = {}) => {
  const body = typeof data === 'string' ? data : json(data);
  res.writeHead(status, { 'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...headers });
  res.end(body);
};
const redirect = (res, location, headers = {}) => { res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', ...headers }); res.end(); };
const cookie = (name, value, age) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split('=').map(decodeURIComponent)).filter(x => x.length === 2));
const getBody = async req => { let size = 0, chunks = []; for await (const chunk of req) { size += chunk.length; if (size > 8_000_000) throw fail(413, '请求内容过大'); chunks.push(chunk); } try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail(400, 'JSON 格式无效'); } };
const rowQuestion = row => ({ id: row.id, bankId: row.bank_id, number: row.number, type: row.type, stem: row.stem, options: readJson(row.options_json), answer: row.answer, explanation: row.explanation, chapter: row.chapter, tags: readJson(row.tags_json) });
const questions = bankId => db.prepare('SELECT * FROM questions WHERE bank_id=? ORDER BY rowid').all(bankId).map(rowQuestion);
const bank = id => db.prepare('SELECT * FROM banks WHERE id=? AND active=1').get(id);
const template = id => db.prepare('SELECT * FROM templates WHERE id=? AND active=1').get(id);
const sessionUser = req => {
  const token = cookies(req).le_session;
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(hash(token), Date.now());
  if (!row) return null;
  if (row.user_sub.startsWith('oidc:') && row.auth_method === 'oidc') {
    return { sub: row.user_sub, name: row.name, admin: false, mustChangePassword: false, authMethod: 'oidc' };
  }
  if (!row.user_sub.startsWith('local:')) return null;
  const account = db.prepare('SELECT username,role,active,must_change FROM users WHERE username=?').get(row.user_sub.slice(6));
  if (!account?.active) return null;
  return { sub: row.user_sub, name: account.username, admin: account.role === 'admin', mustChangePassword: !!account.must_change, authMethod: row.auth_method };
};
const needUser = user => { if (!user) throw fail(401, '请先登录'); return user; };
const needAdmin = user => { needUser(user); if (!user.admin) throw fail(403, '只有管理员可以管理题库、考试方案和用户'); };
const verifyOrigin = req => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
  const origin = req.headers.origin;
  if (!origin || origin !== appOrigin) throw fail(403, '请求来源无效');
  if (!req.headers['content-type']?.startsWith('application/json') && req.url !== '/auth/logout') throw fail(415, '需要 JSON 请求');
};
const mappedAttempt = row => ({ id: row.id, bankId: row.bank_id, templateId: row.template_id, mode: row.mode, title: row.title, questions: readJson(row.snapshot_json), answers: readJson(row.answers_json), marks: readJson(row.marks_json), confirmed: readJson(row.confirmed_json), position: row.position, submittedAt: row.submitted_at, score: row.score, maxScore: row.max_score, createdAt: row.created_at });
const attemptRow = (id, sub) => { const row = db.prepare('SELECT * FROM attempts WHERE id=? AND user_sub=?').get(id, sub); if (!row) throw fail(404, '答题记录不存在'); return row; };
const presentAttempt = row => { const a = mappedAttempt(row); return { ...a, questions: a.questions.map(q => a.submittedAt || (a.mode === 'practice' && a.confirmed[q.id]) ? q : publicQuestion(q)), stats: a.submittedAt ? grade(a.questions, a.answers) : undefined }; };
const validateChoice = (q, answer) => { if (answer && (![...answer].every(c => Object.hasOwn(q.options, c)) || (q.type !== '多选' && answer.length !== 1))) throw fail(400, '答案不属于本题选项'); };
const updateLearning = (sub, q, answer) => {
  if (!answer) return;
  const current = db.prepare('SELECT * FROM user_questions WHERE user_sub=? AND question_id=?').get(sub, q.id) || { favorite: 0, wrong: 0, streak: 0, answered_count: 0 };
  const good = answer === q.answer;
  const streak = !good ? 0 : current.wrong ? current.streak + 1 : 0;
  const wrong = !good ? 1 : current.wrong && streak < 3 ? 1 : 0;
  db.prepare('INSERT INTO user_questions(user_sub,question_id,favorite,wrong,streak,answered_count) VALUES(?,?,?,?,?,?) ON CONFLICT(user_sub,question_id) DO UPDATE SET wrong=excluded.wrong,streak=excluded.streak,answered_count=excluded.answered_count').run(sub, q.id, current.favorite, wrong, wrong ? streak : 0, current.answered_count + 1);
};

async function verifyIdToken(token, nonce) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw fail(401, 'OIDC 身份令牌无效');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  if (header.alg !== 'RS256' || !header.kid || claims.iss !== oidc.issuer || claims.aud !== oidc.clientId || claims.nonce !== nonce || !claims.sub || !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000 || claims.iat > Date.now() / 1000 + 60) throw fail(401, 'OIDC 身份校验失败');
  const discovery = await fetch(`${oidc.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
  if (!discovery.ok) throw fail(502, 'OIDC 配置不可用');
  const config = await discovery.json();
  if (config.issuer !== oidc.issuer || !config.jwks_uri || new URL(config.jwks_uri).origin !== new URL(oidc.issuer).origin) throw fail(502, 'OIDC 配置异常');
  const jwksRes = await fetch(config.jwks_uri);
  if (!jwksRes.ok) throw fail(502, 'OIDC 公钥不可用');
  const jwk = (await jwksRes.json()).keys?.find(k => k.kid === header.kid && k.kty === 'RSA' && (!k.use || k.use === 'sig'));
  if (!jwk || !verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) throw fail(401, 'OIDC 签名校验失败');
  return claims;
}

async function authRoute(req, res, url) {
  if (url.pathname === '/auth/login' && req.method === 'GET') {
    if (sessionUser(req)) return redirect(res, '/');
    if (Object.values(oidc).some(x => !x)) throw fail(503, '懒猫 OIDC 尚未配置');
    const state = randomToken(), verifier = randomToken(), nonce = randomToken();
    db.prepare('INSERT INTO auth_states(state,verifier,nonce,expires_at) VALUES(?,?,?,?)').run(state, verifier, nonce, Date.now() + 600000);
    db.prepare('DELETE FROM auth_states WHERE expires_at<?').run(Date.now());
    const destination = new URL(oidc.auth);
    for (const [key, value] of Object.entries({ client_id: oidc.clientId, redirect_uri: callbackUrl, response_type: 'code', scope: 'openid profile email groups', state, nonce, code_challenge: b64(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' })) destination.searchParams.set(key, value);
    return redirect(res, destination.toString(), { 'Set-Cookie': cookie('le_oidc_state', state, 600) });
  }
  if (url.pathname === '/auth/oidc/callback' && req.method === 'GET') {
    const state = url.searchParams.get('state');
    if (!state || state !== cookies(req).le_oidc_state || !url.searchParams.get('code')) throw fail(401, 'OIDC 登录状态无效');
    const authState = db.prepare('SELECT * FROM auth_states WHERE state=? AND expires_at>?').get(state, Date.now());
    if (!authState) throw fail(401, 'OIDC 登录已过期');
    db.prepare('DELETE FROM auth_states WHERE state=?').run(state);
    const tokenResponse = await fetch(oidc.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: callbackUrl, client_id: oidc.clientId, client_secret: oidc.clientSecret, code_verifier: authState.verifier }) });
    if (!tokenResponse.ok) throw fail(401, 'OIDC 令牌交换失败');
    const tokens = await tokenResponse.json();
    const claims = await verifyIdToken(tokens.id_token, authState.nonce);
    const profileResponse = await fetch(oidc.userinfo, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (!profileResponse.ok) throw fail(401, 'OIDC 用户信息获取失败');
    const profile = await profileResponse.json();
    if (profile.sub !== claims.sub) throw fail(401, 'OIDC 用户信息不一致');
    const groups = Array.isArray(profile.groups) ? profile.groups : Array.isArray(claims.groups) ? claims.groups : [];
    const isAdmin = groups.includes('ADMIN');
    const subject = isAdmin ? ADMIN_SUB : `oidc:${hash(`${oidc.issuer}\0${claims.sub}`)}`;
    const displayName = isAdmin ? 'admin' : String(profile.name || profile.preferred_username || claims.name || claims.preferred_username || '懒猫用户').slice(0, 80);
    if (isAdmin) transaction(db, () => {
      db.prepare('UPDATE attempts SET user_sub=? WHERE user_sub=?').run(ADMIN_SUB, claims.sub);
      db.prepare('INSERT OR IGNORE INTO user_questions(user_sub,question_id,favorite,wrong,streak,answered_count) SELECT ?,question_id,favorite,wrong,streak,answered_count FROM user_questions WHERE user_sub=?').run(ADMIN_SUB, claims.sub);
      db.prepare('DELETE FROM user_questions WHERE user_sub=?').run(claims.sub);
    });
    const token = randomToken();
    db.prepare('INSERT INTO sessions(token_hash,user_sub,name,groups_json,expires_at,auth_method) VALUES(?,?,?,?,?,?)').run(hash(token), subject, displayName, json(groups), Date.now() + 12 * 3600000, 'oidc');
    return redirect(res, '/', { 'Set-Cookie': [cookie('le_session', token, 43200), cookie('le_oidc_state', '', 0)] });
  }
  if (url.pathname === '/auth/logout' && req.method === 'POST') {
    const token = cookies(req).le_session;
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
    return redirect(res, '/login', { 'Set-Cookie': cookie('le_session', '', 0) });
  }
  throw fail(404, '路径不存在');
}

async function api(req, res, url, user) {
  const p = url.pathname;
  if (p === '/api/auth/login' && req.method === 'POST') {
    const body = await getBody(req);
    const username = String(body.username ?? '').trim();
    if (username.length > 32 || typeof body.password !== 'string' || body.password.length > 128) throw fail(401, '用户名或密码错误');
    const key = `${req.socket.remoteAddress}:${username.toLowerCase()}`;
    const attempts = (loginFailures.get(key) || []).filter(t => t > Date.now() - 15 * 60000);
    if (attempts.length >= 5) throw fail(429, '尝试次数过多，请 15 分钟后再试');
    const account = db.prepare('SELECT * FROM users WHERE username=?').get(username);
    if (!account?.active || !verifyPassword(body.password, account.password_hash)) {
      attempts.push(Date.now()); if (loginFailures.size > 10000) loginFailures.clear(); loginFailures.set(key, attempts);
      throw fail(401, '用户名或密码错误');
    }
    loginFailures.delete(key);
    const token = randomToken(), sub = `local:${account.username}`;
    db.prepare('INSERT INTO sessions(token_hash,user_sub,name,groups_json,expires_at,auth_method) VALUES(?,?,?,?,?,?)').run(hash(token), sub, account.username, json([]), Date.now() + 12 * 3600000, 'local');
    return send(res, 200, { name: account.username, mustChangePassword: !!account.must_change }, { 'Set-Cookie': cookie('le_session', token, 43200) });
  }
  needUser(user);
  if (p === '/api/me' && req.method === 'GET') return send(res, 200, { sub: user.sub, name: user.name, canManage: user.admin, mustChangePassword: user.mustChangePassword, authMethod: user.authMethod });
  if (p === '/api/me/password' && req.method === 'PATCH') {
    if (user.authMethod === 'oidc' && !user.admin) throw fail(403, '懒猫账号密码请在懒猫微服中修改');
    const body = await getBody(req);
    const account = db.prepare('SELECT password_hash FROM users WHERE username=?').get(user.name);
    if (user.authMethod === 'local' && !verifyPassword(body.currentPassword, account.password_hash)) throw fail(403, '当前密码错误');
    try { validatePassword(body.newPassword); } catch(error) { throw fail(400, error.message); }
    if (verifyPassword(body.newPassword, account.password_hash)) throw fail(400, '新密码不能与当前密码相同');
    db.prepare('UPDATE users SET password_hash=?,must_change=0,updated_at=? WHERE username=?').run(passwordHash(body.newPassword), now(), user.name);
    db.prepare('DELETE FROM sessions WHERE user_sub=? AND token_hash<>?').run(user.sub, hash(cookies(req).le_session));
    return send(res, 200, { ok: true });
  }
  if (user.mustChangePassword) throw fail(403, '请先修改初始密码');
  if (p === '/api/users' && req.method === 'GET') { needAdmin(user); return send(res, 200, db.prepare("SELECT username,role,active,must_change AS mustChange,created_at AS createdAt,updated_at AS updatedAt FROM users ORDER BY CASE WHEN username='admin' THEN 0 ELSE 1 END,username").all()); }
  if (p === '/api/users' && req.method === 'POST') {
    needAdmin(user); const body = await getBody(req);
    try { validateUsername(body.username); validatePassword(body.password); } catch(error) { throw fail(400, error.message); }
    if (db.prepare('SELECT 1 FROM users WHERE lower(username)=lower(?)').get(body.username)) throw fail(409, '用户名已存在');
    const timestamp = now();
    db.prepare('INSERT INTO users(username,password_hash,role,active,must_change,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(body.username,passwordHash(body.password),'user',1,1,timestamp,timestamp);
    return send(res, 201, { username:body.username, role:'user', active:true, mustChange:true });
  }
  const userPasswordMatch = p.match(/^\/api\/users\/([^/]+)\/password$/);
  if (userPasswordMatch && req.method === 'PUT') {
    needAdmin(user); const username = decodeURIComponent(userPasswordMatch[1]),body = await getBody(req);
    const target = db.prepare('SELECT username FROM users WHERE username=?').get(username);
    if (!target) throw fail(404, '用户不存在');
    if (username === 'admin') throw fail(400, '请在个人密码页面修改管理员密码');
    try { validatePassword(body.password); } catch(error) { throw fail(400, error.message); }
    db.prepare('UPDATE users SET password_hash=?,must_change=?,updated_at=? WHERE username=?').run(passwordHash(body.password),username==='admin'?0:1,now(),username);
    db.prepare('DELETE FROM sessions WHERE user_sub=?').run(`local:${username}`);
    return send(res, 200, { ok:true });
  }
  const userMatch = p.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && req.method === 'PATCH') {
    needAdmin(user); const username = decodeURIComponent(userMatch[1]),body = await getBody(req);
    if (username === 'admin') throw fail(400, '不能停用管理员');
    if (typeof body.active !== 'boolean') throw fail(400, '用户状态无效');
    if (!db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) throw fail(404, '用户不存在');
    db.prepare('UPDATE users SET active=?,updated_at=? WHERE username=?').run(body.active?1:0,now(),username);
    if (!body.active) db.prepare('DELETE FROM sessions WHERE user_sub=?').run(`local:${username}`);
    return send(res, 200, { ok:true, active:body.active });
  }
  if (p === '/api/banks' && req.method === 'GET') return send(res, 200, db.prepare('SELECT b.id,b.name,b.updated_at AS updatedAt,(SELECT COUNT(*) FROM questions q WHERE q.bank_id=b.id) AS count FROM banks b WHERE b.active=1 ORDER BY b.updated_at DESC').all());
  if (p === '/api/banks' && req.method === 'POST') { needAdmin(user); const body = await getBody(req); const name = String(body.name || '').trim(); if (!name || name.length > 80) throw fail(400, '题库名称须为 1 至 80 个字符'); const id = newId(); db.prepare('INSERT INTO banks(id,name,updated_at) VALUES(?,?,?)').run(id, name, now()); return send(res, 201, { id, name }); }
  const bankMatch = p.match(/^\/api\/banks\/([^/]+)$/);
  if (bankMatch) { const b = bank(bankMatch[1]); if (!b) throw fail(404, '题库不存在'); if (req.method === 'PATCH') { needAdmin(user); const body = await getBody(req); const name = String(body.name || '').trim(); if (!name || name.length > 80) throw fail(400, '题库名称无效'); db.prepare('UPDATE banks SET name=?,updated_at=? WHERE id=?').run(name, now(), b.id); return send(res, 200, { id: b.id, name }); } if (req.method === 'DELETE') { needAdmin(user); db.prepare('UPDATE banks SET active=0 WHERE id=?').run(b.id); db.prepare('UPDATE templates SET active=0 WHERE bank_id=?').run(b.id); return send(res, 200, { ok: true }); } }
  const questionMatch = p.match(/^\/api\/banks\/([^/]+)\/questions$/);
  if (questionMatch) { const b = bank(questionMatch[1]); if (!b) throw fail(404, '题库不存在'); if (req.method === 'GET') { needAdmin(user); return send(res, 200, questions(b.id)); } if (req.method === 'PUT') { needAdmin(user); const normalized = normalizeQuestions(await getBody(req), b.id); transaction(db, () => { db.prepare('DELETE FROM questions WHERE bank_id=?').run(b.id); const insert = db.prepare('INSERT INTO questions(id,bank_id,number,type,stem,options_json,answer,explanation,chapter,tags_json) VALUES(?,?,?,?,?,?,?,?,?,?)'); for (const q of normalized) insert.run(q.id,b.id,q.number,q.type,q.stem,json(q.options),q.answer,q.explanation,q.chapter,json(q.tags)); db.prepare('UPDATE banks SET updated_at=? WHERE id=?').run(now(),b.id); }); return send(res, 200, summarize(normalized)); } }
  if (p === '/api/import/preview' && req.method === 'POST') { needAdmin(user); return send(res, 200, summarize(normalizeQuestions(await getBody(req), 'preview'))); }
  const chapterMatch = p.match(/^\/api\/banks\/([^/]+)\/chapters$/);
  if (chapterMatch && req.method === 'GET') { if (!bank(chapterMatch[1])) throw fail(404, '题库不存在'); return send(res, 200, summarize(questions(chapterMatch[1])).chapters); }
  const catalogMatch = p.match(/^\/api\/banks\/([^/]+)\/catalog$/);
  if (catalogMatch && req.method === 'GET') { if (!bank(catalogMatch[1])) throw fail(404, '题库不存在'); const all=questions(catalogMatch[1]); return send(res,200,{ summary:summarize(all), tags:[...new Set(all.flatMap(q=>q.tags))].sort((a,b)=>a.localeCompare(b,'zh-CN')) }); }
  const bankTemplateMatch = p.match(/^\/api\/banks\/([^/]+)\/templates$/);
  if (bankTemplateMatch) { const b = bank(bankTemplateMatch[1]); if (!b) throw fail(404, '题库不存在'); if (req.method === 'GET') return send(res, 200, db.prepare('SELECT * FROM templates WHERE bank_id=? AND active=1 ORDER BY updated_at DESC').all(b.id).map(t => ({ id:t.id, bankId:t.bank_id, name:t.name, chapters:readJson(t.chapters_json), rules:readJson(t.rules_json), updatedAt:t.updated_at }))); if (req.method === 'POST') { needAdmin(user); const t = normalizeTemplate(await getBody(req), Object.keys(summarize(questions(b.id)).chapters)); const id = newId(); db.prepare('INSERT INTO templates(id,bank_id,name,chapters_json,rules_json,updated_at) VALUES(?,?,?,?,?,?)').run(id,b.id,t.name,json(t.chapters),json(t.rules),now()); return send(res, 201, { id, ...t }); } }
  const templateMatch = p.match(/^\/api\/templates\/([^/]+)$/);
  if (templateMatch) { needAdmin(user); const t = template(templateMatch[1]); if (!t) throw fail(404, '考试方案不存在'); if (req.method === 'PUT') { const normalized = normalizeTemplate(await getBody(req), Object.keys(summarize(questions(t.bank_id)).chapters)); db.prepare('UPDATE templates SET name=?,chapters_json=?,rules_json=?,updated_at=? WHERE id=?').run(normalized.name,json(normalized.chapters),json(normalized.rules),now(),t.id); return send(res, 200, { id:t.id,...normalized }); } if (req.method === 'DELETE') { db.prepare('UPDATE templates SET active=0 WHERE id=?').run(t.id); return send(res, 200, { ok:true }); } }
  if (p === '/api/learning' && req.method === 'GET') { const bankId = url.searchParams.get('bankId'); if (!bank(bankId)) throw fail(404, '题库不存在'); const ids = questions(bankId).map(q => q.id); const rows = db.prepare('SELECT * FROM user_questions WHERE user_sub=?').all(user.sub).filter(row => ids.includes(row.question_id)); const latest = db.prepare('SELECT id,title,score,max_score,submitted_at FROM attempts WHERE user_sub=? AND bank_id=? AND submitted_at IS NOT NULL AND mode=\'exam\' ORDER BY submitted_at DESC LIMIT 20').all(user.sub,bankId); return send(res,200,{ items:Object.fromEntries(rows.map(r => [r.question_id,{ favorite:!!r.favorite,wrong:!!r.wrong,streak:r.streak,answeredCount:r.answered_count }])), history:latest }); }
  const favoriteMatch = p.match(/^\/api\/questions\/([^/]+)\/favorite$/);
  if (favoriteMatch && req.method === 'POST') { const q = db.prepare('SELECT id FROM questions WHERE id=?').get(favoriteMatch[1]); if (!q) throw fail(404, '题目不存在'); const current = db.prepare('SELECT favorite FROM user_questions WHERE user_sub=? AND question_id=?').get(user.sub,q.id)?.favorite || 0; db.prepare('INSERT INTO user_questions(user_sub,question_id,favorite) VALUES(?,?,?) ON CONFLICT(user_sub,question_id) DO UPDATE SET favorite=excluded.favorite').run(user.sub,q.id,current?0:1); return send(res,200,{favorite:!current}); }
  if (p === '/api/attempts' && req.method === 'POST') { const body = await getBody(req); const b = bank(body.bankId); if (!b) throw fail(404, '题库不存在'); const all = questions(b.id); let picked,title,maxScore,templateId=null; if (body.mode === 'exam') { const t = template(body.templateId); if (!t || t.bank_id !== b.id) throw fail(400, '考试方案不属于此题库'); const spec = { chapters:readJson(t.chapters_json), rules:readJson(t.rules_json) }; picked = buildExam(all,spec); title=t.name; templateId=t.id; maxScore=picked.reduce((n,q)=>n+q.score,0); } else if (body.mode === 'practice') { const filters=body.filters||{},learning=db.prepare('SELECT * FROM user_questions WHERE user_sub=?').all(user.sub),map=new Map(learning.map(r=>[r.question_id,r])); if(filters.ids && (!Array.isArray(filters.ids)||filters.ids.length>10000)) throw fail(400,'指定题目范围无效'); const requested=filters.ids?new Set(filters.ids):null; picked=all.filter(q=>(!requested||requested.has(q.id))&&(!filters.chapter||filters.chapter==='all'||q.chapter===filters.chapter)&&(!filters.type||filters.type==='all'||q.type===filters.type)&&(!filters.tag||filters.tag==='all'||q.tags.includes(filters.tag))&&(!filters.source||filters.source==='all'||filters.source==='wrong'&&map.get(q.id)?.wrong||filters.source==='favorite'&&map.get(q.id)?.favorite)).map(q=>({...q,score:1})); picked=shuffle(picked); if (!picked.length) throw fail(400,'当前练习范围没有题目'); title=requested?'本次错题重练':'章节练习'; maxScore=picked.length; } else throw fail(400,'答题模式无效'); const id=newId(); db.prepare('INSERT INTO attempts(id,user_sub,bank_id,template_id,mode,title,snapshot_json,max_score,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,user.sub,b.id,templateId,body.mode,title,json(picked),Math.round(maxScore*100)/100,now()); return send(res,201,presentAttempt(attemptRow(id,user.sub))); }
  if (p === '/api/attempts' && req.method === 'GET') return send(res,200,db.prepare('SELECT id,bank_id AS bankId,mode,title,score,max_score AS maxScore,created_at AS createdAt,submitted_at AS submittedAt FROM attempts WHERE user_sub=? ORDER BY created_at DESC LIMIT 50').all(user.sub));
  const attemptMatch=p.match(/^\/api\/attempts\/([^/]+)$/);
  if (attemptMatch && req.method === 'GET') return send(res,200,presentAttempt(attemptRow(attemptMatch[1],user.sub)));
  const progressMatch=p.match(/^\/api\/attempts\/([^/]+)\/progress$/);
  if (progressMatch && req.method === 'PATCH') { const row=attemptRow(progressMatch[1],user.sub); if(row.submitted_at) throw fail(409,'已交卷'); const a=mappedAttempt(row), body=await getBody(req); const q=a.questions.find(q=>q.id===body.questionId); if(!q) throw fail(400,'题目不属于本次答题'); if(a.confirmed[q.id] && (body.marked===undefined || normalizeAnswer(body.answer)!==a.answers[q.id])) throw fail(409,'本题已确认'); const answer=normalizeAnswer(body.answer); validateChoice(q,answer); if(!a.confirmed[q.id]) a.answers[q.id]=answer; if(body.position!==undefined) { if(!Number.isInteger(body.position)||body.position<0||body.position>=a.questions.length) throw fail(400,'题号无效'); a.position=body.position; } if(body.marked!==undefined) a.marks[q.id]=!!body.marked; db.prepare('UPDATE attempts SET answers_json=?,marks_json=?,position=? WHERE id=?').run(json(a.answers),json(a.marks),a.position,a.id); return send(res,200,{ok:true}); }
  const positionMatch=p.match(/^\/api\/attempts\/([^/]+)\/position$/);
  if(positionMatch && req.method==='PATCH'){ const row=attemptRow(positionMatch[1],user.sub); if(row.submitted_at) throw fail(409,'已交卷'); const body=await getBody(req),size=readJson(row.snapshot_json).length; if(!Number.isInteger(body.position)||body.position<0||body.position>=size) throw fail(400,'题号无效'); db.prepare('UPDATE attempts SET position=? WHERE id=?').run(body.position,row.id); return send(res,200,{ok:true}); }
  const confirmMatch=p.match(/^\/api\/attempts\/([^/]+)\/confirm$/);
  if(confirmMatch && req.method==='POST'){ const row=attemptRow(confirmMatch[1],user.sub),a=mappedAttempt(row); if(a.submittedAt||a.mode!=='practice') throw fail(409,'本次答题不能逐题确认'); const body=await getBody(req); const q=a.questions.find(q=>q.id===String(body.questionId)); if(!q||!a.answers[q.id]) throw fail(400,'请先答题'); if(!a.confirmed[q.id]) transaction(db,()=>{ a.confirmed[q.id]=true; db.prepare('UPDATE attempts SET confirmed_json=? WHERE id=?').run(json(a.confirmed),a.id); updateLearning(user.sub,q,a.answers[q.id]); }); return send(res,200,{answer:q.answer,explanation:q.explanation,correct:a.answers[q.id]===q.answer}); }
  const submitMatch=p.match(/^\/api\/attempts\/([^/]+)\/submit$/);
  if(submitMatch && req.method==='POST'){ const row=attemptRow(submitMatch[1],user.sub),a=mappedAttempt(row); if(a.submittedAt) return send(res,200,presentAttempt(row)); const result=grade(a.questions,a.answers); transaction(db,()=>{ for(const q of a.questions) if(!a.confirmed[q.id]) updateLearning(user.sub,q,a.answers[q.id]); db.prepare('UPDATE attempts SET submitted_at=?,score=? WHERE id=?').run(now(),result.score,a.id); }); return send(res,200,presentAttempt(attemptRow(a.id,user.sub))); }
  throw fail(404,'接口不存在');
}

const staticFiles = new Map([['/','index.html'],['/index.html','index.html'],['/login','login.html'],['/login.js','login.js'],['/styles.css','styles.css'],['/app.js','app.js']]);
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8' };
const server = http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,appOrigin);
    verifyOrigin(req);
    if(url.pathname.startsWith('/auth/')) return await authRoute(req,res,url);
    const user=sessionUser(req);
    if(url.pathname.startsWith('/api/')) return await api(req,res,url,user);
    if(url.pathname === '/login' || url.pathname === '/login.js') {
      if(user && url.pathname === '/login') return redirect(res,'/');
      const file=staticFiles.get(url.pathname);
      res.writeHead(200,{'Content-Type':mime[path.extname(file)],'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
      return res.end(fs.readFileSync(path.join(root,'public',file)));
    }
    if(!user) return redirect(res,'/login');
    const file=staticFiles.get(url.pathname);
    if(!file||!['GET','HEAD'].includes(req.method)) throw fail(404,'页面不存在');
    res.writeHead(200,{'Content-Type':mime[path.extname(file)],'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
    res.end(req.method==='HEAD'?undefined:fs.readFileSync(path.join(root,'public',file)));
  } catch(error){ if((error.status||500)>=500) console.error(error); send(res,error.status||500,{error:error.status?error.message:'服务暂时不可用'}); }
});
if (process.env.NODE_ENV !== 'test') server.listen(port,'0.0.0.0',()=>console.log(`轻量考试运行于 ${port}`));
export { server, db };
