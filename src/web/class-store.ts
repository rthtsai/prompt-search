import type {Variable} from '../domain.ts';
// 班級版（ai-class-lab）的前端客戶端。原版 prompt-search 完全不會載入這個檔案。
// 身分抽成 ClassSession 介面：現在可以塞假的 session 開發，接上 Supabase Auth 時只換這一層。

export type Role='teacher'|'assistant'|'student';
export type MemberStatus='pending'|'active'|'removed';
export type ClassMembership={class_id:string;name:string;role:Role;status:MemberStatus;
  nickname:string|null;team_id:string|null;team:string|null;archived:boolean};
export type Me={uid:string;classes:ClassMembership[]};

/** 登入這件事抽象成這樣，之後換成 Supabase Auth 不用動其他程式。 */
export type ClassSession={
  token():Promise<string|null>;
  signIn():Promise<void>;
  signOut():Promise<void>;
  onChange(listener:()=>void):()=>void;
};

/** 畫面要顯示什麼，完全由這個函式決定——UI 不再自己判斷條件。 */
export type Stage=
 |{kind:'loading'}
 |{kind:'signed-out'}
 |{kind:'no-class'}                                   // 登入了但還沒加入任何班
 |{kind:'pending';membership:ClassMembership}         // 等老師核可
 |{kind:'nickname';membership:ClassMembership}        // 核可了但還沒設暱稱
 |{kind:'archived';membership:ClassMembership}
 |{kind:'ready';membership:ClassMembership;others:ClassMembership[]};

export function classStage(me:Me|null,currentId:string|null):Stage{
  if(me===null)return {kind:'signed-out'};
  const usable=me.classes.filter(c=>c.status!=='removed');
  if(!usable.length)return {kind:'no-class'};
  // 記住的班級可能已經被移出或不存在了，那就退回第一個還能用的
  const current=usable.find(c=>c.class_id===currentId)??pickDefault(usable);
  const others=usable.filter(c=>c.class_id!==current.class_id);
  if(current.status==='pending')return {kind:'pending',membership:current};
  if(current.archived)return {kind:'archived',membership:current};
  if(!current.nickname)return {kind:'nickname',membership:current};
  return {kind:'ready',membership:current,others};
}

/** 沒有記住的班級時，優先挑已經能用的，其次才是等核可的。 */
function pickDefault(list:ClassMembership[]):ClassMembership{
  return list.find(c=>c.status==='active'&&!c.archived&&c.nickname)
    ??list.find(c=>c.status==='active'&&!c.archived)
    ??list[0];
}

const REMEMBERED='class-lab:last-class';
/** localStorage 在無痕模式或封鎖 cookie 時會直接丟錯，所以一律包起來。 */
export function rememberClass(id:string|null){
  try{ id?localStorage.setItem(REMEMBERED,id):localStorage.removeItem(REMEMBERED); }catch{}
}
export function rememberedClass():string|null{
  try{ return localStorage.getItem(REMEMBERED); }catch{ return null; }
}

/** class_prompt_card 回傳的卡片；和原版的 CardPrompt 不同，多了作者、組別與輸出。 */
export type ClassOutput={id:string;kind:'text'|'image';text_body?:string|null;
  image_thumb?:string|null;member_id:string;created_at:string};
export type ClassCard={id:string;title:string;body:string;summary:string;category:string;
  tags:string[];variables:Variable[];model_hint:string[];use_count:number;last_used:string|null;
  source:string;fork_of:string|null;updated_at:string;created_at:string;
  group_id:string;version_no:number;version_note:string;
  task_id:string|null;featured:boolean;member_id:string;
  author:string|null;team:string|null;outputs:ClassOutput[]};
export type ClassTask={id:string;title:string;closed:boolean};

/** 列表的四個分頁。scope 決定伺服器回傳哪些卡片，任務下拉再篩一層。 */
export type Scope='mine'|'team'|'class'|'featured';
export type Filter={scope:Scope;taskId:string|null};

export const SCOPES:{key:Scope;label:string}[]=[
  {key:'mine',label:'我的'},{key:'team',label:'本組'},
  {key:'class',label:'全班'},{key:'featured',label:'精選'}];

/** 沒分組的人看不到「本組」，不然會得到一個永遠空白的分頁。 */
export function visibleScopes(membership:{team_id:string|null}):typeof SCOPES{
  return SCOPES.filter(s=>s.key!=='team'||membership.team_id!==null);
}

