import type {Metadata} from 'next';

export const metadata:Metadata={title:'關於我們 — Fairy Prompt'};

export default function About(){
  const base=process.env.NEXT_PUBLIC_BASE_PATH??'';
  return <main className="about-page">
    <img className="about-logo" src={base+'/logo-full.png'} alt="Fairy Prompt — Fairy × Genius" width={380} height={106}/>
    <h1>關於我們</h1>
    <p className="about-line">Fairy Prompt 由 Fairy 與 Genius 共同創辦。</p>
    <a className="about-back" href={base+'/'}>回到 Fairy Prompt</a>
  </main>;
}
