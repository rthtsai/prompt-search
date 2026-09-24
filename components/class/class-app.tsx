'use client';
// 班級版（ai-class-lab）的進入點。只有 pages:build:class 會把它接上，
// 原版 prompt-search 的建置完全不會碰到這個檔案。
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {BookOpen,LoaderCircle,LogIn,LogOut,ArrowRight,Clock3,RefreshCw,Star,Image as ImageIcon,
  MessageSquareText,History,Plus} from 'lucide-react';
import {Button} from '../ui/button';
import '../../app/class.css';
import {createClassSession} from '../../src/web/class-session';
import ClassEditor from './class-editor';
import {classStage,createClassRpc,fetchMe,joinClass,setNickname,listPrompts,listTasks,
  visibleScopes,coverOf,rememberClass,rememberedClass,
  type Me,type Stage,type ClassCard,type ClassTask,type Filter,type ClassMembership,
  type ClassRpc} from '../../src/web/class-store';

const CONFIG={url:process.env.NEXT_PUBLIC_SUPABASE_URL??'',key:process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY??''};
const SITE=(process.env.NEXT_PUBLIC_BASE_PATH??'')+'/';

export default function ClassApp() {
  const [me,setMe]=useState<Me|null>(null);
  const [currentId,setCurrentId]=useState<string|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);

  const session=useMemo(()=>createClassSession({...CONFIG,
    redirectTo:typeof window!=='undefined'?new URL(SITE,window.location.origin).toString():SITE}),[]);
  const rpc=useMemo(()=>createClassRpc(CONFIG,session),[session]);

  const load=useCallback(async()=>{
    setLoading(true);setError('');
    try{ setMe(await fetchMe(rpc)); }
    catch(e){ const message=(e as Error).message;
      // 還沒登入不是錯誤，只是還沒開始
      if(/請先登入/.test(message))setMe(null); else setError(message); }
    finally{ setLoading(false); }
  },[rpc]);

  useEffect(()=>{setCurrentId(rememberedClass());void load();},[load]);
  useEffect(()=>session.onChange(()=>{void load();}),[session,load]);

  const stage:Stage=loading&&!me?{kind:'loading'}:classStage(me,currentId);
  const run=async(work:()=>Promise<unknown>)=>{
    setBusy(true);setError('');
    try{ await work(); await load(); }
    catch(e){ setError((e as Error).message); }
    finally{ setBusy(false); }
  };
  const choose=(id:string)=>{setCurrentId(id);rememberClass(id);};

  return <div className="app-shell class-shell">
    <main className="main-content" id="main-content">
      {'membership' in stage&&
        <header className="class-bar">
          <span className="class-name">{stage.membership.name}</span>
          {stage.kind==='ready'&&<span className="class-who">
            {stage.membership.team&&<em>{stage.membership.team}</em>}{stage.membership.nickname}</span>}
          <button className="text-link" onClick={()=>void session.signOut()}><LogOut size={14}/>登出</button>
        </header>}

      {error&&<div className="class-error" role="alert">{error}
        <button className="text-link" onClick={()=>void load()}><RefreshCw size={13}/>重試</button></div>}

      {stage.kind==='loading'&&<Splash icon={<LoaderCircle size={30} className="spin"/>} title="載入中"/>}

      {stage.kind==='signed-out'&&<section className="class-gate">
        <div className="section-eyebrow"><span className="eyebrow-line"/>AI CLASS LAB</div>
        <h1>AI 課 <em>Prompt 實驗室</em></h1>
        <p>用你自己的 Google 帳號登入。同學之間只看得到你的暱稱，信箱只有老師看得到。</p>
        <Button className="class-big" onClick={()=>void session.signIn()}><LogIn size={20}/>用 Google 登入</Button>
      </section>}

      {stage.kind==='no-class'&&<JoinForm busy={busy} onJoin={code=>run(async()=>{
        const joined=await joinClass(rpc,code);choose(joined.class_id);})}/>}

      {stage.kind==='pending'&&<Splash icon={<Clock3 size={30}/>} title="已送出，等老師核可"
        note={`你申請加入「${stage.membership.name}」。老師核可後重新整理就能開始。`}
        action={<Button variant="outline" onClick={()=>void load()} disabled={loading}>
          <RefreshCw size={16} className={loading?'spin':''}/>檢查一下</Button>}/>}

      {stage.kind==='archived'&&<Splash icon={<BookOpen size={30}/>} title="這個班級已封存"
        note="課程結束了，內容已經收起來。"/>}

      {stage.kind==='nickname'&&<NicknameForm busy={busy} className={stage.membership.name}
        onSave={nick=>run(()=>setNickname(rpc,stage.membership.class_id,nick))}/>}

      {stage.kind==='ready'&&<>
        {stage.others.length>0&&<div className="class-switch">
          {stage.others.map(c=><button key={c.class_id} className="text-link"
            onClick={()=>choose(c.class_id)}>切換到 {c.name}<ArrowRight size={13}/></button>)}
        </div>}
        <ClassList rpc={rpc} membership={stage.membership}/>
      </>}
    </main>
  </div>;
}

