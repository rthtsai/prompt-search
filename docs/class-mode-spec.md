# Prompt 辭典 班級版（ai-class-lab）施工規格 v3

> 交給 Claude Code 施工用。放進 repo 的 `docs/class-mode-spec.md`，依第九節逐日進行。
> 定案日：2026/9/24（v3）。上線日：**2026/10/2（五）13:15**，高中 10 年級 AI 課第一次使用。
> 本檔取代 v1、v2。v1 的 PIN 登入方案已作廢，只在 Google 登入完全失敗時才回頭參考。
> **v3 新增：多班級、多老師。** Artemis 也會用這套教她的學生，所以老師權限一律限定在自己的班。

---

## 一、範圍與已定決策

這一版只做三件事：**身分與權限**、**prompt 附輸出（含圖片）**、**任務與並排比較**。

已定決策：

| 編號 | 決定 |
|---|---|
| A4 | 網址與 repo 都叫 `ai-class-lab`；網址 `https://rthtsai.github.io/ai-class-lab/` |
| A1–A3 | 與 prompt-search 同一份原始碼，build 兩次；資料庫各自獨立；原版建置結果必須不變 |
| B2 | 學生用**自己的 Google 帳號**登入（不限學校網域）；輸入班級代碼申請加入，老師核可後才能使用 |
| B3 | 學生之間只看得到暱稱；老師後台看得到暱稱對應的 Google 姓名與信箱 |
| B6 | 取消（不做 PIN，帳號安全交給 Google） |
| D1 | 老師可建全班任務，學生可建本組任務，兩者都要 |
| G1 | 原版**先不加**寫入密碼；改為務必定期匯出備份（G2） |
| I1 | 一個站容納多個班級；一個帳號可同時屬於多個班級，介面可切換 |
| I2 | 角色記在「某人在某班」上：同一個人可以在 A 班是老師、在 B 班是學生或助教 |
| I3 | 老師權限一律以班級為範圍——只看得到、只管得到自己是老師的班 |

不做（延後）：站內直接呼叫 LLM、題組自動評分、評分表、Supabase Storage、原版的寫入密碼、**老師在介面上自助開班**（10 月中再做，在那之前由 Richard 用腳本代開）、**誰有資格開班的管理機制**（目前只有兩位老師，不需要）。

---

## 二、部署架構

| | 原版 | 班級版 |
|---|---|---|
| 網址 | `rthtsai.github.io/prompt-search` | `rthtsai.github.io/ai-class-lab` |
| 建置結果 repo | `rthtsai/prompt-search` 的 `/docs` | `rthtsai/ai-class-lab` 的 `/docs` |
| Supabase 專案 | 現有，**不動** | 新專案 |
| SQL | `supabase/migrations/001–003` | 同上，再加 `supabase/class/004_class.sql` |
| 建置開關 | 無 | `NEXT_PUBLIC_CLASS_MODE=true` |

規定：

1. `supabase/class/004_class.sql` 檔頭寫明「僅限班級專案，請勿套用於 prompt-search」。
2. 所有班級功能以 `classMode` 開關包住。
3. 新增指令 `pnpm pages:build:class`：讀 `.env.class`（不進版控），`PAGES_BASE_PATH=/ai-class-lab`，輸出到 `pages-demo/out-class/`，另附腳本同步到 `../ai-class-lab/docs/`（含 `.nojekyll`）。
4. 每次提交前跑 `pnpm pages:build` 並與改動前的輸出比對，確認原版沒有變化。

---

## 三、登入與加入班級

### 3.1 Google 登入（Supabase Auth）

- 用 Supabase Auth 的 Google provider，前端 `signInWithOAuth`，轉址回 `https://rthtsai.github.io/ai-class-lab/`。
- **不限網域**：任何 Google 帳號都能登入，門檻在「加入班級」那一關。
- 之後每次呼叫 RPC 都帶使用者的 JWT，伺服器端以 `auth.uid()` 判斷身分。

老師要先在 Google Cloud 完成設定（見第十節），開發端無法代勞。

### 3.2 多班級與角色（v3 新增）

