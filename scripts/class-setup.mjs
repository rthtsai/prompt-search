// 開班腳本（v3 由 Richard 執行）：建立班級、代碼、組別，並把指定的 Google 帳號設為該班老師。
// 用法：node scripts/class-setup.mjs "10年級AI課" teacher@gmail.com 6
// 需要環境變數 CLASS_SUPABASE_URL 與 CLASS_SERVICE_KEY（service_role key，只在本機使用，不要進版控）。
const [name,email,teams='0',max='40']=process.argv.slice(2);
const url=process.env.CLASS_SUPABASE_URL, key=process.env.CLASS_SERVICE_KEY;
if(!name||!email||!url||!key){
  console.error('用法：CLASS_SUPABASE_URL=... CLASS_SERVICE_KEY=... node scripts/class-setup.mjs "班名" 老師email [組數] [人數上限]');
  process.exit(1);
}
const response=await fetch(`${url}/rest/v1/rpc/class_create`,{method:'POST',
  headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},
  body:JSON.stringify({p_name:name,p_teacher_email:email,p_max:Number(max),p_teams:Number(teams)})});
const result=await response.json();
if(!response.ok){console.error('開班失敗：',result.message??result);process.exit(1);}
console.log(`班級：${result.name}\n班級代碼：${result.code}\n組別：${result.teams} 組\n老師：${email}`);
console.log('把班級代碼發給學生，他們登入後輸入代碼申請加入，你在後台核可即可。');
