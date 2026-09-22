-- Apply after 002_shared_library.sql.
-- Adds: prompt versions (group_id/version_no), English body, editable/ordered categories,
-- typed variables (text/select/radio/number), bulk move/delete/merge, and a cheap change stamp.
BEGIN;
ALTER TABLE public.prompt ADD COLUMN IF NOT EXISTS group_id uuid;
ALTER TABLE public.prompt ADD COLUMN IF NOT EXISTS version_no integer NOT NULL DEFAULT 1 CHECK(version_no >= 1);
ALTER TABLE public.prompt ADD COLUMN IF NOT EXISTS version_note text NOT NULL DEFAULT '';
ALTER TABLE public.prompt ADD COLUMN IF NOT EXISTS body_en text CHECK(body_en IS NULL OR length(body_en) BETWEEN 20 AND 24000);
CREATE INDEX IF NOT EXISTS prompt_group ON public.prompt(group_id) WHERE group_id IS NOT NULL;
ALTER TABLE public.category ADD COLUMN IF NOT EXISTS sort_order integer;
ALTER TABLE public.category ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE public.category ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
UPDATE public.category c SET sort_order = o.n FROM (
 SELECT id, row_number() OVER (ORDER BY CASE slug WHEN 'writing' THEN 1 WHEN 'reports' THEN 2 WHEN 'translation' THEN 3
  WHEN 'code' THEN 4 WHEN 'data' THEN 5 WHEN 'images' THEN 6 WHEN 'media' THEN 7 WHEN 'marketing' THEN 8
  WHEN 'education' THEN 9 WHEN 'life' THEN 10 WHEN 'roles' THEN 11 WHEN 'other' THEN 999 ELSE 500 END, name) AS n
 FROM public.category) o WHERE c.id = o.id AND c.sort_order IS NULL;
REVOKE ALL ON public.category FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.shared_prompt_card(p public.prompt) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
 SELECT jsonb_build_object('id',p.id,'title',p.title,'body',p.body,'body_en',p.body_en,'summary',p.summary,
 'category',(SELECT name FROM public.category WHERE id=p.category_id),'tags',p.tags,
 'variables',p.variables,'model_hint',p.model_hint,'use_count',p.use_count,'last_used',p.last_used,
 'source',p.source,'fork_of',p.fork_of,'updated_at',p.updated_at,'created_at',p.created_at,
 'group_id',coalesce(p.group_id,p.id),'version_no',p.version_no,'version_note',p.version_note);