- 一個站裡可以有多個班級，彼此完全隔離：Richard 的 10 年級、11 年級，Artemis 自己的班。
- 一個 Google 帳號可以同時屬於多個班級，頂端列可切換；所有查詢與寫入都以「目前班級」為範圍。
- 角色（`teacher` / `assistant` / `student`）是「某人在某班」的屬性，不是帳號的屬性。同一個人可以在 A 班是老師、在 B 班是學生。
- **老師的權限只及於自己是老師的班。** Richard 看不到 Artemis 班上的任何內容與名單，反之亦然。

### 3.3 加入班級的流程

1. 登入後若尚未屬於任何班級 → 顯示「輸入班級代碼」。
2. 輸入正確代碼 → 建立一筆 `status='pending'` 的成員紀錄，畫面顯示「已送出，等老師核可」。
3. 老師在後台看到待核可清單（Google 姓名、信箱、申請時間），逐筆核可或拒絕。
4. 核可後學生設定**暱稱**（2–12 字，同班唯一，提示不要用真名），才能開始使用。
5. `status='pending'` 的成員：除了自己的狀態，什麼都讀不到、寫不了。

限制：

- 班級有人數上限（`max_members`，預設 40），滿了就拒絕新申請。
- 班級代碼可由老師重新產生，舊代碼即時失效。
- 同一個 Google 帳號在同一班只能有一筆成員紀錄。

---

## 四、資料庫（`supabase/class/004_class.sql`）

### 4.1 新表

```sql
classroom(
  id uuid PK, code text UNIQUE NOT NULL, name text NOT NULL,
  owner_uid uuid NOT NULL,                       -- 開班的人（auth.users.id）
  max_members int NOT NULL DEFAULT 40,
  archived_at timestamptz,                       -- 學期末封存，不再接受加入
  created_at timestamptz DEFAULT now()
)

team(
  id uuid PK, class_id uuid NOT NULL → classroom, name text NOT NULL,
  UNIQUE(class_id, name)
)

membership(
  id uuid PK,
  class_id uuid NOT NULL → classroom,
  auth_uid uuid NOT NULL,                        -- auth.users.id
  email text NOT NULL, full_name text,           -- 來自 Google，只有老師看得到
  nickname text,                                 -- 學生端唯一顯示的名字
  role text NOT NULL CHECK (role IN ('student','assistant','teacher')) DEFAULT 'student',
  status text NOT NULL CHECK (status IN ('pending','active','removed')) DEFAULT 'pending',
  team_id uuid → team,
  joined_at timestamptz DEFAULT now(), last_seen timestamptz,
  UNIQUE(class_id, auth_uid),           -- 同一帳號在同一班只有一筆；不同班各有一筆
  UNIQUE(class_id, nickname)
)
-- teacher＝該班老師（核可、刪除、名單、匯出、重產代碼）
-- assistant＝助教，與老師相同但不可匯出個資、不可重產代碼
-- student＝學生。角色屬於「某人在某班」，同一帳號在不同班可以不同。

task(
  id uuid PK, class_id uuid NOT NULL → classroom,
  team_id uuid → team,                           -- NULL = 全班任務
  title text NOT NULL, description text NOT NULL DEFAULT '',
  created_by uuid NOT NULL → membership,
  created_at timestamptz DEFAULT now(), closed_at timestamptz
)

prompt_output(
  id uuid PK,
  prompt_id uuid NOT NULL → prompt,
  member_id uuid NOT NULL → membership,
  kind text NOT NULL CHECK (kind IN ('text','image')),
  text_body text,                                -- kind='text'，≤ 20000 字
  image_full text, image_thumb text,             -- kind='image'，base64 JPEG
  created_at timestamptz DEFAULT now(), deleted_at timestamptz
)

write_log(member_id uuid NOT NULL, at timestamptz NOT NULL DEFAULT now())
```

### 4.2 修改 `prompt`（僅班級專案）

