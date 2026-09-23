-- Apply after 004. Examples are no longer images only: a prompt can also show the file it produced
-- (PDF, Word, Excel, PowerPoint, text, Markdown, CSV, JSON) or the text answer itself.
-- Entries stay in prompt.examples; images and files live in Storage, text lives here.
BEGIN;

-- Accepts one entry: {kind:'image'|'file'|'text', path, name, mime, size, text, caption}.
-- The older (path, caption) signature stays for clients that have not reloaded yet.
CREATE OR REPLACE FUNCTION public.shared_example_save(prompt_id uuid, entry jsonb, remove boolean DEFAULT false)
RETURNS public.prompt LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE p public.prompt; kind text; path text; clean jsonb; ws constant uuid := '00000000-0000-4000-8000-000000000001';
BEGIN
 IF jsonb_typeof(entry) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION '範例格式不正確'; END IF;
 kind := coalesce(entry->>'kind','image');
 path := entry->>'path';
 IF length(coalesce(entry->>'caption','')) > 200 THEN RAISE EXCEPTION '範例說明最多 200 字'; END IF;
 SELECT * INTO p FROM public.prompt WHERE id=prompt_id AND author_id=ws AND deleted_at IS NULL FOR UPDATE;
 IF p.id IS NULL THEN RAISE EXCEPTION '找不到這個 Prompt，請重新整理'; END IF;

 IF remove THEN
  IF path IS NULL AND entry->>'id' IS NULL THEN RAISE EXCEPTION '缺少要移除的範例'; END IF;
  UPDATE public.prompt SET examples=coalesce((SELECT jsonb_agg(e) FROM jsonb_array_elements(examples) e
     WHERE e->>'path' IS DISTINCT FROM path AND (entry->>'id' IS NULL OR e->>'id' IS DISTINCT FROM entry->>'id')),'[]'),
    updated_at=clock_timestamp() WHERE id=p.id RETURNING * INTO p;
  RETURN p;
 END IF;

 IF jsonb_array_length(p.examples) >= 6 THEN RAISE EXCEPTION '每則 Prompt 最多 6 個範例'; END IF;
 IF kind='text' THEN
  IF jsonb_typeof(entry->'text') IS DISTINCT FROM 'string' OR length(btrim(entry->>'text')) NOT BETWEEN 1 AND 8000
   THEN RAISE EXCEPTION '文字範例需為 1 到 8000 字'; END IF;
  clean := jsonb_build_object('id',gen_random_uuid(),'kind','text','text',entry->>'text');
 ELSE
  IF kind='image' THEN
   IF path IS NULL OR path !~ '^[a-f0-9-]{36}/[a-f0-9-]{36}\.(jpg|jpeg|png|webp)$' THEN RAISE EXCEPTION '圖片路徑格式不正確'; END IF;
  ELSIF kind='file' THEN
   IF path IS NULL OR path !~ '^[a-f0-9-]{36}/[a-f0-9-]{36}\.(pdf|docx|xlsx|pptx|txt|md|csv|json)$' THEN RAISE EXCEPTION '檔案路徑格式不正確'; END IF;
   IF length(coalesce(entry->>'name','')) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION '檔名長度不正確'; END IF;
   IF entry->'size' IS NOT NULL AND (jsonb_typeof(entry->'size') <> 'number' OR (entry->>'size')::bigint NOT BETWEEN 1 AND 10485760)
    THEN RAISE EXCEPTION '檔案大小不正確'; END IF;
  ELSE RAISE EXCEPTION '不支援的範例類型'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p.examples) e WHERE e->>'path'=path) THEN RAISE EXCEPTION '這個檔案已經加過了'; END IF;
  clean := jsonb_strip_nulls(jsonb_build_object('id',gen_random_uuid(),'kind',kind,'path',path,
    'name',left(coalesce(entry->>'name',''),120),'mime',left(coalesce(entry->>'mime',''),100),'size',entry->'size'));
 END IF;
 UPDATE public.prompt SET examples=p.examples || jsonb_build_array(
   clean || jsonb_build_object('caption',coalesce(entry->>'caption',''),'added_at',clock_timestamp())),
   updated_at=clock_timestamp() WHERE id=p.id RETURNING * INTO p;
 RETURN p;
