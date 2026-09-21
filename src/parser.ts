export type Parsed = { body: string; source: string };
export function parseInput(input: string, filename = '貼上文字'): Parsed[] {
  if (new TextEncoder().encode(input).byteLength > 10 * 1024 * 1024) throw new Error('匯入檔案超過 10 MB');
  const clean = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const items: Parsed[] = [];
  function add(body: unknown, source: string) {
    if (typeof body !== 'string' || body.trim().length < 20) return;
    if (body.length > 24000) throw new Error('單則 prompt 超過 24,000 字，請先切分');
    items.push({ body: body.trim(), source });
    if (items.length > 500) throw new Error('每批最多匯入 500 則');
  }
  function json(value: unknown, path: string) {
    if (Array.isArray(value)) { value.forEach((v,i) => json(v, `${path}[${i}]`)); return; }
    if (typeof value === 'string') { add(value, path); return; }
    if (!value || typeof value !== 'object') return;
    const o = value as Record<string, any>;
    if (o.mapping && typeof o.mapping === 'object') {
      // Export includes branches; retain only the active ancestry when current_node is supplied.
      let nodes: any[] = Object.values(o.mapping);
      if (o.current_node) {
        nodes = []; let id = o.current_node; const visited = new Set();
        while (id && o.mapping[id] && !visited.has(id)) { visited.add(id); nodes.unshift(o.mapping[id]); id = o.mapping[id].parent; }
      }
      for (const n of nodes) if (n?.message?.author?.role === 'user') add(n.message.content?.parts?.filter((v: unknown) => typeof v === 'string').join('\n'), `${path}:ChatGPT:${n.id ?? ''}`);
      return;
    }
    if (Array.isArray(o.chat_messages)) {
      for (const m of o.chat_messages) if (m.sender === 'human') {
        const body = typeof m.text === 'string' && m.text ? m.text : (m.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
        add(body, `${path}:Claude:${m.uuid ?? ''}`);
      }
      return;
    }
    if (Array.isArray(o.conversations)) { json(o.conversations, path + ':conversations'); return; }
    if (Array.isArray(o.prompts)) { json(o.prompts, path + ':prompts'); return; }
    add(o.body ?? o.prompt ?? o.text, path);
  }
  if (/\.json$/i.test(filename) || /^[\[{]/.test(clean.trim())) {
    let value: unknown;
    try { value = JSON.parse(clean); } catch { throw new Error('JSON 格式錯誤，未匯入任何資料'); }
    json(value, filename);
  } else {
    let buffer: string[] = [], fence: string | null = null;
    const flush = () => { add(buffer.join('\n'), filename); buffer = []; };
    for (const line of clean.split('\n')) {
      const match = line.match(/^\s*(`{3,}|~{3,})/);
      if (match) {
        if (!fence) fence = match[1][0]; else if (fence === match[1][0]) fence = null;
        buffer.push(line); continue;
      }
      if (!fence && /^\s*---+\s*$/.test(line)) { flush(); continue; }
      buffer.push(line);
    }
    flush();
  }
  return items;
}
