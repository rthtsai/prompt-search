'use client';
// 班級版（ai-class-lab）的進入點。只有 pnpm pages:build:class 會把它接上，
// 原版 prompt-search 的建置完全不會碰到這個檔案。
import {useEffect,useState} from 'react';
import {BookOpen,LoaderCircle} from 'lucide-react';

export default function ClassApp() {
  const [ready,setReady]=useState(false);
  useEffect(()=>{setReady(true);},[]);
  return <div className="app-shell">
    <main className="main-content" id="main-content">
      <section className="hero"><div className="hero-copy">
        <div className="section-eyebrow"><span className="eyebrow-line"/>AI CLASS LAB</div>
        <h1>AI 課 <em>Prompt 實驗室</em></h1>
        <p>用你的 Google 帳號登入，輸入班級代碼加入班級。</p>
      </div></section>
      <section className="prompts-section">
        <div className="empty-state"><span className="empty-icon">{ready?<BookOpen size={28}/>:<LoaderCircle size={28} className="spin"/>}</span>
          <h3>建置中</h3><p>登入與班級功能正在施工（9/25 完成）。</p></div>
      </section>
    </main>
  </div>;
}