```sql
ALTER TABLE prompt ADD COLUMN class_id  uuid REFERENCES classroom(id);
ALTER TABLE prompt ADD COLUMN team_id   uuid REFERENCES team(id);
ALTER TABLE prompt ADD COLUMN member_id uuid REFERENCES membership(id);   -- 真正的作者
ALTER TABLE prompt ADD COLUMN task_id   uuid REFERENCES task(id);
ALTER TABLE prompt ADD COLUMN featured  boolean NOT NULL DEFAULT false;
CREATE INDEX prompt_class_task ON prompt(class_id, task_id) WHERE deleted_at IS NULL;
```

**必改：本文最短長度。** 現行 `prompt.body`、`source_body` 的 CHECK 與 `shared_prompt_save()` 內的驗證都是 20–24000 字。班級專案一律改為 **1–24000**，否則學生寫的生圖 prompt（常常不到 20 字）存不進去。原版不動。

`author_id` 維持填共用使用者，真正作者記在 `member_id`。版本沿用 003 的 `group_id` / `version_no` / `version_note`。

### 4.3 圖片存法

- 前端縮圖後以 base64 JPEG 存在 `prompt_output`，不使用 Storage。
- 伺服器驗證：`image_full` ≤ 400 KB、`image_thumb` ≤ 40 KB，且必須是 JPEG（base64 開頭 `/9j/`）。
- 列表只回縮圖，點開才用 `output_get` 取原圖。
- 估算：30 人 × 20 張 × 400 KB ≈ 240 MB，在免費方案 500 MB 內。之後再搬到 Storage。

---

## 五、RPC 介面：`class_api(request jsonb)`

延續現有架構：瀏覽器只呼叫這一個函式，不直接讀寫資料表。

- `SECURITY DEFINER`、`SET search_path=''`；只 `GRANT EXECUTE` 給 `authenticated`（`anon` 只能呼叫 `join_request` 之前的狀態查詢）。
- 每次呼叫要帶 `class_id`（`me`、`join_request` 除外）。伺服器以 `auth.uid()` ＋ `class_id` 找出該班的 `membership`；`status<>'active'` 一律拒絕（除了 `me`、`join_request`、`set_nickname`）。
- 所有查詢與寫入都限定在這個 `class_id`。**不得有任何一條路徑可以不帶 `class_id` 就讀到資料。**
- **老師權限一律以班級為範圍**：判斷條件是「呼叫者在這個 `class_id` 的角色是 `teacher` 或 `assistant`」，不是「這個人是老師」。整份程式不得出現全域的老師判斷或寫死的管理者 uid。
- 寫入限流：每位成員 10 分鐘內最多 60 次寫入，超過回傳「操作太頻繁」。

| op | 權限 | 說明 |
|---|---|---|
| `me` | 已登入 | 回傳**自己所屬的所有班級**（班名、角色、狀態）與上次使用的班級；沒有班級時回空清單 |
| `join_request` | 已登入 | `{class_code}`；檢查人數上限；建立 `pending` 紀錄 |
| `set_nickname` | 已核可 | 2–12 字、同班唯一 |
| `list` | 已核可 | 全班 prompt 最新版＋作者暱稱、組別、任務、精選、最新輸出縮圖；支援 `scope: mine / team / class / featured` 與 `task_id` |
| `get` | 已核可 | 單筆 prompt 的全部版本與輸出 |
| `save` / `edit` / `version` | 作者本人 | 包住既有的 `shared_prompt_save()`，自動填 `class_id`、`team_id`、`member_id`；`version` 要求 `version_note` 非空 |
| `delete` | 作者本人或老師 | 軟刪除 |
| `output_add` | prompt 作者本人 | `{prompt_id, kind, text_body \| image_full + image_thumb}`；每個版本最多 5 筆 |
| `output_delete` | 上傳者本人或老師 | 軟刪除 |
| `output_get` | 已核可 | 取原圖 |
| `task_list` | 已核可 | 全班任務＋自己組的任務 |
| `task_create` | 老師建全班或任一組；學生只能建自己組的 | `{title, description, team_id?}` |
| `task_close` | 該班老師或建立者 | |
| `compare` | 已核可 | `{task_id}` → 該任務下所有 prompt（含歷史版本）與輸出，依組別、暱稱排序 |
| `feature` | 該班老師／助教 | 切換精選 |
| `roster` | 該班老師／助教 | 該班成員清單（含 email、full_name、暱稱、組別、最後登入），僅限自己是老師的班 |
| `approve` / `reject` / `remove_member` / `set_role` | 該班老師 | 核可、拒絕、移出、改角色（學生／助教／老師） |
| `team_assign` | 該班老師／助教 | 指派組別 |
| `team_create` / `team_rename` | 該班老師／助教 | |
| `rotate_code` | 該班老師 | 重新產生班級代碼，舊代碼立即失效 |
| `export` | 該班老師 | 該班 JSON（**不含 email 與 full_name**），格式要能被原版的「匯入我的 Prompt」讀入 |
| `purge_identities` | 該班老師 | 學期末用：清掉該班的 `email`、`full_name`，保留暱稱與內容 |
| `class_create` | 腳本用 | `{name, max_members}` → 建班、產代碼，呼叫者成為該班老師。v3 不開放介面 |
| `class_archive` | 該班老師 | 封存班級，不再接受加入 |

