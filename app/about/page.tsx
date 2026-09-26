import type {Metadata} from 'next';

export const metadata:Metadata={title:'關於我們 — Fairy Prompt'};

export default function About(){
  const base=process.env.NEXT_PUBLIC_BASE_PATH??'';
  return <main className="about-page">
    <img className="about-logo" src={base+'/logo-full.png'} alt="Fairy Prompt — Fairy × Genius" width={380} height={106}/>
    <h1>關於我們</h1>
    <p className="about-line">Fairy Prompt 由 Fairy 與 Genius 共同創辦。</p>
    <h2 className="about-sub">使用條款</h2>
    <p className="about-terms">站上的 Prompt 歡迎個人複製使用。請勿以程式或爬蟲大量擷取、重新發布，或用於訓練 AI 模型。內容著作權屬原作者與 Fairy Prompt 所有。</p>
    <a className="about-back" href={base+'/'}>回到 Fairy Prompt</a>
  </main>;
}