function Splash({icon,title,note,action}:{icon:React.ReactNode;title:string;note?:string;action?:React.ReactNode}) {
  return <section className="prompts-section"><div className="empty-state">
    <span className="empty-icon">{icon}</span><h3>{title}</h3>{note&&<p>{note}</p>}{action}</div></section>;
}

function JoinForm({busy,onJoin}:{busy:boolean;onJoin:(code:string)=>void}) {
  const [code,setCode]=useState('');
  const field=useRef<HTMLInputElement>(null);
  useEffect(()=>{field.current?.focus();},[]);
  return <section className="class-gate">
    <h1>輸入<em>班級代碼</em></h1>
    <p>代碼會寫在黑板上，或由老師發給你。</p>
    <form onSubmit={e=>{e.preventDefault();onJoin(code);}}>
      {/* iPad 上的鍵盤預設會自動大寫和自動修正，代碼會被改掉 */}
      <input ref={field} className="class-code-input" value={code} maxLength={12}
        autoCapitalize="none" autoCorrect="off" spellCheck={false} inputMode="text"
        placeholder="例如 ab12cd" aria-label="班級代碼"
        onChange={e=>setCode(e.target.value)}/>
      <Button className="class-big" type="submit" disabled={busy||!code.trim()}>
        {busy?'送出中…':'加入班級'}<ArrowRight size={18}/></Button>
    </form>
  </section>;
}

function NicknameForm({busy,className,onSave}:{busy:boolean;className:string;onSave:(nick:string)=>void}) {
  const [nick,setNick]=useState('');
  const length=[...nick.trim()].length;
  return <section className="class-gate">
    <h1>取一個<em>暱稱</em></h1>
    <p>你在「{className}」的名字，同學看到的就是這個。<strong>請不要用真名。</strong></p>
    <form onSubmit={e=>{e.preventDefault();onSave(nick);}}>
      <input className="class-code-input" value={nick} maxLength={12}
        autoCapitalize="none" autoCorrect="off" placeholder="例如 藍色小海" aria-label="暱稱"
        onChange={e=>setNick(e.target.value)}/>
      <small className="class-hint">{length ? `${length} / 12 字` : '2 到 12 個字，班上不能重複'}</small>
      <Button className="class-big" type="submit" disabled={busy||length<2}>
        {busy?'儲存中…':'開始使用'}<ArrowRight size={18}/></Button>
    </form>
  </section>;
}

