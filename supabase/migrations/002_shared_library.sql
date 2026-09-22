-- Apply after the existing v1 schema (or ../001_fresh_project.sql on a fresh project).
-- Only this dedicated shared workspace is exposed; unrelated private rows stay private.
BEGIN;
ALTER TABLE public.prompt ALTER COLUMN embedding DROP NOT NULL;
ALTER TABLE public.prompt ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.prompt ADD COLUMN IF NOT EXISTS last_used timestamptz;
INSERT INTO public.app_user(id,handle,display_name)
VALUES ('00000000-0000-4000-8000-000000000001','prompt-search-shared','共用 Prompt 辭典')
ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS public.shared_usage_event (
 id uuid PRIMARY KEY, prompt_id uuid NOT NULL REFERENCES public.prompt(id), created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.shared_usage_event ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shared_usage_event FROM PUBLIC, anon, authenticated;
-- No direct table writes from a browser. Validated RPC is the only write surface.
REVOKE ALL ON public.prompt, public.app_user, public.usage_log, public.unlock FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.shared_prompt_card(p public.prompt) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
 SELECT jsonb_build_object('id',p.id,'title',p.title,'body',p.body,'summary',p.summary,
 'category',(SELECT name FROM public.category WHERE id=p.category_id),'tags',p.tags,
 'variables',p.variables,'model_hint',p.model_hint,'use_count',p.use_count,'last_used',p.last_used,
 'source',p.source,'fork_of',p.fork_of,'updated_at',p.updated_at);
$$;
REVOKE ALL ON FUNCTION public.shared_prompt_card(public.prompt) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.shared_prompt_save(item jsonb, editing_id uuid DEFAULT NULL, expected_version timestamptz DEFAULT NULL)
RETURNS public.prompt LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE p public.prompt; cat uuid; h text; v jsonb; names text[]; placeholders text[];
BEGIN
 IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR jsonb_typeof(item->'body') IS DISTINCT FROM 'string'
 OR length(item->>'body') NOT BETWEEN 20 AND 24000 OR length(btrim(item->>'title')) NOT BETWEEN 1 AND 160
 OR jsonb_typeof(item->'title') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'summary') IS DISTINCT FROM 'string'
 OR length(item->>'summary') > 2000 OR jsonb_typeof(item->'variables') IS DISTINCT FROM 'array'
 OR jsonb_typeof(item->'tags') IS DISTINCT FROM 'array' OR jsonb_typeof(item->'model_hint') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'Prompt 格式或長度不正確'; END IF;
 IF jsonb_array_length(item->'variables') > 40 OR jsonb_array_length(item->'tags') > 20
 OR jsonb_array_length(item->'model_hint') > 20 THEN RAISE EXCEPTION '欄位數量過多'; END IF;
 FOR v IN SELECT value FROM jsonb_array_elements((item->'tags') || (item->'model_hint')) LOOP
  IF jsonb_typeof(v) <> 'string' OR length(v#>>'{}') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION '標籤格式錯誤'; END IF;
 END LOOP;
 names := ARRAY[]::text[];
 FOR v IN SELECT value FROM jsonb_array_elements(item->'variables') LOOP
  IF jsonb_typeof(v) <> 'object' OR jsonb_typeof(v->'name') IS DISTINCT FROM 'string'
  OR length(v->>'name') NOT BETWEEN 1 AND 60 OR v->>'name' ~ '[{}\r\n]'
  OR jsonb_typeof(v->'label') IS DISTINCT FROM 'string' OR jsonb_typeof(v->'example') IS DISTINCT FROM 'string'
  OR jsonb_typeof(v->'required') IS DISTINCT FROM 'boolean' OR v->>'name'=ANY(names)
  THEN RAISE EXCEPTION '變數格式錯誤或重複'; END IF;
  names := array_append(names,v->>'name');
 END LOOP;
 SELECT coalesce(array_agg(DISTINCT m[1]),ARRAY[]::text[]) INTO placeholders
 FROM regexp_matches(item->>'body','\{\{([^{}]+)\}\}','g') AS m;
 IF NOT (names @> placeholders AND names <@ placeholders) THEN RAISE EXCEPTION '本文與變數不一致'; END IF;
 SELECT id INTO cat FROM public.category WHERE name=item->>'category' ORDER BY id LIMIT 1;
 IF cat IS NULL THEN RAISE EXCEPTION '分類不存在'; END IF;
 -- Server-authoritative normalization and unique key make concurrent imports idempotent.
 h := encode(sha256(convert_to(lower(regexp_replace(normalize(item->>'body',NFKC),'[[:space:]]','','g')),'UTF8')),'hex');
 IF editing_id IS NULL THEN
  INSERT INTO public.prompt(title,body,summary,use_case,model_hint,variables,tags,category_id,lang,
    visibility,author_id,source,source_body,embedding,embedding_model,normalized_hash,simhash,search_text)
  VALUES(btrim(item->>'title'),item->>'body',item->>'summary',btrim(item->>'title'),
    ARRAY(SELECT jsonb_array_elements_text(item->'model_hint')),item->'variables',
    ARRAY(SELECT jsonb_array_elements_text(item->'tags')),cat,'zh-Hant','public',
    '00000000-0000-4000-8000-000000000001',left(coalesce(item->>'source','雲端匯入'),2000),item->>'body',
    NULL,'not-generated',h,'0000000000000000','')
  ON CONFLICT(author_id,normalized_hash) DO NOTHING RETURNING * INTO p;
  IF p.id IS NULL THEN
   SELECT * INTO p FROM public.prompt WHERE author_id='00000000-0000-4000-8000-000000000001' AND normalized_hash=h;
   IF p.deleted_at IS NOT NULL THEN RAISE EXCEPTION '相同內容已刪除；請先修改內容再加入（本機資料會保留）'; END IF;
  END IF;
 ELSE
  UPDATE public.prompt SET title=btrim(item->>'title'),body=item->>'body',summary=item->>'summary',
    use_case=btrim(item->>'title'),model_hint=ARRAY(SELECT jsonb_array_elements_text(item->'model_hint')),
    variables=item->'variables',tags=ARRAY(SELECT jsonb_array_elements_text(item->'tags')),category_id=cat,
    source_body=item->>'body',normalized_hash=h,embedding=NULL,embedding_model='not-generated',
    simhash='0000000000000000',updated_at=clock_timestamp()
  WHERE id=editing_id AND author_id='00000000-0000-4000-8000-000000000001'
    AND deleted_at IS NULL AND updated_at=expected_version RETURNING * INTO p;
  IF p.id IS NULL THEN RAISE EXCEPTION '資料已被修改或刪除，請重新載入後再試'; END IF;
 END IF;
 RETURN p;
END;
$$;
REVOKE ALL ON FUNCTION public.shared_prompt_save(jsonb,uuid,timestamptz) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.prompt_library(request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE op text := request->>'op'; p public.prompt; item jsonb; result jsonb := '[]'; cursor_id uuid; event uuid;
BEGIN
 IF jsonb_typeof(request) IS DISTINCT FROM 'object' OR octet_length(request::text)>2097152 THEN RAISE EXCEPTION '請求格式或大小不正確'; END IF;
 IF op='list' THEN
  cursor_id := nullif(request->>'cursor','')::uuid;
  SELECT coalesce(jsonb_agg(public.shared_prompt_card(t.row) ORDER BY (t.row).id),'[]') INTO result
  FROM (SELECT x AS row FROM public.prompt x WHERE author_id='00000000-0000-4000-8000-000000000001'
    AND state='active' AND deleted_at IS NULL AND (cursor_id IS NULL OR id>cursor_id) ORDER BY id LIMIT 200) t;
  RETURN result;
 ELSIF op='import' THEN
  IF jsonb_typeof(request->'items') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION '缺少匯入資料'; END IF;
  IF jsonb_array_length(request->'items') NOT BETWEEN 1 AND 25 THEN RAISE EXCEPTION '每次上傳最多 25 則'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(request->'items') LOOP
   p := public.shared_prompt_save(item);
   result := result || jsonb_build_array(public.shared_prompt_card(p));
  END LOOP;
  RETURN result;
 ELSIF op='edit' THEN
  p := public.shared_prompt_save(request->'item',(request->>'id')::uuid,(request->>'version')::timestamptz);
  RETURN public.shared_prompt_card(p);
 ELSIF op='delete' THEN
  UPDATE public.prompt SET deleted_at=clock_timestamp(),updated_at=clock_timestamp()
   WHERE id=(request->>'id')::uuid AND author_id='00000000-0000-4000-8000-000000000001'
   AND deleted_at IS NULL AND updated_at=(request->>'version')::timestamptz RETURNING * INTO p;
  IF p.id IS NULL THEN RAISE EXCEPTION '資料已被修改或刪除，請重新載入後再試'; END IF;
  RETURN jsonb_build_object('deleted',true,'id',p.id);
 ELSIF op='use' THEN
  event := (request->>'event')::uuid;
  SELECT * INTO p FROM public.prompt WHERE id=(request->>'id')::uuid
   AND author_id='00000000-0000-4000-8000-000000000001' AND deleted_at IS NULL FOR UPDATE;
  IF p.id IS NULL THEN RAISE EXCEPTION '找不到這個 Prompt'; END IF;
  INSERT INTO public.shared_usage_event(id,prompt_id) VALUES(event,p.id) ON CONFLICT(id) DO NOTHING;
  IF FOUND THEN UPDATE public.prompt SET use_count=use_count+1,last_used=clock_timestamp() WHERE id=p.id RETURNING * INTO p; END IF;
  RETURN public.shared_prompt_card(p);
 END IF;
 RAISE EXCEPTION '不支援的操作';
END;
$$;
REVOKE ALL ON FUNCTION public.prompt_library(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prompt_library(jsonb) TO anon,authenticated;
INSERT INTO public.schema_migration(version) VALUES(2) ON CONFLICT DO NOTHING;
NOTIFY pgrst, 'reload schema';
COMMIT;
