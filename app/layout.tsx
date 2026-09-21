import type {Metadata,Viewport} from 'next';
import './globals.css';
export const metadata:Metadata={title:'Prompt 辭典 — 把好用的靈感，變成日常',description:'找回你的 Prompt，填入變數，一鍵開始創作。',applicationName:'Prompt 辭典',appleWebApp:{capable:true,statusBarStyle:'default',title:'Prompt 辭典'},icons:{icon:(process.env.NEXT_PUBLIC_BASE_PATH??'')+'/icon.svg',apple:(process.env.NEXT_PUBLIC_BASE_PATH??'')+'/icon-192.png'}};
export const viewport:Viewport={width:'device-width',initialScale:1,themeColor:'#24584b'};
export default function Layout({children}:{children:React.ReactNode}) {return <html lang="zh-Hant"><body>{children}</body></html>;}
