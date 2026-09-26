import type {Metadata,Viewport} from 'next';
import './globals.css';
export const metadata:Metadata={title:'Fairy Prompt — 把好用的靈感，變成日常',description:'找回你的 Prompt，填入變數，一鍵開始創作。',applicationName:'Fairy Prompt',robots:'noai, noimageai',appleWebApp:{capable:true,statusBarStyle:'default',title:'Fairy Prompt'},icons:{icon:(process.env.NEXT_PUBLIC_BASE_PATH??'')+'/icon.svg',apple:(process.env.NEXT_PUBLIC_BASE_PATH??'')+'/icon-192.png'}};
// viewportFit:'cover' 讓版面延伸到瀏海／動態島與底部指示條下方，
// 真正的留白交給 CSS 的 env(safe-area-inset-*) 處理。不關掉使用者縮放。
export const viewport:Viewport={width:'device-width',initialScale:1,viewportFit:'cover',themeColor:'#24584b'};
export default function Layout({children}:{children:React.ReactNode}) {return <html lang="zh-Hant"><body>{children}</body></html>;}
