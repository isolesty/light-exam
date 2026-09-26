'use strict';
const form=document.getElementById('loginForm');
form.addEventListener('submit',async event=>{
  event.preventDefault();
  const button=document.getElementById('loginButton'),error=document.getElementById('loginError');
  error.hidden=true;button.disabled=true;
  try{
    const response=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:document.getElementById('username').value.trim(),password:document.getElementById('password').value})});
    const data=await response.json();
    if(!response.ok)throw Error(data.error||'登录失败');
    location.replace('/');
  }catch(cause){error.textContent=cause.message;error.hidden=false;button.disabled=false}
});