開班方式（v3）：用腳本 `scripts/class-setup.mjs` 建立班級、代碼與組別，並把指定的 Google 帳號設為該班 `role='teacher'`、`status='active'`。Artemis 要開班時，由 Richard 跑一次腳本幫她開班並設為該班老師，兩分鐘可完成；介面上的自助開班留到 10 月中。

---

## 六、前端（僅 `classMode`）

1. **登入頁**：一顆「用 Google 登入」按鈕，大字、適合 iPad。
2. **加入班級頁**：輸入班級代碼 → 等待核可的說明畫面 → 核可後設定暱稱。
3. **頂端列**：班級切換選單（只有一個班時直接顯示班名）、組別、暱稱、登出。切換後整頁資料跟著換，並記住上次選的班。
4. **列表頁**（沿用現有卡片）：加上作者暱稱、組別標籤、輸出縮圖、★精選；分頁篩選「我的／本組／全班／精選」＋任務下拉。隱藏 ChatGPT/Claude 匯入、合併版本、管理分類、英文版本。
5. **編輯頁**：加「屬於哪個任務」下拉；「存成新版本」時改版說明必填；**輸出區**兩顆按鈕「貼上文字結果」「上傳圖片」（`<input type="file" accept="image/*">`，前端縮圖至長邊 1280px、品質 0.8，另產 320px 縮圖），旁邊固定提示「請勿上傳同學或任何真人的照片」。
6. **任務頁／比較頁**：每位組員一欄並排顯示暱稱、prompt 本文、改版說明、輸出（點圖放大）；桌機一列 3–5 欄、iPad 直向 2 欄、手機 1 欄；每欄可切換版本（可延後）；全班任務依組別分區。
7. **老師後台**：只列出自己是老師或助教的班級，一次操作一個班——待核可清單、成員名單（改組別、改角色、移出）、任務管理、最近上傳圖片牆（可刪）、匯出、班級代碼重產、學期末清除個資與封存。投影模式（可延後）。

---

## 七、隱私

1. 學生端任何畫面都只顯示暱稱，不顯示姓名或信箱。
2. `email`、`full_name` 只出現在老師後台，且不進匯出檔。
3. 上傳圖片禁止真人照片：畫面提示＋老師可刪。
4. 別班的代碼或 token 讀不到這班資料。**老師也一樣**：Richard 看不到 Artemis 班上的任何內容與名單，反之亦然。
5. 學期末可用 `purge_identities` 清除個資，內容保留。
6. 第一堂課要向學生說明：用的是他們自己的 Google 帳號，信箱只有老師看得到，同學之間只看得到暱稱。

---

## 八、驗收清單（10/2 前全部要在真的 iPad Safari 與手機上跑過）

