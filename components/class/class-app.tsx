'use client';
// 班級版（ai-class-lab）的進入點。只有 pages:build:class 會把它接上，
// 原版 prompt-search 的建置完全不會碰到這個檔案。
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {BookOpen,LoaderCircle,LogIn,LogOut,ArrowRight,Clock3,RefreshCw} from 'lucide-react';
import {Button} from '../ui/button';
import '../../app/class.css';
import {createClassSession} from '../../src/web/class-session';
import {classStage,createClassRpc,fetchMe,joinClass,setNickname,
  rememberClass,rememberedClass,type Me,type Stage} from '../../src/web/class-store';

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

      {stage.kind==='ready'&&<section className="prompts-section">
        <div className="empty-state"><span className="empty-icon"><BookOpen size={28}/></span>
          <h3>{stage.membership.nickname}，準備好了</h3>
          <p>列表、任務與比較頁施工中（9/26–9/27）。</p>
          {stage.others.length>0&&<div className="class-switch">
            {stage.others.map(c=><button key={c.class_id} className="text-link"
              onClick={()=>choose(c.class_id)}>切換到 {c.name}<ArrowRight size={13}/></button>)}
          </div>}
        </div></section>}
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
