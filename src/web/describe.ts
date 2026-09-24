import type {Variable} from '../domain.ts';

// 產生「這個 Prompt 在做什麼」的一句說明，完全用規則，不呼叫 AI，所以匯入 100 則也是零成本。
// 使用者只要自己填過，就不會被蓋掉（summary_auto 旗標）。
const ACTION=/(請|幫我|幫你|讓|把|寫|做|列出|整理|分析|翻譯|潤飾|改寫|畫|生成|製作|設計|規劃|找出|檢查|解釋|教|出題|摘要|轉成|create|write|draw|make|generate|design|analy[sz]|explain|summar|translat|review|plan|turn|convert)/i;
const ROLE=/^(你是|妳是|假設你|扮演|作為|身為|as an?\b|you are\b|act as\b|i want you to\b)/i;
const FORMATS:[RegExp,string][]=[[/表格|table|matrix|矩陣/i,'表格'],[/\bjson\b/i,'JSON'],[/條列|bullet|重點/i,'條列重點'],
 [/大綱|outline/i,'大綱'],[/markdown/i,'Markdown'],[/簡報|slide|投影片|deck/i,'簡報'],[/清單|checklist/i,'清單'],
 [/腳本|script/i,'腳本'],[/程式碼|code\b/i,'程式碼'],[/插畫|照片|圖片|image|illustration|photo|artwork/i,'圖片']];
const LABELS:[RegExp,string][]=[[/選擇題/,'選擇題'],[/填充題|填空/,'填充題'],[/問答題/,'問答題'],[/是非題/,'是非題'],
 [/詞庫/,'詞庫'],[/干擾詞|誘答/,'干擾詞'],[/答案/,'答案'],[/詳解|解析/,'詳解'],[/配分|分數|總分/,'配分'],[/題數/,'題數'],
 [/難度/,'難度'],[/教材|課文/,'教材'],[/範例/,'範例'],[/格式/,'格式']];

const chars=(s:string)=>[...s];
const cut=(s:string,n:number)=>chars(s).length<=n?s:chars(s).slice(0,n).join('')+'…';
const clean=(s:string)=>s.replace(/\{\{([^{}]+)\}\}/g,'$1').replace(/^[#>\-*•\s]+|^\d+[.、)）]\s*/g,'').replace(/\s+/g,' ').trim();
const bare=(s:string)=>s.replace(/[\s，。、：:；;（）()「」【】\-—·.]/g,'').toLowerCase();

/** 沒有完整句子的表單型 prompt（題目卷、模板），改成列出它包含的項目。 */
function outline(body:string):string{
  const found=LABELS.filter(([re])=>re.test(body)).map(([,label])=>label);
  return found.length>=2?`${found.slice(0,5).join('、')}${found.length>5?' 等':''}的模板`:'';
}

export function describe(body:string,options:{title?:string;variables?:Variable[]}={}):string{
  const text=String(body??'');
  if(!text.trim())return '';
  const lines=text.split('\n').map(clean).filter(Boolean);
  const sentences=lines.flatMap(line=>line.split(/(?<=[。！？!?；;])/).map(clean)).filter(Boolean);
  const usable=sentences.filter(s=>!ROLE.test(s)&&chars(s).length>=8);
  let core=usable.find(s=>ACTION.test(s))??usable[0]??'';
  core=core.replace(/^(請|麻煩你?|幫我|幫你)/,'').replace(/[。．.、，]$/,'').trim();

  const head=clean(options.title??'').replace(/（[^）]*）|\([^)]*\)/g,'').replace(/^\d+\.\s*/,'').replace(/[：:｜|]\s*$/,'').trim();
  // 標題本身就是內文開頭（像 /verify 這種斜線指令）時，不要再重複貼一次
  const firstLine=lines[0]??'';
  const titleEchoesBody=!!firstLine&&(bare(head).includes(bare(firstLine))||bare(firstLine).includes(bare(head)));
  let result=core?cut(core,40):'';
  if(!result){
    // 表單型或太短：先試著列出內容項目，再退回開頭文字
    result=outline(text)||cut(lines.join('｜'),40);
    if(head&&bare(result).startsWith(bare(head))) result=result.slice(head.length).replace(/^[：:｜|\s]+/,'')||result;
  }
  // 標題若不是內文的一部分，放前面當提示；重複的話就不加
  const repetitive=(()=>{const parts=result.split(/[：:，,、]/).map(bare).filter(Boolean);
    return parts.length>1&&new Set(parts).size<parts.length;})();
  if(!result||repetitive||chars(result).length<6){
    // 幾乎只有變數的模板：用標題加上要填的欄位來說明
    result=head||cut(lines.join('｜'),40);
  } else if(head&&!titleEchoesBody&&chars(head).length<=16
      &&!bare(result).includes(bare(head))&&!bare(head).includes(bare(result))){
    result=`${head}：${result}`;
  }

  const format=FORMATS.find(([re])=>re.test(text));
  if(format&&!result.includes(format[1]))result+=`，輸出${format[1]}`;
  const names=(options.variables??[]).map(v=>(v.label||v.name).replace(/（[^）]*）/g,'').trim()).filter(Boolean);
  if(names.length)result+=`（可填：${names.slice(0,3).join('、')}${names.length>3?' 等':''}）`;
  return cut(result.replace(/\s+/g,' ').replace(/^[：:、，,｜|\s]+/,'').trim(),90);
}

/** 使用者留白時才自動產生；有寫過就原樣保留。 */
type Describable={body:string;title?:string;summary?:string;variables?:Variable[];summary_auto?:boolean};
export function withDescription<T extends Describable>(item:T):T&{summary:string;summary_auto:boolean}{
  const written=(item.summary??'').trim();
  if(written&&!item.summary_auto)return {...item,summary:written,summary_auto:false};
  const auto=describe(item.body,{title:item.title,variables:item.variables});
  return {...item,summary:auto||written,summary_auto:!!auto};
}
