import type {Variable} from '../domain.ts';

// 把寫好的 prompt 降級成「新手真的會打出來的那種問法」，全部用規則，不呼叫 AI。
// 用途是教學：同一件事，V1 這樣問、V2 那樣問，差別直接看得到。
const ROLE=/^(你是|妳是|假設你|扮演|作為|身為|as an?\b|you are\b|act as\b|i want you to\b)/i;
// 交代輸出長什麼樣的句子——降級時第一個拿掉，因為這是新手最常漏的
const FORMAT=/(輸出格式|請輸出|輸出|格式|表格|條列|清單|json|markdown|分成.{0,4}段|列成|整理成|請給我|回覆時|附上|各附|並註明)/i;
// 限制與驗收——新手第二常漏的
const RULE=/(規則|限制|不要|避免|不得|必須|請勿|只根據|不可|標明|註明|禁止|如果.{0,10}請)/;
const STRUCTURE=/^(\d+[.、)）]|[-*•]|第[一二三四五六七八九十]+[、.]|\||#{1,6}\s)/;
// 「事件：{{事件}}」這種標籤列拆掉之後什麼都不剩，不能拿來當降級後的內文
const LABEL=/^.{1,8}[：:]\s*\S{0,12}$/;
// 數字連著量詞一起換，不然「三個重點」會變成「一些個重點」
const COUNT=/[0-9０-９]+|[一二三四五六七八九十]+/g;
const COUNTED=/([0-9０-９]+|[一二三四五六七八九十]+)\s*(?=[題個項段字份條點張])/g;
// 新手 prompt 常見的結尾，本身就是反面教材
const OPENER=/^(請|麻煩你?|幫我|幫你|我要|我想|我需要|想請你|可以幫我|please\s+|kindly\s+)/i;
const FIRST_PERSON=/^(我|以下是|這是|事件[:：])/;
const PADDING=['越詳細越好','盡量完整一點','寫得專業一點','謝謝','幫我用最好的方式寫'];

const chars=(s:string)=>[...s];
const clean=(s:string)=>s.replace(/^[#>\-*•\s]+|^\d+[.、)）]\s*/g,'').replace(/\s+/g,' ').trim();

/** 變數是「把需求講清楚」的產物，新手版本不會有，所以換成模糊的指稱。 */
function blurPlaceholders(text:string,variables:Variable[]):string{
  return text.replace(/\{\{([^{}]+)\}\}/g,(_,name:string)=>{
    const v=variables.find(x=>x.name===name);
    const label=(v?.label||name).trim();
    return /教材|課文|逐字稿|文章|內容|資料|稿/.test(label)?'這份資料'
      : /公司|品牌|商品|產品/.test(label)?'這個東西'
      : /期間|時間|日期/.test(label)?'最近'
      : /主題|題目|事件|流程/.test(label)?'這件事'
      : '這個部分';
  });
}

export function weaken(body:string,options:{title?:string;variables?:Variable[]}={}):string{
  const variables=options.variables??[];
  const lines=String(body??'').split('\n').map(clean).filter(Boolean);
  // 條列、表格、標題那些結構全部丟掉——新手不會分段交代
  const prose=lines.filter(line=>!STRUCTURE.test(line)&&!LABEL.test(line));
  const sentences=prose.flatMap(l=>l.split(/(?<=[。！？；;])|(?<=[a-z0-9)\]"'][a-z0-9)\]"'][.!?])\s+(?=["'(A-Z])/))
    .map(clean).filter(Boolean);
  // 角色、格式、限制三種句子都拿掉，剩下的才是「光禿禿的任務」
  const bare=sentences.filter(s=>!ROLE.test(s)&&!FORMAT.test(s)&&!RULE.test(s));
  let core=bare[0]??sentences.find(s=>!ROLE.test(s))??clean(options.title??'')??'';
  // 同一句裡若前半是任務、後半才交代格式（「精簡成三個重點，並整理成表格」），只留前半
  core=core.split(/[，,]/).filter((part,i)=>i===0||!FORMAT.test(part)).join('，');
  // 數字先模糊化，再換掉變數——順序反過來會把代換進去的字也當成數字（「一下」→「一些下」）
  core=core.replace(COUNTED,'幾').replace(COUNT,'一些');
  core=blurPlaceholders(core,variables).replace(/[。．.、，,：:；;]+$/,'').trim();
  // 開頭的客套話可能疊好幾層（「請幫我…」），一層一層剝掉
  for(let before='';before!==core;){before=core;core=core.replace(OPENER,'').trim();}
  // 代換後可能出現「做「這件事」這件事」這種疊字
  core=core.replace(/(這件事|這個東西|這份資料)(「?\1」?)+/g,'$1').replace(/「(這件事|這個東西|這份資料)」\1/g,'$1');
  if([...core].length<8)core=`看一下${clean(options.title??'這個')}`;

  // 本來就是第一人稱敘述（「我每次都要…」）就別再加「幫我」，那會變成「幫我我每次…」
  let result=FIRST_PERSON.test(core)?core:`幫我${core}`;
  // 資料庫要求內文至少 20 字；不夠長就補上新手真的會寫的那種結尾
  for(const tail of PADDING){
    if(chars(result).length>=24)break;
    result+=`，${tail}`;
  }
  return result.replace(/\s+/g,'').slice(0,400);
}

/** 降級時拆掉了哪些東西——拿來寫版本說明，讓學生知道差在哪。 */
export function whatWasLost(body:string):string[]{
  const lines=String(body??'').split('\n').map(clean).filter(Boolean);
  const lost:string[]=[];
  if(lines.some(l=>ROLE.test(l)))lost.push('角色設定');
  if(lines.some(l=>FORMAT.test(l)))lost.push('輸出格式');
  if(lines.some(l=>STRUCTURE.test(l)))lost.push('分段交代的步驟');
  if(lines.some(l=>RULE.test(l)))lost.push('限制與驗收條件');
  if(/\{\{[^{}]+\}\}/.test(body))lost.push('可替換的變數');
  return lost;
}
