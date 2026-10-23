let questionManagerBank=null,managedQuestions=[],questionListPage=0,questionEdit=null,questionEditBaseline='',questionSaving=false,questionManagerToken=0;
const questionEditBody=()=>({number:$('editQuestionNumber').value.trim(),type:$('editQuestionType').value,stem:$('editQuestionStem').value,options:Object.fromEntries([...$('editQuestionOptions').querySelectorAll('textarea')].map(input=>[input.dataset.letter,input.value.trim()]).filter(([,v])=>v)),answer:$('editQuestionAnswer').value.trim(),explanation:$('editQuestionExplanation').value,tags:[...$('editQuestionTags').value.split('\n').map(v=>v.trim()).filter(Boolean),`章节:${$('editQuestionChapter').value.trim()||'未分类'}`]});
const questionEditDirty=()=>!!questionEdit&&JSON.stringify(questionEditBody())!==questionEditBaseline;
function leaveQuestionEdit(){if(questionSaving)return false;if(questionEditDirty()&&!confirm('题目修改尚未保存，确定放弃这些修改？'))return false;questionEdit=null;questionEditBaseline='';$('questionEditForm').classList.add('hidden');return true}
async function openQuestionManager(target){
 if(!target||!leaveQuestionEdit())return;
 const token=++questionManagerToken,rows=await api(`/api/banks/${target.id}/questions`);
 if(token!==questionManagerToken)return;
 questionManagerBank=target;managedQuestions=rows;questionListPage=0;
 $('questionSearch').value='';$('questionTypeFilter').value='';$('questionChapterFilter').value='';
 $('questionManagerTitle').textContent=`编辑题目 · ${target.name}`;
 updateQuestionChapters();$('questionManager').classList.remove('hidden');renderManagedQuestions();$('questionManager').scrollIntoView({block:'start',behavior:'instant'});
}
function updateQuestionChapters(){const previous=$('questionChapterFilter').value;optionList($('questionChapterFilter'),[['','全部章节'],...[...new Set(managedQuestions.map(q=>q.chapter))].sort((a,b)=>a.localeCompare(b,'zh-CN')).map(c=>[c,c])]);$('questionChapterFilter').value=previous;$('questionChapterFilter').value||($('questionChapterFilter').value='')}
function renderManagedQuestions(){
 const search=$('questionSearch').value.trim().toLocaleLowerCase(),type=$('questionTypeFilter').value,chapter=$('questionChapterFilter').value;
 const filtered=managedQuestions.filter(q=>(!type||q.type===type)&&(!chapter||q.chapter===chapter)&&(!search||[q.number,q.stem,q.answer,q.explanation].some(v=>String(v).toLocaleLowerCase().includes(search))));
 const pages=Math.max(1,Math.ceil(filtered.length/10));questionListPage=Math.min(questionListPage,pages-1);
 $('questionListStatus').textContent=`共 ${managedQuestions.length} 道题，匹配 ${filtered.length} 道`;
 $('questionList').innerHTML=filtered.slice(questionListPage*10,questionListPage*10+10).map(q=>`<div class="admin-row question-list-row"><div><small>${escapeHtml(q.type)} · ${escapeHtml(q.chapter)} · 原题号 ${escapeHtml(q.number)}</small><p>${escapeHtml(q.stem)}</p></div><button class="secondary-button" type="button" data-edit-question="${escapeHtml(q.id)}">编辑</button></div>`).join('')||'<p class="help-text">没有匹配的题目。</p>';
 $('questionPageLabel').textContent=`${questionListPage+1} / ${pages}`;$('questionPagePrev').disabled=!questionListPage;$('questionPageNext').disabled=questionListPage>=pages-1;
}
async function editManagedQuestion(id){
 if(!leaveQuestionEdit())return;
 const bank=questionManagerBank,token=++questionManagerToken,result=await api(`/api/banks/${bank.id}/questions/${id}`);
 if(token!==questionManagerToken||questionManagerBank!==bank)return;
 questionEdit={...result,bankId:bank.id};const q=result.question;
 for(const [suffix,key] of [['Number','number'],['Type','type'],['Chapter','chapter'],['Stem','stem'],['Answer','answer'],['Explanation','explanation']])$('editQuestion'+suffix).value=q[key];
 $('editQuestionTags').value=q.tags.join('\n');
 $('editQuestionOptions').innerHTML=[...'ABCDEFGH'].map(letter=>`<label>选项 ${letter}<textarea rows="2" data-letter="${letter}" aria-label="选项 ${letter}">${escapeHtml(q.options[letter]||'')}</textarea></label>`).join('');
 $('questionSaveStatus').textContent='';$('questionEditTitle').textContent=`修改题目 · 原题号 ${q.number}`;$('questionEditForm').classList.remove('hidden');questionEditBaseline=JSON.stringify(questionEditBody());$('editQuestionStem').focus();
}
async function saveManagedQuestion(event){
 event.preventDefault();if(!questionEdit||questionSaving)return;
 const current=questionEdit,body={question:questionEditBody(),revision:current.revision};questionSaving=true;$('questionEditFields').disabled=true;$('questionSaveStatus').textContent='正在保存…';
 try{
  const saved=await api(`/api/banks/${current.bankId}/questions/${current.question.id}`,'PUT',body);
  managedQuestions=managedQuestions.map(q=>q.id===saved.question.id?saved.question:q);questionEdit=null;questionEditBaseline='';$('questionEditForm').classList.add('hidden');updateQuestionChapters();renderManagedQuestions();toast('题目已更新，新建考试和练习立即生效');
  // Refresh chapter filters and summaries without replacing existing attempt snapshots.
  await refreshBanks(bankId);show('admin');showAdminTab('banks');
 }catch(error){$('questionSaveStatus').textContent=error.message;throw error}
 finally{questionSaving=false;$('questionEditFields').disabled=false}
}
$('closeQuestionManager').onclick=()=>{if(leaveQuestionEdit()){questionManagerToken++;$('questionManager').classList.add('hidden')}};
$('cancelQuestionEdit').onclick=leaveQuestionEdit;
$('questionList').onclick=event=>{const button=event.target.closest('[data-edit-question]');if(button)run(()=>editManagedQuestion(button.dataset.editQuestion))};
$('questionEditForm').onsubmit=event=>run(()=>saveManagedQuestion(event));
for(const id of ['questionSearch','questionTypeFilter','questionChapterFilter'])$(id).addEventListener(id==='questionSearch'?'input':'change',()=>{questionListPage=0;renderManagedQuestions()});
$('questionPagePrev').onclick=()=>{questionListPage--;renderManagedQuestions()};$('questionPageNext').onclick=()=>{questionListPage++;renderManagedQuestions()};
window.addEventListener('beforeunload',event=>{if(questionEditDirty()||questionSaving){event.preventDefault();event.returnValue=''}});