$$;
REVOKE ALL ON FUNCTION public.shared_prompt_card(public.prompt) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.shared_prompt_save(item jsonb, editing_id uuid DEFAULT NULL, expected_version timestamptz DEFAULT NULL)
RETURNS public.prompt LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE p public.prompt; cat uuid; h text; v jsonb; o jsonb; names text[]; placeholders text[]; en text;
BEGIN
 IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR jsonb_typeof(item->'body') IS DISTINCT FROM 'string'
 OR length(item->>'body') NOT BETWEEN 20 AND 24000 OR length(btrim(item->>'title')) NOT BETWEEN 1 AND 160
 OR jsonb_typeof(item->'title') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'summary') IS DISTINCT FROM 'string'
 OR length(item->>'summary') > 2000 OR jsonb_typeof(item->'variables') IS DISTINCT FROM 'array'
 OR jsonb_typeof(item->'tags') IS DISTINCT FROM 'array' OR jsonb_typeof(item->'model_hint') IS DISTINCT FROM 'array'
 OR (item ? 'body_en' AND jsonb_typeof(item->'body_en') NOT IN ('string','null'))
 OR (item ? 'version_note' AND jsonb_typeof(item->'version_note') IS DISTINCT FROM 'string')
 OR length(coalesce(item->>'version_note','')) > 200
 THEN RAISE EXCEPTION 'Prompt 格式或長度不正確'; END IF;
 en := nullif(btrim(coalesce(item->>'body_en','')),'');
 IF en IS NOT NULL THEN en := item->>'body_en'; IF length(en) NOT BETWEEN 20 AND 24000 THEN RAISE EXCEPTION '英文版本長度需介於 20 到 24000 字'; END IF; END IF;
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
  OR (v ? 'type' AND coalesce(v->>'type','') NOT IN ('text','select','radio','number'))
  OR (v ? 'options' AND jsonb_typeof(v->'options') IS DISTINCT FROM 'array')
  THEN RAISE EXCEPTION '變數格式錯誤或重複'; END IF;
  IF v ? 'options' THEN
   IF jsonb_array_length(v->'options') > 30 THEN RAISE EXCEPTION '選項最多 30 個'; END IF;
   FOR o IN SELECT value FROM jsonb_array_elements(v->'options') LOOP
    IF jsonb_typeof(o) <> 'string' OR length(o#>>'{}') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION '選項格式錯誤'; END IF;
   END LOOP;
  END IF;
  IF v->>'type' IN ('select','radio') AND jsonb_array_length(coalesce(v->'options','[]')) < 1 THEN RAISE EXCEPTION '選單變數至少要有一個選項'; END IF;
  names := array_append(names,v->>'name');
 END LOOP;
 SELECT coalesce(array_agg(DISTINCT m[1]),ARRAY[]::text[]) INTO placeholders
 FROM regexp_matches((item->>'body') || E'\n' || coalesce(en,''),'\{\{([^{}]+)\}\}','g') AS m;
 IF NOT (names @> placeholders AND names <@ placeholders) THEN RAISE EXCEPTION '本文與變數不一致'; END IF;
 SELECT id INTO cat FROM public.category WHERE name=item->>'category' AND archived_at IS NULL ORDER BY sort_order, id LIMIT 1;
 IF cat IS NULL AND editing_id IS NULL THEN SELECT id INTO cat FROM public.category WHERE slug='other'; END IF;
 IF cat IS NULL THEN RAISE EXCEPTION '分類不存在，請重新整理後再試'; END IF;
 h := encode(sha256(convert_to(lower(regexp_replace(normalize(item->>'body',NFKC),'[[:space:]]','','g')),'UTF8')),'hex');
 IF editing_id IS NULL THEN
  INSERT INTO public.prompt(title,body,body_en,summary,use_case,model_hint,variables,tags,category_id,lang,
    visibility,author_id,source,source_body,embedding,embedding_model,normalized_hash,simhash,search_text,version_note)
  VALUES(btrim(item->>'title'),item->>'body',en,item->>'summary',btrim(item->>'title'),
    ARRAY(SELECT jsonb_array_elements_text(item->'model_hint')),item->'variables',
    ARRAY(SELECT jsonb_array_elements_text(item->'tags')),cat,'zh-Hant','public',
    '00000000-0000-4000-8000-000000000001',left(coalesce(item->>'source','雲端匯入'),2000),item->>'body',
    NULL,'not-generated',h,'0000000000000000','',coalesce(item->>'version_note',''))
  ON CONFLICT(author_id,normalized_hash) DO NOTHING RETURNING * INTO p;
  IF p.id IS NULL THEN
   SELECT * INTO p FROM public.prompt WHERE author_id='00000000-0000-4000-8000-000000000001' AND normalized_hash=h;
   IF p.deleted_at IS NOT NULL THEN RAISE EXCEPTION '相同內容已刪除；請先修改內容再加入（本機資料會保留）'; END IF;
  END IF;
 ELSE
  UPDATE public.prompt SET title=btrim(item->>'title'),body=item->>'body',body_en=en,summary=item->>'summary',
    use_case=btrim(item->>'title'),model_hint=ARRAY(SELECT jsonb_array_elements_text(item->'model_hint')),
    variables=item->'variables',tags=ARRAY(SELECT jsonb_array_elements_text(item->'tags')),category_id=cat,
    source_body=item->>'body',normalized_hash=h,embedding=NULL,embedding_model='not-generated',
    simhash='0000000000000000',version_note=coalesce(item->>'version_note',version_note),updated_at=clock_timestamp()
  WHERE id=editing_id AND author_id='00000000-0000-4000-8000-000000000001'
    AND deleted_at IS NULL AND updated_at=expected_version RETURNING * INTO p;
  IF p.id IS NULL THEN RAISE EXCEPTION '資料已被修改或刪除，請重新載入後再試'; END IF;
 END IF;
 RETURN p;
END;
$$;
REVOKE ALL ON FUNCTION public.shared_prompt_save(jsonb,uuid,timestamptz) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.shared_uuid_list(value jsonb) RETURNS uuid[]
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
BEGIN
 IF jsonb_typeof(value) IS DISTINCT FROM 'array' OR jsonb_array_length(value) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION '請選擇 1 到 500 則 Prompt'; END IF;
 RETURN ARRAY(SELECT (x)::uuid FROM jsonb_array_elements_text(value) x);
END;
$$;
REVOKE ALL ON FUNCTION public.shared_uuid_list(jsonb) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.shared_categories() RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('name',name,'fixed',slug='other') ORDER BY slug='other', sort_order, name),'[]')
 FROM public.category WHERE archived_at IS NULL AND parent_id IS NULL;
$$;
REVOKE ALL ON FUNCTION public.shared_categories() FROM PUBLIC,anon,authenticated;

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
  -- Full ordered list: [{name, from?}]. "from" renames an existing category; missing ones are archived
  -- and their prompts move to 其他 (which always stays, last).
  IF jsonb_typeof(request->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(request->'items') NOT BETWEEN 1 AND 60 THEN RAISE EXCEPTION '分類數量需介於 1 到 60'; END IF;
  SELECT id INTO other FROM public.category WHERE slug='other';
  keep := ARRAY[]::text[]; i := 0;
  FOR c IN SELECT value FROM jsonb_array_elements(request->'items') LOOP
   IF jsonb_typeof(c->'name') IS DISTINCT FROM 'string' OR length(btrim(c->>'name')) NOT BETWEEN 1 AND 30 OR btrim(c->>'name') ~ '[\r\n]' THEN RAISE EXCEPTION '分類名稱需為 1 到 30 字'; END IF;
   IF btrim(c->>'name') = ANY(keep) THEN RAISE EXCEPTION '分類名稱重複：%', btrim(c->>'name'); END IF;
   keep := array_append(keep, btrim(c->>'name'));
  END LOOP;
  -- Archive first so a rename may reuse a name that is being removed.
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
 ELSIF op='version' THEN
  -- Save as a new version of the same prompt (group). Identical text to any existing prompt is refused.
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
  -- ids in order oldest → newest become V1..Vn of one prompt.
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
INSERT INTO public.schema_migration(version) VALUES(3) ON CONFLICT DO NOTHING;
NOTIFY pgrst, 'reload schema';
COMMIT;