function ClassList({rpc,membership}:{rpc:ClassRpc;membership:ClassMembership}) {
  const [filter,setFilter]=useState<Filter>({scope:'class',taskId:null});
  const [cards,setCards]=useState<ClassCard[]|null>(null);
  const [tasks,setTasks]=useState<ClassTask[]>([]);
  const [error,setError]=useState('');
  const [editing,setEditing]=useState<{card:ClassCard|null}|null>(null);
  const [reload,setReload]=useState(0);
  const scopes=visibleScopes(membership);

  useEffect(()=>{listTasks(rpc,membership.class_id).then(setTasks).catch(()=>{});},[rpc,membership.class_id]);
  useEffect(()=>{
    // 切換班級時先清空，免得短暫看到別班的內容
    let live=true;setCards(null);setError('');
    listPrompts(rpc,membership.class_id,filter)
      .then(rows=>{if(live)setCards(rows);})
      .catch(e=>{if(live)setError((e as Error).message);});
    return ()=>{live=false;};
  },[rpc,membership.class_id,filter,reload]);

  if(editing)return <ClassEditor rpc={rpc} membership={membership} tasks={tasks}
    card={editing.card} defaultTaskId={filter.taskId}
    onClose={changed=>{setEditing(null);if(changed)setReload(n=>n+1);}}/>;

  return <section className="prompts-section">
    <div className="class-filters">
      <div className="scope-tabs" role="tablist" aria-label="篩選範圍">
        {scopes.map(s=><button key={s.key} role="tab" aria-selected={filter.scope===s.key}
          className={filter.scope===s.key?'active':''}
          onClick={()=>setFilter(f=>({...f,scope:s.key}))}>{s.label}</button>)}
      </div>
      {tasks.length>0&&<label className="task-picker">任務
        <select value={filter.taskId??''} onChange={e=>setFilter(f=>({...f,taskId:e.target.value||null}))}>
          <option value="">全部任務</option>
          {tasks.map(t=><option key={t.id} value={t.id}>{t.title}{t.closed?'（已截止）':''}</option>)}
        </select></label>}
      <Button className="class-new" onClick={()=>setEditing({card:null})}><Plus size={18}/>寫一個</Button>
    </div>

    {error&&<div className="class-error" role="alert">{error}</div>}
    {cards===null&&!error&&<div className="empty-state"><span className="empty-icon">
      <LoaderCircle size={26} className="spin"/></span><h3>載入中</h3></div>}
    {cards?.length===0&&<div className="empty-state"><span className="empty-icon"><BookOpen size={26}/></span>
      <h3>{filter.scope==='mine'?'你還沒有存過 Prompt':'這裡還沒有東西'}</h3>
      <p>{filter.scope==='mine'?'寫好一個之後存起來，就會出現在這裡。':'等同學開始上傳就會看到。'}</p>
      <Button onClick={()=>setEditing({card:null})}><Plus size={18}/>寫一個</Button></div>}

    {!!cards?.length&&<div className="class-grid">{cards.map(c=>{
      const cover=coverOf(c);
      const texts=c.outputs.filter(o=>o.kind==='text').length;
      const images=c.outputs.filter(o=>o.kind==='image').length;
      return <article className="class-card" key={c.id}>
        <button className="class-card-open" onClick={()=>setEditing({card:c})}
          aria-label={`打開「${c.title}」`}/>
        {cover&&<img className="class-cover" src={cover} alt="" loading="lazy"/>}
        <div className="class-card-top">
          <span className="class-author">{c.author??'（未命名）'}</span>
          {c.team&&<span className="class-team">{c.team}</span>}
          {c.featured&&<span className="class-star" title="老師精選"><Star size={13}/></span>}
        </div>
        <h3>{c.title}</h3>
        <p>{c.summary}</p>
        <div className="class-card-bottom">
          {c.version_no>1&&<span><History size={12}/>V{c.version_no}</span>}
          {images>0&&<span><ImageIcon size={12}/>{images}</span>}
          {texts>0&&<span><MessageSquareText size={12}/>{texts}</span>}
          <span className="class-vars">{c.variables.length?`${c.variables.length} 個變數`:'直接使用'}</span>
        </div>
      </article>;})}</div>}
  </section>;
}
