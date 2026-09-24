-- ============================================================================
-- 班級版（ai-class-lab）專用。僅限班級 Supabase 專案，請勿套用於 prompt-search。
-- 套用順序：001_fresh_project.sql → migrations/002 → migrations/003 → 本檔。
-- 班級版不使用 004_examples/005（那是原版的範例功能），輸出改存 prompt_output。
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------- 1. 資料表
CREATE TABLE IF NOT EXISTS public.classroom (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL CHECK (code ~ '^[a-z0-9-]{4,40}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  owner_uid uuid NOT NULL,
  max_members int NOT NULL DEFAULT 40 CHECK (max_members BETWEEN 1 AND 200),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.team (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id uuid NOT NULL REFERENCES public.classroom(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 40),
  UNIQUE (class_id, name)
);

CREATE TABLE IF NOT EXISTS public.membership (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id uuid NOT NULL REFERENCES public.classroom(id),
  auth_uid uuid NOT NULL,
  email text NOT NULL,
  full_name text,
  nickname text CHECK (nickname IS NULL OR length(btrim(nickname)) BETWEEN 2 AND 12),
  role text NOT NULL DEFAULT 'student' CHECK (role IN ('student','assistant','teacher')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','removed')),
  team_id uuid REFERENCES public.team(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz,
  UNIQUE (class_id, auth_uid)
);
CREATE UNIQUE INDEX IF NOT EXISTS membership_nickname ON public.membership(class_id, nickname) WHERE nickname IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id uuid NOT NULL REFERENCES public.classroom(id),
  team_id uuid REFERENCES public.team(id),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  created_by uuid NOT NULL REFERENCES public.membership(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.prompt_output (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id uuid NOT NULL REFERENCES public.prompt(id),
  member_id uuid NOT NULL REFERENCES public.membership(id),
  kind text NOT NULL CHECK (kind IN ('text','image')),
  text_body text CHECK (text_body IS NULL OR length(text_body) BETWEEN 1 AND 20000),
  image_full text, image_thumb text,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK ((kind='text' AND text_body IS NOT NULL) OR (kind='image' AND image_full IS NOT NULL AND image_thumb IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS prompt_output_prompt ON public.prompt_output(prompt_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS public.write_log (
  member_id uuid NOT NULL, at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS write_log_member ON public.write_log(member_id, at);

ALTER TABLE public.prompt ADD COLUMN IF NOT EXISTS class_id uuid REFERENCES public.classroom(id);
ALTER TABLE public.prompt ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.team(id);
ALTER TABLE public.prompt ADD COLUMN IF NOT EXISTS member_id uuid REFERENCES public.membership(id);
ALTER TABLE public.prompt ADD COLUMN IF NOT EXISTS task_id uuid REFERENCES public.task(id);
ALTER TABLE public.prompt ADD COLUMN IF NOT EXISTS featured boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS prompt_class_task ON public.prompt(class_id, task_id) WHERE deleted_at IS NULL;

-- 學生的生圖 prompt 常常不到 20 字，班級版把下限放寬到 1 字（原版維持 20）。
ALTER TABLE public.prompt DROP CONSTRAINT IF EXISTS prompt_body_check;
ALTER TABLE public.prompt DROP CONSTRAINT IF EXISTS prompt_source_body_check;
ALTER TABLE public.prompt ADD CONSTRAINT prompt_body_check CHECK (length(body) BETWEEN 1 AND 24000);
ALTER TABLE public.prompt ADD CONSTRAINT prompt_source_body_check CHECK (length(source_body) BETWEEN 1 AND 24000);

-- 瀏覽器一律只呼叫 class_api，資料表本身不開放。
REVOKE ALL ON public.classroom, public.team, public.membership, public.task,
  public.prompt_output, public.write_log, public.prompt, public.category,
  public.app_user, public.usage_log, public.unlock FROM anon, authenticated;
ALTER TABLE public.classroom ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prompt_output ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.write_log ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------- 2. 放寬長度的 prompt 儲存
-- 與 003 的 shared_prompt_save 相同，只有本文長度下限改為 1，並記錄班級欄位。
CREATE OR REPLACE FUNCTION public.class_prompt_save(item jsonb, member public.membership,
  editing_id uuid DEFAULT NULL, expected_version timestamptz DEFAULT NULL)
RETURNS public.prompt LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE p public.prompt; cat uuid; h text; v jsonb; names text[]; placeholders text[]; task uuid; en text;
 ws constant uuid := '00000000-0000-4000-8000-000000000001';
BEGIN
 IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR jsonb_typeof(item->'body') IS DISTINCT FROM 'string'
 OR length(item->>'body') NOT BETWEEN 1 AND 24000 OR length(btrim(item->>'title')) NOT BETWEEN 1 AND 160
 OR jsonb_typeof(item->'title') IS DISTINCT FROM 'string'
 OR length(coalesce(item->>'summary','')) > 2000
 THEN RAISE EXCEPTION 'Prompt 格式或長度不正確'; END IF;
 IF jsonb_typeof(coalesce(item->'variables','[]')) IS DISTINCT FROM 'array'
 OR jsonb_array_length(coalesce(item->'variables','[]')) > 40 THEN RAISE EXCEPTION '變數格式錯誤'; END IF;
 names := ARRAY[]::text[];
 FOR v IN SELECT value FROM jsonb_array_elements(coalesce(item->'variables','[]')) LOOP
  IF jsonb_typeof(v) <> 'object' OR jsonb_typeof(v->'name') IS DISTINCT FROM 'string'
  OR length(v->>'name') NOT BETWEEN 1 AND 60 OR v->>'name' ~ '[{}\r\n]' OR v->>'name'=ANY(names)
  THEN RAISE EXCEPTION '變數格式錯誤或重複'; END IF;
  names := array_append(names, v->>'name');
 END LOOP;
 SELECT coalesce(array_agg(DISTINCT m[1]),ARRAY[]::text[]) INTO placeholders
 FROM regexp_matches(item->>'body','\{\{([^{}]+)\}\}','g') AS m;
 IF NOT (names @> placeholders AND names <@ placeholders) THEN RAISE EXCEPTION '本文與變數不一致'; END IF;
 SELECT id INTO cat FROM public.category WHERE name=item->>'category' ORDER BY id LIMIT 1;
 IF cat IS NULL THEN SELECT id INTO cat FROM public.category WHERE slug='other'; END IF;
 IF item->>'task_id' IS NOT NULL THEN
  SELECT id INTO task FROM public.task WHERE id=(item->>'task_id')::uuid AND class_id=member.class_id;
  IF task IS NULL THEN RAISE EXCEPTION '找不到這個任務'; END IF;
 END IF;
 h := encode(sha256(convert_to(lower(regexp_replace(normalize(item->>'body',NFKC),'[[:space:]]','','g')),'UTF8')),'hex');
 IF editing_id IS NULL THEN
  INSERT INTO public.prompt(title,body,summary,use_case,model_hint,variables,tags,category_id,lang,
    visibility,author_id,source,source_body,embedding,embedding_model,normalized_hash,simhash,search_text,
    version_note,class_id,team_id,member_id,task_id)
  VALUES(btrim(item->>'title'),item->>'body',coalesce(item->>'summary',''),btrim(item->>'title'),
    ARRAY(SELECT jsonb_array_elements_text(coalesce(item->'model_hint','[]'))),coalesce(item->'variables','[]'),
    ARRAY(SELECT jsonb_array_elements_text(coalesce(item->'tags','[]'))),cat,'zh-Hant','public',
    ws,'班級版',item->>'body',NULL,'not-generated',h,'0000000000000000','',
    left(coalesce(item->>'version_note',''),200),member.class_id,member.team_id,member.id,task)
  RETURNING * INTO p;
 ELSE
  UPDATE public.prompt SET title=btrim(item->>'title'),body=item->>'body',summary=coalesce(item->>'summary',''),
    use_case=btrim(item->>'title'),variables=coalesce(item->'variables','[]'),
    tags=ARRAY(SELECT jsonb_array_elements_text(coalesce(item->'tags','[]'))),category_id=cat,
    source_body=item->>'body',normalized_hash=h,task_id=coalesce(task,task_id),
    version_note=coalesce(left(item->>'version_note',200),version_note),updated_at=clock_timestamp()
  WHERE id=editing_id AND deleted_at IS NULL AND (expected_version IS NULL OR updated_at=expected_version)
  RETURNING * INTO p;
  IF p.id IS NULL THEN RAISE EXCEPTION '資料已被修改或刪除，請重新載入後再試'; END IF;
 END IF;
 RETURN p;
END;
$$;
REVOKE ALL ON FUNCTION public.class_prompt_save(jsonb,public.membership,uuid,timestamptz) FROM PUBLIC,anon,authenticated;

-- --------------------------------------------------------- 3. 共用小工具
-- 目前登入者在某一班的成員資料。所有權限判斷都經過這裡，因此一定綁 class_id。
CREATE OR REPLACE FUNCTION public.class_member(p_class uuid) RETURNS public.membership
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE m public.membership;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION '請先登入'; END IF;
 IF p_class IS NULL THEN RAISE EXCEPTION '缺少班級'; END IF;
 SELECT * INTO m FROM public.membership WHERE class_id=p_class AND auth_uid=auth.uid();
 IF m.id IS NULL THEN RAISE EXCEPTION '你不屬於這個班級'; END IF;
 RETURN m;
END;
$$;
REVOKE ALL ON FUNCTION public.class_member(uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.class_active(p_class uuid) RETURNS public.membership
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE m public.membership;
BEGIN
 m := public.class_member(p_class);
 IF m.status <> 'active' THEN RAISE EXCEPTION '你的加入申請尚未通過'; END IF;
 IF m.nickname IS NULL THEN RAISE EXCEPTION '請先設定暱稱'; END IF;
 RETURN m;
END;
$$;
REVOKE ALL ON FUNCTION public.class_active(uuid) FROM PUBLIC,anon,authenticated;

-- 老師／助教：永遠以「這個人在這一班的角色」判斷，沒有全域管理者。
CREATE OR REPLACE FUNCTION public.class_staff(p_class uuid, teacher_only boolean DEFAULT false) RETURNS public.membership
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE m public.membership;
BEGIN
 m := public.class_active(p_class);
 IF teacher_only AND m.role <> 'teacher' THEN RAISE EXCEPTION '只有老師可以做這件事'; END IF;
 IF m.role NOT IN ('teacher','assistant') THEN RAISE EXCEPTION '只有老師或助教可以做這件事'; END IF;
 RETURN m;
END;
$$;
REVOKE ALL ON FUNCTION public.class_staff(uuid,boolean) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.class_rate_limit(p_member uuid) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
 DELETE FROM public.write_log WHERE at < now() - interval '1 hour';
 IF (SELECT count(*) FROM public.write_log WHERE member_id=p_member AND at > now() - interval '10 minutes') >= 60
  THEN RAISE EXCEPTION '操作太頻繁，請稍後再試'; END IF;
 INSERT INTO public.write_log(member_id) VALUES(p_member);
END;
$$;
REVOKE ALL ON FUNCTION public.class_rate_limit(uuid) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.class_code() RETURNS text
LANGUAGE sql VOLATILE SET search_path = '' AS $$
 SELECT string_agg(substr('abcdefghijkmnpqrstuvwxyz23456789', 1+floor(random()*32)::int, 1), '') FROM generate_series(1,8);
$$;
REVOKE ALL ON FUNCTION public.class_code() FROM PUBLIC,anon,authenticated;

-- 學生端看得到的欄位：暱稱、組別、任務、精選、最新一筆輸出縮圖。不含 email 或姓名。
CREATE OR REPLACE FUNCTION public.class_prompt_card(p public.prompt, with_outputs boolean DEFAULT false) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
 SELECT jsonb_build_object('id',p.id,'title',p.title,'body',p.body,'summary',p.summary,
   'category',(SELECT name FROM public.category WHERE id=p.category_id),'tags',p.tags,
   'variables',p.variables,'model_hint',p.model_hint,'use_count',p.use_count,'last_used',p.last_used,
   'source',p.source,'fork_of',p.fork_of,'updated_at',p.updated_at,'created_at',p.created_at,
   'group_id',coalesce(p.group_id,p.id),'version_no',p.version_no,'version_note',p.version_note,
   'task_id',p.task_id,'featured',p.featured,'member_id',p.member_id,
   'author',(SELECT nickname FROM public.membership WHERE id=p.member_id),
   'team',(SELECT name FROM public.team WHERE id=p.team_id),
   'outputs',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',o.id,'kind',o.kind,
       'text_body',CASE WHEN o.kind='text' THEN o.text_body END,
       'image_thumb',CASE WHEN o.kind='image' THEN o.image_thumb END,
       'member_id',o.member_id,'created_at',o.created_at) ORDER BY o.created_at),'[]')
     FROM public.prompt_output o WHERE o.prompt_id=p.id AND o.deleted_at IS NULL
       AND (with_outputs OR o.kind='image')));
$$;
REVOKE ALL ON FUNCTION public.class_prompt_card(public.prompt,boolean) FROM PUBLIC,anon,authenticated;

-- --------------------------------------------------------------- 4. class_api
CREATE OR REPLACE FUNCTION public.class_api(request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE op text := request->>'op'; cls public.classroom; m public.membership; target public.membership;
 p public.prompt; base public.prompt; o public.prompt_output; t public.task; tm public.team;
 p_class uuid := nullif(request->>'class_id','')::uuid; result jsonb; n integer; g uuid; nick text;
 uid uuid := auth.uid(); mail text; fname text; new_code text;
BEGIN
 IF jsonb_typeof(request) IS DISTINCT FROM 'object' OR octet_length(request::text) > 4194304
  THEN RAISE EXCEPTION '請求格式或大小不正確'; END IF;
 IF uid IS NULL THEN RAISE EXCEPTION '請先登入'; END IF;

 -- 自己的班級清單（唯一不需要 class_id 的讀取，而且只回傳自己的紀錄）
 IF op='me' THEN
  UPDATE public.membership SET last_seen=clock_timestamp() WHERE auth_uid=uid AND status='active';
  RETURN jsonb_build_object('uid',uid,'classes',(
    SELECT coalesce(jsonb_agg(jsonb_build_object('class_id',c.id,'name',c.name,'role',ms.role,
      'status',ms.status,'nickname',ms.nickname,'team_id',ms.team_id,
      'team',(SELECT name FROM public.team WHERE id=ms.team_id),
      'archived',c.archived_at IS NOT NULL) ORDER BY c.created_at),'[]')
    FROM public.membership ms JOIN public.classroom c ON c.id=ms.class_id
    WHERE ms.auth_uid=uid AND ms.status <> 'removed'));

 ELSIF op='join_request' THEN
  SELECT * INTO cls FROM public.classroom WHERE code=lower(btrim(request->>'class_code'));
  IF cls.id IS NULL THEN RAISE EXCEPTION '找不到這個班級代碼'; END IF;
  IF cls.archived_at IS NOT NULL THEN RAISE EXCEPTION '這個班級已封存'; END IF;
  SELECT * INTO m FROM public.membership WHERE class_id=cls.id AND auth_uid=uid;
  IF m.id IS NOT NULL AND m.status='removed' THEN RAISE EXCEPTION '你已被移出這個班級，請找老師'; END IF;
  IF m.id IS NOT NULL THEN RETURN jsonb_build_object('class_id',cls.id,'status',m.status); END IF;
  IF (SELECT count(*) FROM public.membership WHERE class_id=cls.id AND status IN ('pending','active')) >= cls.max_members
   THEN RAISE EXCEPTION '這個班級人數已滿'; END IF;
  SELECT u.email, u.raw_user_meta_data->>'name' INTO mail, fname FROM auth.users u WHERE u.id=uid;
  INSERT INTO public.membership(class_id,auth_uid,email,full_name)
  VALUES(cls.id,uid,coalesce(mail,''),fname);
  RETURN jsonb_build_object('class_id',cls.id,'status','pending','name',cls.name);

 ELSIF op='set_nickname' THEN
  m := public.class_member(p_class);
  IF m.status <> 'active' THEN RAISE EXCEPTION '你的加入申請尚未通過'; END IF;
  nick := btrim(request->>'nickname');
  IF nick IS NULL OR length(nick) NOT BETWEEN 2 AND 12 THEN RAISE EXCEPTION '暱稱請填 2 到 12 個字'; END IF;
  IF EXISTS(SELECT 1 FROM public.membership WHERE class_id=m.class_id AND nickname=nick AND id<>m.id)
   THEN RAISE EXCEPTION '這個暱稱班上已經有人用了'; END IF;
  UPDATE public.membership SET nickname=nick WHERE id=m.id;
  RETURN jsonb_build_object('nickname',nick);
 END IF;

 -- 以下都需要已核可的成員，而且一律限定在這個 class_id
 m := public.class_active(p_class);

 IF op='list' THEN
  RETURN (SELECT coalesce(jsonb_agg(public.class_prompt_card(x) ORDER BY x.updated_at DESC),'[]')
   FROM public.prompt x WHERE x.class_id=m.class_id AND x.deleted_at IS NULL AND x.state='active'
     AND NOT EXISTS (SELECT 1 FROM public.prompt y WHERE y.class_id=m.class_id AND y.deleted_at IS NULL
        AND coalesce(y.group_id,y.id)=coalesce(x.group_id,x.id) AND y.version_no > x.version_no)
     AND (request->>'task_id' IS NULL OR x.task_id=(request->>'task_id')::uuid)
     AND (coalesce(request->>'scope','class')='class'
       OR (request->>'scope'='mine' AND x.member_id=m.id)
       OR (request->>'scope'='team' AND m.team_id IS NOT NULL AND x.team_id=m.team_id)
       OR (request->>'scope'='featured' AND x.featured)));

 ELSIF op='get' THEN
  RETURN (SELECT coalesce(jsonb_agg(public.class_prompt_card(x,true) ORDER BY x.version_no),'[]')
   FROM public.prompt x WHERE x.class_id=m.class_id AND x.deleted_at IS NULL
     AND coalesce(x.group_id,x.id)=(request->>'group_id')::uuid);

 ELSIF op='save' THEN
  PERFORM public.class_rate_limit(m.id);
  p := public.class_prompt_save(request->'item', m);
  RETURN public.class_prompt_card(p,true);

 ELSIF op='edit' THEN
  PERFORM public.class_rate_limit(m.id);
  SELECT * INTO base FROM public.prompt WHERE id=(request->>'id')::uuid AND class_id=m.class_id AND deleted_at IS NULL;
  IF base.id IS NULL THEN RAISE EXCEPTION '找不到這個 Prompt'; END IF;
  IF base.member_id <> m.id THEN RAISE EXCEPTION '只能修改自己的 Prompt'; END IF;
  p := public.class_prompt_save(request->'item', m, base.id, (request->>'version')::timestamptz);
  RETURN public.class_prompt_card(p,true);

 ELSIF op='version' THEN
  PERFORM public.class_rate_limit(m.id);
  IF length(btrim(coalesce(request#>>'{item,version_note}',''))) = 0
   THEN RAISE EXCEPTION '請寫下這一版改了什麼、為什麼'; END IF;
  SELECT * INTO base FROM public.prompt WHERE id=(request->>'id')::uuid AND class_id=m.class_id AND deleted_at IS NULL;
  IF base.id IS NULL THEN RAISE EXCEPTION '找不到這個 Prompt'; END IF;
  IF base.member_id <> m.id THEN RAISE EXCEPTION '只能修改自己的 Prompt'; END IF;
  g := coalesce(base.group_id, base.id);
  p := public.class_prompt_save(request->'item', m);
  SELECT coalesce(max(version_no),0)+1 INTO n FROM public.prompt WHERE class_id=m.class_id AND deleted_at IS NULL AND coalesce(group_id,id)=g;
  UPDATE public.prompt SET group_id=g WHERE id=base.id AND group_id IS NULL;
  UPDATE public.prompt SET group_id=g, version_no=n, fork_of=base.id, task_id=coalesce(p.task_id,base.task_id)
   WHERE id=p.id RETURNING * INTO p;
  RETURN public.class_prompt_card(p,true);

 ELSIF op='delete' THEN
  PERFORM public.class_rate_limit(m.id);
  SELECT * INTO base FROM public.prompt WHERE id=(request->>'id')::uuid AND class_id=m.class_id AND deleted_at IS NULL;
  IF base.id IS NULL THEN RAISE EXCEPTION '找不到這個 Prompt'; END IF;
  IF base.member_id <> m.id AND m.role NOT IN ('teacher','assistant') THEN RAISE EXCEPTION '只能刪除自己的 Prompt'; END IF;
  UPDATE public.prompt SET deleted_at=clock_timestamp(), updated_at=clock_timestamp() WHERE id=base.id;
  RETURN jsonb_build_object('deleted',true,'id',base.id);

 ELSIF op='output_add' THEN
  PERFORM public.class_rate_limit(m.id);
  SELECT * INTO base FROM public.prompt WHERE id=(request->>'prompt_id')::uuid AND class_id=m.class_id AND deleted_at IS NULL;
  IF base.id IS NULL THEN RAISE EXCEPTION '找不到這個 Prompt'; END IF;
  IF base.member_id <> m.id THEN RAISE EXCEPTION '只能為自己的 Prompt 加上輸出'; END IF;
  IF (SELECT count(*) FROM public.prompt_output WHERE prompt_id=base.id AND deleted_at IS NULL) >= 5
   THEN RAISE EXCEPTION '一個版本最多 5 筆輸出'; END IF;
  IF request->>'kind'='text' THEN
   IF length(btrim(coalesce(request->>'text_body',''))) NOT BETWEEN 1 AND 20000 THEN RAISE EXCEPTION '文字結果需為 1 到 20000 字'; END IF;
   INSERT INTO public.prompt_output(prompt_id,member_id,kind,text_body)
   VALUES(base.id,m.id,'text',request->>'text_body') RETURNING * INTO o;
  ELSIF request->>'kind'='image' THEN
   IF left(coalesce(request->>'image_full',''),4) <> '/9j/' OR left(coalesce(request->>'image_thumb',''),4) <> '/9j/'
    THEN RAISE EXCEPTION '圖片必須是 JPEG'; END IF;
   IF octet_length(request->>'image_full') > 400*1024 THEN RAISE EXCEPTION '圖片太大，請重新上傳'; END IF;
   IF octet_length(request->>'image_thumb') > 40*1024 THEN RAISE EXCEPTION '縮圖太大，請重新上傳'; END IF;
   INSERT INTO public.prompt_output(prompt_id,member_id,kind,image_full,image_thumb)
   VALUES(base.id,m.id,'image',request->>'image_full',request->>'image_thumb') RETURNING * INTO o;
  ELSE RAISE EXCEPTION '不支援的輸出類型'; END IF;
  RETURN jsonb_build_object('id',o.id,'kind',o.kind);

 ELSIF op='output_delete' THEN
  SELECT o2.* INTO o FROM public.prompt_output o2 JOIN public.prompt pr ON pr.id=o2.prompt_id
   WHERE o2.id=(request->>'id')::uuid AND pr.class_id=m.class_id AND o2.deleted_at IS NULL;
  IF o.id IS NULL THEN RAISE EXCEPTION '找不到這筆輸出'; END IF;
  IF o.member_id <> m.id AND m.role NOT IN ('teacher','assistant') THEN RAISE EXCEPTION '只能刪除自己的輸出'; END IF;
  UPDATE public.prompt_output SET deleted_at=clock_timestamp() WHERE id=o.id;
  RETURN jsonb_build_object('deleted',true,'id',o.id);

 ELSIF op='output_get' THEN
  SELECT o2.* INTO o FROM public.prompt_output o2 JOIN public.prompt pr ON pr.id=o2.prompt_id
   WHERE o2.id=(request->>'id')::uuid AND pr.class_id=m.class_id AND o2.deleted_at IS NULL;
  IF o.id IS NULL THEN RAISE EXCEPTION '找不到這筆輸出'; END IF;
  RETURN jsonb_build_object('id',o.id,'kind',o.kind,'image_full',o.image_full,'text_body',o.text_body);

 ELSIF op='task_list' THEN
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('id',x.id,'title',x.title,'description',x.description,
     'team_id',x.team_id,'team',(SELECT name FROM public.team WHERE id=x.team_id),
     'closed',x.closed_at IS NOT NULL,'created_at',x.created_at,
     'handed_in',(SELECT count(DISTINCT pr.member_id) FROM public.prompt pr WHERE pr.class_id=m.class_id AND pr.task_id=x.id AND pr.deleted_at IS NULL)) ORDER BY x.created_at DESC),'[]')
   FROM public.task x WHERE x.class_id=m.class_id
     AND (x.team_id IS NULL OR x.team_id=m.team_id OR m.role IN ('teacher','assistant')));

 ELSIF op='task_create' THEN
  PERFORM public.class_rate_limit(m.id);
  IF m.role='student' THEN
   IF m.team_id IS NULL OR (request->>'team_id')::uuid IS DISTINCT FROM m.team_id
    THEN RAISE EXCEPTION '學生只能為自己這一組建立任務'; END IF;
  ELSIF request->>'team_id' IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM public.team WHERE id=(request->>'team_id')::uuid AND class_id=m.class_id)
    THEN RAISE EXCEPTION '找不到這一組'; END IF;
  END IF;
  INSERT INTO public.task(class_id,team_id,title,description,created_by)
  VALUES(m.class_id,(request->>'team_id')::uuid,btrim(request->>'title'),
    left(coalesce(request->>'description',''),2000),m.id) RETURNING * INTO t;
  RETURN jsonb_build_object('id',t.id,'title',t.title);

 ELSIF op='task_close' THEN
  SELECT * INTO t FROM public.task WHERE id=(request->>'id')::uuid AND class_id=m.class_id;
  IF t.id IS NULL THEN RAISE EXCEPTION '找不到這個任務'; END IF;
  IF t.created_by <> m.id AND m.role NOT IN ('teacher','assistant') THEN RAISE EXCEPTION '只有老師或建立者可以關閉任務'; END IF;
  UPDATE public.task SET closed_at=CASE WHEN closed_at IS NULL THEN clock_timestamp() END WHERE id=t.id RETURNING * INTO t;
  RETURN jsonb_build_object('id',t.id,'closed',t.closed_at IS NOT NULL);

 ELSIF op='compare' THEN
  SELECT * INTO t FROM public.task WHERE id=(request->>'task_id')::uuid AND class_id=m.class_id;
  IF t.id IS NULL THEN RAISE EXCEPTION '找不到這個任務'; END IF;
  RETURN jsonb_build_object('task',jsonb_build_object('id',t.id,'title',t.title,'description',t.description),
   'columns',(SELECT coalesce(jsonb_agg(col ORDER BY col->>'team', col->>'author'),'[]') FROM (
     SELECT jsonb_build_object('member_id',ms.id,'author',ms.nickname,
       'team',(SELECT name FROM public.team WHERE id=ms.team_id),
       'versions',(SELECT jsonb_agg(public.class_prompt_card(pr,true) ORDER BY pr.version_no)
         FROM public.prompt pr WHERE pr.class_id=m.class_id AND pr.task_id=t.id AND pr.member_id=ms.id AND pr.deleted_at IS NULL)) AS col
     FROM public.membership ms WHERE ms.class_id=m.class_id AND ms.status='active'
       AND EXISTS(SELECT 1 FROM public.prompt pr WHERE pr.class_id=m.class_id AND pr.task_id=t.id AND pr.member_id=ms.id AND pr.deleted_at IS NULL)
   ) s));

 ELSIF op='feature' THEN
  PERFORM public.class_staff(p_class);
  UPDATE public.prompt SET featured=NOT featured, updated_at=clock_timestamp()
   WHERE id=(request->>'id')::uuid AND class_id=m.class_id AND deleted_at IS NULL RETURNING * INTO p;
  IF p.id IS NULL THEN RAISE EXCEPTION '找不到這個 Prompt'; END IF;
  RETURN jsonb_build_object('id',p.id,'featured',p.featured);

 ELSIF op='roster' THEN
  PERFORM public.class_staff(p_class);
  RETURN jsonb_build_object(
   'class',(SELECT jsonb_build_object('id',c.id,'name',c.name,'code',c.code,'max_members',c.max_members,
      'archived',c.archived_at IS NOT NULL) FROM public.classroom c WHERE c.id=m.class_id),
   'teams',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',tt.id,'name',tt.name) ORDER BY tt.name),'[]')
      FROM public.team tt WHERE tt.class_id=m.class_id),
   'members',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',ms.id,'email',ms.email,'full_name',ms.full_name,
      'nickname',ms.nickname,'role',ms.role,'status',ms.status,'team_id',ms.team_id,
      'joined_at',ms.joined_at,'last_seen',ms.last_seen) ORDER BY ms.status, ms.joined_at),'[]')
      FROM public.membership ms WHERE ms.class_id=m.class_id AND ms.status <> 'removed'));

 ELSIF op IN ('approve','reject','remove_member','set_role') THEN
  PERFORM public.class_staff(p_class, op IN ('set_role','remove_member'));
  SELECT * INTO target FROM public.membership WHERE id=(request->>'member_id')::uuid AND class_id=m.class_id;
  IF target.id IS NULL THEN RAISE EXCEPTION '找不到這位成員'; END IF;
  IF op='approve' THEN
   IF (SELECT count(*) FROM public.membership WHERE class_id=m.class_id AND status='active') >=
      (SELECT max_members FROM public.classroom WHERE id=m.class_id) THEN RAISE EXCEPTION '這個班級人數已滿'; END IF;
   UPDATE public.membership SET status='active' WHERE id=target.id;
  ELSIF op='reject' OR op='remove_member' THEN
   IF target.id=m.id THEN RAISE EXCEPTION '不能移除自己'; END IF;
   UPDATE public.membership SET status='removed' WHERE id=target.id;
  ELSE
   IF request->>'role' NOT IN ('student','assistant','teacher') THEN RAISE EXCEPTION '角色不正確'; END IF;
   IF target.id=m.id AND request->>'role' <> 'teacher' THEN RAISE EXCEPTION '不能把自己降級'; END IF;
   UPDATE public.membership SET role=request->>'role' WHERE id=target.id;
  END IF;
  RETURN jsonb_build_object('member_id',target.id,'op',op);

 ELSIF op='team_assign' THEN
  PERFORM public.class_staff(p_class);
  SELECT * INTO target FROM public.membership WHERE id=(request->>'member_id')::uuid AND class_id=m.class_id;
  IF target.id IS NULL THEN RAISE EXCEPTION '找不到這位成員'; END IF;
  IF request->>'team_id' IS NOT NULL AND NOT EXISTS(
     SELECT 1 FROM public.team WHERE id=(request->>'team_id')::uuid AND class_id=m.class_id)
   THEN RAISE EXCEPTION '找不到這一組'; END IF;
  UPDATE public.membership SET team_id=(request->>'team_id')::uuid WHERE id=target.id;
  RETURN jsonb_build_object('member_id',target.id,'team_id',(request->>'team_id')::uuid);

 ELSIF op='team_create' THEN
  PERFORM public.class_staff(p_class);
  INSERT INTO public.team(class_id,name) VALUES(m.class_id,btrim(request->>'name')) RETURNING * INTO tm;
  RETURN jsonb_build_object('id',tm.id,'name',tm.name);

 ELSIF op='team_rename' THEN
  PERFORM public.class_staff(p_class);
  UPDATE public.team SET name=btrim(request->>'name')
   WHERE id=(request->>'team_id')::uuid AND class_id=m.class_id RETURNING * INTO tm;
  IF tm.id IS NULL THEN RAISE EXCEPTION '找不到這一組'; END IF;
  RETURN jsonb_build_object('id',tm.id,'name',tm.name);

 ELSIF op='rotate_code' THEN
  PERFORM public.class_staff(p_class, true);
  LOOP
   new_code := public.class_code();
   EXIT WHEN NOT EXISTS(SELECT 1 FROM public.classroom WHERE code=new_code);
  END LOOP;
  UPDATE public.classroom SET code=new_code WHERE id=m.class_id;
  RETURN jsonb_build_object('code',new_code);

 ELSIF op='class_archive' THEN
  PERFORM public.class_staff(p_class, true);
  UPDATE public.classroom SET archived_at=clock_timestamp() WHERE id=m.class_id;
  RETURN jsonb_build_object('archived',true);

 ELSIF op='export' THEN
  PERFORM public.class_staff(p_class, true);
  -- 匯出格式與原版「匯入我的 Prompt」相容；不含 email 與姓名。
  RETURN jsonb_build_object('version',2,'exported_at',now(),'storage','class',
   'class',(SELECT c.name FROM public.classroom c WHERE c.id=m.class_id),
   'prompts',(SELECT coalesce(jsonb_agg(jsonb_build_object('title',pr.title,'body',pr.body,'summary',pr.summary,
      'category',(SELECT name FROM public.category WHERE id=pr.category_id),'tags',pr.tags,
      'variables',pr.variables,'model_hint',pr.model_hint,'source',pr.source,
      'author',(SELECT nickname FROM public.membership WHERE id=pr.member_id),
      'team',(SELECT name FROM public.team WHERE id=pr.team_id),
      'task',(SELECT title FROM public.task WHERE id=pr.task_id),
      'version_no',pr.version_no,'version_note',pr.version_note,'updated_at',pr.updated_at,
      'outputs',(SELECT coalesce(jsonb_agg(jsonb_build_object('kind',oo.kind,'text_body',oo.text_body)),'[]')
         FROM public.prompt_output oo WHERE oo.prompt_id=pr.id AND oo.deleted_at IS NULL AND oo.kind='text'))
      ORDER BY pr.created_at),'[]')
    FROM public.prompt pr WHERE pr.class_id=m.class_id AND pr.deleted_at IS NULL));

 ELSIF op='purge_identities' THEN
  PERFORM public.class_staff(p_class, true);
  UPDATE public.membership SET email='(已清除)', full_name=NULL WHERE class_id=m.class_id;
  RETURN jsonb_build_object('purged',true);
 END IF;
 RAISE EXCEPTION '不支援的操作';
END;
$$;
REVOKE ALL ON FUNCTION public.class_api(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.class_api(jsonb) TO authenticated;

-- 開班只由腳本以 service_role 呼叫（v3 不開放介面）。
CREATE OR REPLACE FUNCTION public.class_create(p_name text, p_teacher_email text, p_max int DEFAULT 40,
  p_teams int DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c public.classroom; u record; new_code text; i int;
BEGIN
 IF length(btrim(coalesce(p_name,''))) = 0 THEN RAISE EXCEPTION '請給班級名稱'; END IF;
 LOOP new_code := public.class_code(); EXIT WHEN NOT EXISTS(SELECT 1 FROM public.classroom c2 WHERE c2.code=new_code); END LOOP;
 SELECT id, email INTO u FROM auth.users WHERE lower(email)=lower(btrim(p_teacher_email));
 IF u.id IS NULL THEN RAISE EXCEPTION '這個 email 還沒登入過班級站，請老師先用 Google 登入一次'; END IF;
 INSERT INTO public.classroom(code,name,owner_uid,max_members) VALUES(new_code,btrim(p_name),u.id,p_max) RETURNING * INTO c;
 INSERT INTO public.membership(class_id,auth_uid,email,role,status,nickname)
 VALUES(c.id,u.id,u.email,'teacher','active','老師');
 FOR i IN 1..greatest(p_teams,0) LOOP
  INSERT INTO public.team(class_id,name) VALUES(c.id,'第 '||i||' 組');
 END LOOP;
 RETURN jsonb_build_object('class_id',c.id,'code',c.code,'name',c.name,'teams',p_teams);
END;
$$;
REVOKE ALL ON FUNCTION public.class_create(text,text,int,int) FROM PUBLIC,anon,authenticated;

INSERT INTO public.schema_migration(version) VALUES(104) ON CONFLICT DO NOTHING;
NOTIFY pgrst, 'reload schema';
COMMIT;
