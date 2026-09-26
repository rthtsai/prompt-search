-- ============================================================================
-- 012：防整包抓取 + 來源 IP 監控
--
-- 在此之前，任何人呼叫一次 list 就拿到每一則的完整本文。改成：
--   * list 對一般訪客只回「卡片表面」：標題、摘要、分類、範例、變數，本文只留前 80 字
--   * 全文要用 get 一則一則拿；搜尋改用 search 在資料庫裡找
--   * get／search／list（第一頁）都記錄來源 IP，同一個來源拿太快就先擋
--   * 其他會回傳卡片的操作（補範例說明、使用紀錄…）對訪客也只回表面，不能拿來繞路
--   * 維護者不受以上限制，並可以查看存取統計、封鎖或解除封鎖某個 IP
--   * Agent 專用 token：跟維護者一樣不受限流、拿得到全文，但不能刪除、編輯、封鎖。
--     給自己的 AI Agent 用；外流了最壞只是內容被讀走，不會被刪光。
--     token 同樣不進版控，只存 sha256：
--       INSERT INTO public.app_secret(name,hash) VALUES('agent',encode(sha256(convert_to('<token>','UTF8')),'hex'))
--       ON CONFLICT (name) DO UPDATE SET hash=excluded.hash, updated_at=now();
--
-- 被擋時回傳 {"error":…, "rate_limited":true} 而不是丟例外，因為丟例外會讓
-- 「這次被擋」的紀錄一起被回滾，監控就看不到誰在狂打。
--
-- ⚠️ 本檔會重建 prompt_library（含 008／010／011 的閘門與範例說明、角色）。
--    若重跑 003 或 005，請依序再跑 008、010、011、012。
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------- 存取紀錄
CREATE TABLE IF NOT EXISTS public.access_log (
  id      bigserial PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  ip      text NOT NULL,
  op      text NOT NULL,
  target  uuid,
  limited boolean NOT NULL DEFAULT false,
  ua      text
);
CREATE INDEX IF NOT EXISTS access_log_ip_at ON public.access_log (ip, at DESC);
CREATE INDEX IF NOT EXISTS access_log_at    ON public.access_log (at DESC);
ALTER TABLE public.access_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.access_log FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.access_log_id_seq FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.ip_block (
  ip         text PRIMARY KEY,
  reason     text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ip_block ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ip_block FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- 來源辨識
CREATE OR REPLACE FUNCTION public.shared_request_headers() RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  RETURN coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
EXCEPTION WHEN others THEN
  RETURN '{}'::jsonb;
END;
$$;
REVOKE ALL ON FUNCTION public.shared_request_headers() FROM PUBLIC, anon, authenticated;

-- Supabase 在 Cloudflare 後面：cf-connecting-ip 是真正的來源；沒有時退回 x-forwarded-for 的第一段
CREATE OR REPLACE FUNCTION public.shared_client_ip() RETURNS text
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT coalesce(nullif(btrim(split_part(coalesce(
           h->>'cf-connecting-ip', h->>'x-forwarded-for', h->>'x-real-ip', ''), ',', 1)), ''), 'unknown')
  FROM (SELECT public.shared_request_headers() AS h) t;
$$;
REVOKE ALL ON FUNCTION public.shared_client_ip() FROM PUBLIC, anon, authenticated;

-- 記錄一次存取；超過頻率或被封鎖時回傳給使用者看的訊息，否則回傳 NULL
CREATE OR REPLACE FUNCTION public.shared_guard(p_op text, p_target uuid DEFAULT NULL) RETURNS text
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_ip text := public.shared_client_ip();
  v_ua text := left(coalesce(public.shared_request_headers()->>'user-agent', ''), 200);
  per_min  integer := CASE p_op WHEN 'get' THEN 40  WHEN 'search' THEN 60  ELSE 60  END;
  per_hour integer := CASE p_op WHEN 'get' THEN 400 WHEN 'search' THEN 600 ELSE 600 END;
  n_min integer; n_hour integer; n_limited integer;
BEGIN
  IF EXISTS (SELECT 1 FROM public.ip_block b WHERE b.ip = v_ip) THEN
    INSERT INTO public.access_log(ip, op, target, limited, ua) VALUES (v_ip, p_op, p_target, true, v_ua);
    RETURN '這個來源已被暫停存取。如果你是一般使用者，請聯絡網站維護者。';
  END IF;

  SELECT count(*) FILTER (WHERE l.at > clock_timestamp() - interval '1 minute' AND NOT l.limited),
         count(*) FILTER (WHERE NOT l.limited),
         count(*) FILTER (WHERE l.at > clock_timestamp() - interval '1 minute' AND l.limited)
    INTO n_min, n_hour, n_limited
    FROM public.access_log l
   WHERE l.ip = v_ip AND l.op = p_op AND l.at > clock_timestamp() - interval '1 hour';

  IF n_min >= per_min OR n_hour >= per_hour THEN
    -- 被擋的也記，但一分鐘最多記 100 筆，免得狂打的人把紀錄表灌爆
    IF n_limited < 100 THEN
      INSERT INTO public.access_log(ip, op, target, limited, ua) VALUES (v_ip, p_op, p_target, true, v_ua);
    END IF;
    RETURN '操作太頻繁了，請稍候一分鐘再試。';
  END IF;

  INSERT INTO public.access_log(ip, op, target, limited, ua) VALUES (v_ip, p_op, p_target, false, v_ua);
  -- 紀錄只留 30 天
  IF random() < 0.01 THEN
    DELETE FROM public.access_log WHERE at < clock_timestamp() - interval '30 days';
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.shared_guard(text, uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- Agent 專用 token
CREATE OR REPLACE FUNCTION public.shared_is_agent(token text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.app_secret s
    WHERE s.name = 'agent'
      AND length(coalesce(token,'')) >= 16
      AND s.hash = encode(sha256(convert_to(token,'UTF8')),'hex'));
$$;
REVOKE ALL ON FUNCTION public.shared_is_agent(text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- 卡片表面
CREATE OR REPLACE FUNCTION public.shared_card_surface(c jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN jsonb_typeof(c) = 'object' AND c ? 'id' AND c ? 'body'
    THEN (c - 'body_en') || jsonb_build_object(
           'body',    left(coalesce(c->>'body', ''), 80),
           'partial', true,
           'has_en',  coalesce(c->>'body_en', '') <> '')
    ELSE c END;
$$;
REVOKE ALL ON FUNCTION public.shared_card_surface(jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.shared_strip(r jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE jsonb_typeof(r)
    WHEN 'array' THEN coalesce((SELECT jsonb_agg(public.shared_card_surface(e) ORDER BY o)
                                  FROM jsonb_array_elements(r) WITH ORDINALITY AS t(e, o)), '[]'::jsonb)
    ELSE public.shared_card_surface(r) END;
$$;
REVOKE ALL ON FUNCTION public.shared_strip(jsonb) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- 對外入口
CREATE OR REPLACE FUNCTION public.prompt_library(request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  op   text    := request->>'op';
  is_m boolean := public.shared_is_maintainer(request->>'maintainer');
  -- 受信任＝不限流、拿全文。維護者與自己的 Agent 都是；但只有維護者能做破壞性操作
  trusted boolean := is_m OR public.shared_is_agent(request->>'agent');
  n integer; p public.prompt; g uuid; msg text; hrs integer; result jsonb;
  ws constant uuid := '00000000-0000-4000-8000-000000000001';
BEGIN
  IF op IN ('delete','delete_many','merge','categories_save','example_remove','edit','restore','restore_many',
            'access_stats','access_recent','ip_block','ip_unblock','whoami') AND NOT is_m THEN
    RAISE EXCEPTION '這個操作保留給維護者。你仍然可以新增、另存一份與複製。';
  END IF;

  -- 頻率限制與封鎖（維護者與 Agent 不受限）
  IF NOT trusted THEN
    IF op = 'list' AND coalesce(request->>'cursor', '') = '' THEN
      msg := public.shared_guard('list');
    ELSIF op = 'get' THEN
      msg := public.shared_guard('get', CASE WHEN request->>'id' ~ '^[0-9a-fA-F-]{36}$' THEN (request->>'id')::uuid END);
    ELSIF op = 'search' THEN
      msg := public.shared_guard('search');
    ELSIF EXISTS (SELECT 1 FROM public.ip_block b WHERE b.ip = public.shared_client_ip()) THEN
      msg := '這個來源已被暫停存取。如果你是一般使用者，請聯絡網站維護者。';
    END IF;
    IF msg IS NOT NULL THEN
      RETURN jsonb_build_object('error', msg, 'rate_limited', true);
    END IF;
  END IF;

  -- ---------- 維護者：監控
  IF op = 'whoami' THEN
    RETURN jsonb_build_object('ip', public.shared_client_ip(),
      'headers', (SELECT coalesce(jsonb_agg(k ORDER BY k), '[]') FROM jsonb_object_keys(public.shared_request_headers()) k));
  END IF;
  IF op = 'access_stats' THEN
    hrs := least(greatest(coalesce(nullif(request->>'hours', '')::integer, 24), 1), 720);
    RETURN jsonb_build_object(
      'hours', hrs,
      'you',   public.shared_client_ip(),
      'totals', (SELECT jsonb_build_object('requests', count(*), 'ips', count(DISTINCT a.ip),
                                           'limited', count(*) FILTER (WHERE a.limited),
                                           'gets', count(*) FILTER (WHERE a.op = 'get' AND NOT a.limited))
                   FROM public.access_log a WHERE a.at > clock_timestamp() - make_interval(hours => hrs)),
      'ips', coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.requests DESC) FROM (
                SELECT l.ip,
                       count(*)                                                AS requests,
                       count(*) FILTER (WHERE l.op = 'get'    AND NOT l.limited) AS gets,
                       count(DISTINCT l.target) FILTER (WHERE l.op = 'get' AND NOT l.limited) AS distinct_prompts,
                       count(*) FILTER (WHERE l.op = 'search' AND NOT l.limited) AS searches,
                       count(*) FILTER (WHERE l.op = 'list'   AND NOT l.limited) AS visits,
                       count(*) FILTER (WHERE l.limited)                        AS limited,
                       min(l.at) AS first_seen, max(l.at) AS last_seen,
                       (array_agg(l.ua ORDER BY l.at DESC))[1] AS ua,
                       EXISTS (SELECT 1 FROM public.ip_block b WHERE b.ip = l.ip) AS blocked
                  FROM public.access_log l
                 WHERE l.at > clock_timestamp() - make_interval(hours => hrs)
                 GROUP BY l.ip ORDER BY count(*) DESC LIMIT 200) s), '[]'),
      'blocked', coalesce((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.created_at DESC) FROM public.ip_block b), '[]'));
  END IF;
  IF op = 'access_recent' THEN
    RETURN coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.at DESC) FROM (
             SELECT l.at, l.op, l.target, l.limited, l.ua,
                    (SELECT x.title FROM public.prompt x WHERE x.id = l.target) AS title
               FROM public.access_log l WHERE l.ip = request->>'ip'
              ORDER BY l.at DESC LIMIT 100) r), '[]');
  END IF;
  IF op = 'ip_block' THEN
    IF coalesce(btrim(request->>'ip'), '') = '' THEN RAISE EXCEPTION '缺少 IP'; END IF;
    INSERT INTO public.ip_block(ip, reason) VALUES (btrim(request->>'ip'), left(coalesce(request->>'reason', ''), 200))
      ON CONFLICT (ip) DO UPDATE SET reason = excluded.reason;
    RETURN jsonb_build_object('blocked', btrim(request->>'ip'));
  END IF;
  IF op = 'ip_unblock' THEN
    DELETE FROM public.ip_block WHERE ip = btrim(request->>'ip');
    RETURN jsonb_build_object('unblocked', btrim(request->>'ip'));
  END IF;

  -- ---------- 全文：一次拿一整組版本
  IF op = 'get' THEN
    IF coalesce(request->>'id', '') !~ '^[0-9a-fA-F-]{36}$' THEN RAISE EXCEPTION '找不到這個 Prompt，請重新整理'; END IF;
    SELECT coalesce(x.group_id, x.id) INTO g FROM public.prompt x
     WHERE x.id = (request->>'id')::uuid AND x.author_id = ws AND x.deleted_at IS NULL;
    IF g IS NULL THEN RAISE EXCEPTION '找不到這個 Prompt，請重新整理'; END IF;
    RETURN coalesce((SELECT jsonb_agg(public.shared_prompt_card(x) ORDER BY x.version_no, x.id)
                       FROM public.prompt x
                      WHERE x.author_id = ws AND x.deleted_at IS NULL AND x.state = 'active'
                        AND coalesce(x.group_id, x.id) = g), '[]');
  END IF;

  -- ---------- 搜尋：在資料庫裡比對全文，只回傳分數與一小段相關文字
  IF op = 'search' THEN
    RETURN coalesce((
      WITH t AS (
        SELECT DISTINCT lower(left(btrim(x), 40)) AS term
          FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(request->'terms') = 'array'
                                              THEN request->'terms' ELSE '[]'::jsonb END) AS x
         WHERE length(btrim(x)) > 0 LIMIT 40),
      r AS (
        SELECT coalesce(x.group_id, x.id) AS g, x.body,
               lower(concat_ws(E'\n', x.title, x.summary, x.body, x.body_en,
                               array_to_string(x.tags, ' '), array_to_string(x.model_hint, ' '))) AS hay,
               lower(x.title) AS lt
          FROM public.prompt x
         WHERE x.author_id = ws AND x.deleted_at IS NULL AND x.state = 'active'),
      s AS (
        SELECT r.g, r.body,
               (SELECT coalesce(sum(length(t.term) * ((strpos(r.hay, t.term) > 0)::int + (strpos(r.lt, t.term) > 0)::int)), 0) FROM t) AS score,
               (SELECT min(nullif(strpos(lower(r.body), t.term), 0)) FROM t) AS pos
          FROM r),
      best AS (
        SELECT DISTINCT ON (s.g) s.g, s.score, s.body, s.pos FROM s WHERE s.score > 0 ORDER BY s.g, s.score DESC),
      top AS (SELECT * FROM best ORDER BY score DESC LIMIT 20)
      SELECT jsonb_agg(jsonb_build_object('group_id', top.g, 'score', top.score,
               'text', CASE WHEN top.pos IS NULL THEN left(top.body, 100)
                            ELSE substr(top.body, greatest(1, top.pos - 30), 120) END) ORDER BY top.score DESC)
        FROM top), '[]'::jsonb);
  END IF;

  -- ---------- 維護者：誤刪救回
  IF op = 'restore' THEN
    UPDATE public.prompt SET deleted_at = NULL, updated_at = clock_timestamp()
     WHERE id = (request->>'id')::uuid AND author_id = ws AND deleted_at IS NOT NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN RAISE EXCEPTION '已經來不及復原了，請重新載入看看'; END IF;
    RETURN jsonb_build_object('restored', true, 'id', (request->>'id')::uuid);
  END IF;
  IF op = 'restore_many' THEN
    UPDATE public.prompt SET deleted_at = NULL, updated_at = clock_timestamp()
     WHERE id = ANY(public.shared_uuid_list(request->'ids')) AND author_id = ws AND deleted_at IS NOT NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN jsonb_build_object('restored', n);
  END IF;

  -- ---------- 改某一個範例的說明或角色（沿用 011）
  IF op IN ('example_caption', 'example_role') THEN
    IF op = 'example_caption' AND length(coalesce(request->>'caption', '')) > 200
      THEN RAISE EXCEPTION '範例說明最多 200 字'; END IF;
    IF op = 'example_role' AND coalesce(request->>'role', '') NOT IN ('input', 'output')
      THEN RAISE EXCEPTION '範例角色不正確'; END IF;
    IF coalesce(request->>'entry_id', '') = '' AND coalesce(request->>'path', '') = ''
      THEN RAISE EXCEPTION '缺少要修改的範例'; END IF;
    UPDATE public.prompt SET examples = coalesce((
       SELECT jsonb_agg(CASE
         WHEN (request->>'entry_id' IS NOT NULL AND e->>'id' = request->>'entry_id')
           OR (request->>'path' IS NOT NULL AND e->>'path' = request->>'path')
         THEN e || CASE WHEN op = 'example_caption'
              THEN jsonb_build_object('caption', left(coalesce(request->>'caption', ''), 200))
              ELSE jsonb_build_object('role', request->>'role') END
         ELSE e END ORDER BY ord)
       FROM jsonb_array_elements(examples) WITH ORDINALITY AS t(e, ord)), '[]'),
     updated_at = clock_timestamp()
     WHERE id = (request->>'id')::uuid AND author_id = ws AND deleted_at IS NULL
     RETURNING * INTO p;
    IF p.id IS NULL THEN RAISE EXCEPTION '找不到這個 Prompt，請重新整理'; END IF;
    result := public.shared_prompt_card(p);
  ELSE
    result := public.prompt_library_impl(request - 'maintainer' - 'agent');
  END IF;

  -- 訪客拿到的卡片一律只有表面；匯入與存成新版本回傳的是自己剛送出的內容，照原樣
  IF NOT trusted AND op NOT IN ('import', 'version') THEN
    result := public.shared_strip(result);
  END IF;
  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.prompt_library(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prompt_library(jsonb) TO anon, authenticated;

COMMIT;