export function listRequest(classId:string,filter:Filter):Record<string,unknown>{
  const request:Record<string,unknown>={op:'list',class_id:classId,scope:filter.scope};
  if(filter.taskId)request.task_id=filter.taskId;
  return request;
}

/**
 * 是不是自己寫的。卡片只帶得到作者的暱稱（member_id 是 membership 的主鍵，前端沒有），
 * 而暱稱在一個班裡有唯一索引，所以拿它比對是準的。
 * 伺服器仍會自己驗一次 member_id，這裡只是決定畫面要不要給編輯。
 */
export function isMine(card:{author:string|null},membership:{nickname:string|null}):boolean{
  return membership.nickname!==null&&card.author===membership.nickname;
}

/** 資料庫存的是沒有前綴的 base64（CHECK 擋 /9j/ 開頭），要加回前綴才能餵給 <img>。 */
export function asDataUrl(value:string|null|undefined):string|null{
  if(!value)return null;
  return value.startsWith('data:')?value:`data:image/jpeg;base64,${value}`;
}

/** 卡片封面：先用圖片輸出的縮圖，沒有圖就不放封面。 */
export function coverOf(card:ClassCard):string|null{
  return asDataUrl(card.outputs?.find(o=>o.kind==='image'&&o.image_thumb)?.image_thumb);
}

export type ClassConfig={url:string;key:string};
export type ClassRpc=(request:Record<string,unknown>)=>Promise<unknown>;

/** 每次呼叫都帶使用者的 JWT；伺服器端靠 auth.uid() 認人，前端送什麼 class_id 都會被驗。 */
export function createClassRpc(config:ClassConfig,session:ClassSession,
    transport:typeof fetch=fetch):ClassRpc{
  const send=transport.bind(globalThis);
  return async request=>{
    const token=await session.token();
    if(!token)throw new Error('請先登入');
    const response=await send(`${config.url}/rest/v1/rpc/class_api`,{
      method:'POST',cache:'no-store',
      headers:{apikey:config.key,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({request})});
    const text=await response.text();
    if(!response.ok)throw new Error(readError(text,response.status));
    return text?JSON.parse(text):null;
  };
}

/** Supabase 把 PL/pgSQL 的 RAISE 包在 JSON 裡；把那句話挖出來給使用者看。 */
export function readError(body:string,status:number):string{
  try{
    const parsed=JSON.parse(body) as {message?:string;error_description?:string};
    const message=parsed.message??parsed.error_description;
    if(message)return message;
  }catch{}
  if(status===401||status===403)return '登入狀態過期了，請重新登入';
  return `連線失敗（${status}）`;
}

export async function fetchMe(rpc:ClassRpc):Promise<Me>{
  const raw=await rpc({op:'me'}) as Me;
  return {uid:raw.uid,classes:Array.isArray(raw.classes)?raw.classes:[]};
}
/** 班級代碼大小寫與前後空白都不計較，學生在 iPad 上手打很容易多打空格。 */
export async function joinClass(rpc:ClassRpc,code:string){
  const clean=code.trim().toLowerCase();
  if(!clean)throw new Error('請輸入班級代碼');
  return await rpc({op:'join_request',class_code:clean}) as {class_id:string;status:MemberStatus;name?:string};
}
export async function listPrompts(rpc:ClassRpc,classId:string,filter:Filter):Promise<ClassCard[]>{
  const rows=await rpc(listRequest(classId,filter));
  return Array.isArray(rows)?rows as ClassCard[]:[];
}
/**
 * 列表為了省流量只帶圖片輸出（class_prompt_card 的 with_outputs 預設是 false），
 * 所以打開一筆來編輯時要重新拿完整的版本串，不然文字結果會看起來不見了。
 */
export async function fetchVersions(rpc:ClassRpc,classId:string,groupId:string):Promise<ClassCard[]>{
  const rows=await rpc({op:'get',class_id:classId,group_id:groupId});
  return Array.isArray(rows)?rows as ClassCard[]:[];
}
export async function listTasks(rpc:ClassRpc,classId:string):Promise<ClassTask[]>{
  const rows=await rpc({op:'task_list',class_id:classId});
  return Array.isArray(rows)?rows as ClassTask[]:[];
}

export async function setNickname(rpc:ClassRpc,classId:string,nickname:string){
  const clean=nickname.trim();
  if([...clean].length<2||[...clean].length>12)throw new Error('暱稱請填 2 到 12 個字');
  return await rpc({op:'set_nickname',class_id:classId,nickname:clean}) as {nickname:string};
}