1. 原版 `prompt-search` 的建置結果與改動前一致；原版 Supabase 專案無任何變更。
2. 30 個 Google 帳號在 5 分鐘內登入、申請加入、老師核可、設定暱稱、新增 prompt，全程無錯誤。
3. 未核可的帳號讀不到任何班級資料（直接用 curl 打 RPC 驗證）。
4. 學生 A 無法 `edit` / `delete` 學生 B 的 prompt 或輸出（同樣用 curl 驗證，不能只靠介面隱藏）。
5. 老師可刪除任何 prompt 與圖片。
6. 別班代碼讀不到本班資料。
7. 11 字的 prompt 存得進去；空白的存不進去。
8. iPad 從相簿上傳 HEIC 照片會轉成 JPEG 並縮圖成功；10 MB 原圖也能處理。
9. 同一任務下 5 位組員各兩個版本 → 比較頁 5 欄正確、可切版本。
10. 班級人數上限生效；重產代碼後舊代碼失效。
11. 匯出的 JSON 不含 email 與姓名，且能被原版匯入。
12. Google 登入在 iPad Safari 上可完成（含轉址回站）。
13. **跨班隔離**：建 A、B 兩班，老師各為不同帳號。A 班老師對 B 班呼叫 `roster`、`list`、`delete`、`approve`、`export` → 全部被拒（用 curl 驗證）。
14. **一人多班**：同一帳號同時加入 A、B 兩班，切換後只看得到該班資料；在 A 班是老師、B 班是學生時，兩邊權限各自正確。
15. 全域搜尋程式碼，確認沒有寫死的管理者 uid，也沒有不帶 `class_id` 的查詢。

---

## 九、開發順序（9/23 → 10/1）

| 日期 | 工作 |
|---|---|
| 9/23 | 建班級 Supabase 專案並套 001–003；寫 004（新表、改長度、`class_api` 的 `me`／`join_request`／`set_nickname`／`list`／`save`）；SQL 測試 |
| 9/24 | 完成其餘 op（含老師端）；用 curl 跑驗收 3、4、6、10 |
| 9/25 | 前端：`classMode`、Google 登入、加入班級、暱稱、頂端列、列表篩選、隱藏用不到的功能 |
| 9/26 | 編輯頁：任務下拉、必填改版說明、輸出區（文字＋圖片縮圖上傳） |
| 9/27 | 任務頁與比較頁 |
| 9/28 | 老師後台（核可、名單、組別與角色、圖片牆、匯出）；班級切換選單；跨班權限測試（驗收 13–15） |
| 9/29 | 建 `rthtsai/ai-class-lab` repo，建置並發布；建立班級與代碼；老師帳號設定 |
| 9/30 | iPad／手機實測，跑完驗收清單，修 bug |
| 10/1 | 緩衝。列印班級代碼與使用說明，備課 |

**砍除順序（僅在落後時）**：投影模式 → 精選 → 匯出 → 比較頁版本切換 → 隱藏用不到的功能 → 班級切換選單的**介面**（暫時固定進入唯一的班）。資料結構的多班設計與以班級為範圍的權限判斷**不可砍**——那是之後補最貴的部分。身分與權限、輸出上傳、比較頁本身、老師的核可與刪除權也不可砍。

**最壞情況**：班級站無法如期上線 → 10/2 改用 Google 表單收 prompt 與截圖，之後匯入；班級站延到 11/27 啟用。

**10/2 前的測試範圍只限 Richard 的 10 年級班。** Artemis 的班和 11 年級班，等這邊跑順後 10 月中再開，避免上線前同時顧兩邊。

---

## 十、老師要先完成的事（開發端無法代勞）

1. 開一個新的 Supabase 專案（班級專用），記下專案網址與 anon key。
2. 建立 `rthtsai/ai-class-lab` repo。
3. Google Cloud（`console.cloud.google.com`，用自己的 Google 帳號，免費）：
   - 建專案 `ai-class-lab`。
   - OAuth 同意畫面：類型「外部」，只要 `email`、`profile`、`openid` 這三個基本權限範圍。
   - 建立「OAuth 用戶端 ID」→ 網頁應用程式 → 已授權的重新導向 URI 填 `https://<專案代號>.supabase.co/auth/v1/callback`。
   - 把 Client ID 與 Secret 填進 Supabase → Authentication → Providers → Google。
   - Supabase → URL Configuration 的 Site URL 與 Redirect URLs 加入 `https://rthtsai.github.io/ai-class-lab/`。
4. 原版（prompt-search）**立刻匯出一份 JSON 備份**，之後定期匯出。原版這次不做任何程式改動。