END;
$$;
REVOKE ALL ON FUNCTION public.shared_example_save(uuid,jsonb,boolean) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.prompt_library_example(request jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE entry jsonb;
BEGIN
 entry := coalesce(request->'entry', jsonb_build_object('kind','image','path',request->>'path','caption',request->>'caption'));
 RETURN public.shared_prompt_card(public.shared_example_save((request->>'id')::uuid, entry, request->>'op'='example_remove'));
END;
$$;
REVOKE ALL ON FUNCTION public.prompt_library_example(jsonb) FROM PUBLIC,anon,authenticated;

-- Route the two example ops through the new helper; everything else in prompt_library is unchanged.
CREATE OR REPLACE FUNCTION public.prompt_library(request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE op text := request->>'op'; p public.prompt; base public.prompt; item jsonb; result jsonb := '[]';
 cursor_id uuid; event uuid; ids uuid[]; cat uuid; other uuid; n integer; g uuid; keep text[]; c jsonb; i integer;
 ws constant uuid := '00000000-0000-4000-8000-000000000001';
BEGIN
 IF jsonb_typeof(request) IS DISTINCT FROM 'object' OR octet_length(request::text)>2097152 THEN RAISE EXCEPTION '請求格式或大小不正確'; END IF;
 IF op='list' THEN
  cursor_id := nullif(request->>'cursor','')::uuid;
  SELECT coalesce(jsonb_agg(public.shared_prompt_card(t.row) ORDER BY (t.row).id),'[]') INTO result
  FROM (SELECT x AS row FROM public.prompt x WHERE author_id=ws
    AND state='active' AND deleted_at IS NULL AND (cursor_id IS NULL OR id>cursor_id) ORDER BY id LIMIT 200) t;
  RETURN result;
 ELSIF op='stamp' THEN
  RETURN jsonb_build_object(
   'prompts',(SELECT jsonb_build_array(count(*) FILTER (WHERE deleted_at IS NULL),max(updated_at)) FROM public.prompt WHERE author_id=ws),
   'categories',(SELECT max(updated_at) FROM public.category));
 ELSIF op='categories' THEN
  RETURN public.shared_categories();
 ELSIF op='categories_save' THEN
  IF jsonb_typeof(request->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(request->'items') NOT BETWEEN 1 AND 60 THEN RAISE EXCEPTION '分類數量需介於 1 到 60'; END IF;
  SELECT id INTO other FROM public.category WHERE slug='other';
  keep := ARRAY[]::text[]; i := 0;
  FOR c IN SELECT value FROM jsonb_array_elements(request->'items') LOOP
   IF jsonb_typeof(c->'name') IS DISTINCT FROM 'string' OR length(btrim(c->>'name')) NOT BETWEEN 1 AND 30 OR btrim(c->>'name') ~ '[\r\n]' THEN RAISE EXCEPTION '分類名稱需為 1 到 30 字'; END IF;
   IF btrim(c->>'name') = ANY(keep) THEN RAISE EXCEPTION '分類名稱重複：%', btrim(c->>'name'); END IF;
   keep := array_append(keep, btrim(c->>'name'));
  END LOOP;
  UPDATE public.prompt SET category_id=other, updated_at=clock_timestamp()
   WHERE author_id=ws AND category_id IN (SELECT id FROM public.category WHERE archived_at IS NULL AND parent_id IS NULL AND slug<>'other'
     AND name NOT IN (SELECT coalesce(nullif(x->>'from',''),btrim(x->>'name')) FROM jsonb_array_elements(request->'items') x));
  UPDATE public.category SET archived_at=clock_timestamp(), updated_at=clock_timestamp()
   WHERE archived_at IS NULL AND parent_id IS NULL AND slug<>'other'
     AND name NOT IN (SELECT coalesce(nullif(x->>'from',''),btrim(x->>'name')) FROM jsonb_array_elements(request->'items') x);
  FOR c IN SELECT value FROM jsonb_array_elements(request->'items') LOOP
   i := i + 1;
   SELECT id INTO cat FROM public.category WHERE archived_at IS NULL AND parent_id IS NULL AND name=coalesce(nullif(c->>'from',''),btrim(c->>'name')) ORDER BY sort_order LIMIT 1;
   IF cat IS NULL THEN
    SELECT id INTO cat FROM public.category WHERE archived_at IS NOT NULL AND parent_id IS NULL AND name=btrim(c->>'name') ORDER BY sort_order LIMIT 1;
    IF cat IS NULL THEN
     INSERT INTO public.category(name,slug,sort_order) VALUES(btrim(c->>'name'),'c-'||replace(gen_random_uuid()::text,'-',''),i) RETURNING id INTO cat;
    END IF;
   END IF;
   UPDATE public.category SET name=CASE WHEN slug='other' THEN name ELSE btrim(c->>'name') END,
     sort_order=CASE WHEN slug='other' THEN 999 ELSE i END, archived_at=NULL, updated_at=clock_timestamp() WHERE id=cat;
  END LOOP;
  UPDATE public.category SET updated_at=clock_timestamp() WHERE id=other;
  RETURN public.shared_categories();
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
 ELSIF op='example_add' OR op='example_remove' THEN
  RETURN public.prompt_library_example(request);
 ELSIF op='version' THEN
  SELECT * INTO base FROM public.prompt WHERE id=(request->>'id')::uuid AND author_id=ws AND deleted_at IS NULL;
  IF base.id IS NULL THEN RAISE EXCEPTION '找不到原本的 Prompt，請重新整理'; END IF;
  g := coalesce(base.group_id,base.id);
  p := public.shared_prompt_save(request->'item');
  IF p.created_at <> now() OR p.id = base.id THEN RAISE EXCEPTION '新版本內容和既有 Prompt 相同，請修改後再存'; END IF;
  SELECT coalesce(max(version_no),0)+1 INTO n FROM public.prompt WHERE author_id=ws AND deleted_at IS NULL AND coalesce(group_id,id)=g;
  UPDATE public.prompt SET group_id=g WHERE id=base.id AND group_id IS NULL;
  UPDATE public.prompt SET group_id=g, version_no=n, fork_of=base.id WHERE id=p.id RETURNING * INTO p;
  RETURN public.shared_prompt_card(p);
 ELSIF op='merge' THEN
  ids := public.shared_uuid_list(request->'ids');
  IF array_length(ids,1) < 2 THEN RAISE EXCEPTION '請至少選擇兩則 Prompt'; END IF;
  IF (SELECT count(*) FROM public.prompt WHERE id=ANY(ids) AND author_id=ws AND deleted_at IS NULL) <> (SELECT count(DISTINCT x) FROM unnest(ids) x) THEN RAISE EXCEPTION '部分 Prompt 已被修改或刪除，請重新整理'; END IF;
  g := ids[1];
  FOR i IN 1..array_length(ids,1) LOOP
   UPDATE public.prompt SET group_id=g, version_no=i, updated_at=clock_timestamp() WHERE id=ids[i];
  END LOOP;
  RETURN jsonb_build_object('merged',array_length(ids,1),'group_id',g);
 ELSIF op='move' THEN
  ids := public.shared_uuid_list(request->'ids');
  SELECT id INTO cat FROM public.category WHERE name=request->>'category' AND archived_at IS NULL AND parent_id IS NULL LIMIT 1;
  IF cat IS NULL THEN RAISE EXCEPTION '分類不存在，請重新整理後再試'; END IF;
  UPDATE public.prompt SET category_id=cat, updated_at=clock_timestamp() WHERE id=ANY(ids) AND author_id=ws AND deleted_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('moved',n);
 ELSIF op='delete_many' THEN
  ids := public.shared_uuid_list(request->'ids');
  UPDATE public.prompt SET deleted_at=clock_timestamp(), updated_at=clock_timestamp() WHERE id=ANY(ids) AND author_id=ws AND deleted_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('deleted',n);
 ELSIF op='delete' THEN
  UPDATE public.prompt SET deleted_at=clock_timestamp(),updated_at=clock_timestamp()
   WHERE id=(request->>'id')::uuid AND author_id=ws
   AND deleted_at IS NULL AND updated_at=(request->>'version')::timestamptz RETURNING * INTO p;
  IF p.id IS NULL THEN RAISE EXCEPTION '資料已被修改或刪除，請重新載入後再試'; END IF;
  RETURN jsonb_build_object('deleted',true,'id',p.id);
 ELSIF op='use' THEN
  event := (request->>'event')::uuid;
  SELECT * INTO p FROM public.prompt WHERE id=(request->>'id')::uuid
   AND author_id=ws AND deleted_at IS NULL FOR UPDATE;
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
DROP FUNCTION IF EXISTS public.shared_example_save(uuid,text,text,boolean);
INSERT INTO public.schema_migration(version) VALUES(5) ON CONFLICT DO NOTHING;
NOTIFY pgrst, 'reload schema';
COMMIT;
