# Prompt 辭典 班級版（Class Mode）開發規格 v1

> 給 Claude Code 的實作規格。放進 repo 的 `docs/class-mode-spec.md` 後，請它依「七、開發順序」逐步完成。
> 目標上線日：**2026/10/2（五）13:15**，高中 10 年級 AI 課第一次使用。

---

## 一、範圍

這一版只做三件事，其他都不做：

1. **班級、個人、組別三層身分**，以及「只能改自己的、老師能管全部」的權限。
2. **每個 prompt 版本可以附上輸出**：文字或圖片（生圖結果）。
3. **任務與並排比較**：同一個任務底下，組員各寫一版 prompt，並排比較 prompt 與輸出。

明確不做（留到之後）：在網站內直接呼叫 LLM、題組自動評分、評分表、Google 登入、Supabase Storage。

---

## 二、部署架構：同一份程式，兩個獨立部署

| | 原版（Richard＋Artemis） | 班級版 |
|---|---|---|
| 網址 | `rthtsai.github.io/prompt-search` | `rthtsai.github.io/prompt-class` |
| GitHub repo | `rthtsai/prompt-search`（原始碼＋`/docs`） | `rthtsai/prompt-class`（只放建置結果的 `/docs`） |
| Supabase 專案 | 現有專案，**不動** | **新開一個專案** |
| Migration | 001、002、003 | 001、002、003，再加 **004_class.sql** |
| 建置開關 | `NEXT_PUBLIC_CLASS_MODE` 不設 | `NEXT_PUBLIC_CLASS_MODE=true` |

硬性規定：

- `004_class.sql` **只能**套用在班級專案。檔案開頭加註解警告，並放在 `supabase/class/` 資料夾，不要放進 `supabase/migrations/`，避免誤套到原版。
- 班級相關的程式碼全部用 `classMode` 開關包住。原版的建置結果和現在必須完全一樣：用 `pnpm pages:build` 前後的輸出比對來驗證。
- 新增指令 `pnpm pages:build:class`：讀 `.env.class`（不進版控），把 `PAGES_BASE_PATH` 設為 `/prompt-class`，輸出到 `pages-demo/out-class/`。另寫一個腳本同步到 `../prompt-class/docs/`（含 `.nojekyll`）。

---

## 三、身分設計：班級代碼＋座號＋PIN

選這個方案而不是 Google 登入，原因是：不需要學校資訊組核准外部網站使用學校帳號，10/2 前一定做得完。沿用現有架構，瀏覽器只呼叫一個 `SECURITY DEFINER` 的 RPC，不直接讀寫資料表，也不使用 Supabase Auth。

流程：

1. 老師用腳本 `scripts/class-roster.mjs` 產生名單：輸入班級名稱與人數，輸出一份 CSV（座號、PIN）給老師發給學生，以及一段 SQL 在班級專案執行。PIN 為 6 位數字，資料庫只存 hash（`crypt()`＋`gen_salt('bf')`）。
2. 學生登入：輸入班級代碼、座號、PIN。第一次登入時要設定**暱稱**（2–12 字）。畫面提示「請勿使用真實姓名」。
3. 登入成功後，伺服器產生隨機 token（32 bytes），資料庫只存它的 sha256。瀏覽器把 token 存進 `localStorage`，有效期到學期結束（2027/1/31）。
4. 之後每次呼叫 RPC 都帶 token，伺服器據此判斷是哪位成員。
5. 換電腦時重新登入即可。忘記 PIN 由老師在後台重設。
6. 老師也是一位 `role='teacher'` 的成員，PIN 改為至少 12 字元的密碼。

登入要擋暴力破解：同一個「班級＋座號」連續錯 5 次，就鎖 10 分鐘。

---

## 四、資料庫（`supabase/class/004_class.sql`）

### 新增資料表

```sql
classroom(
  id uuid PK, code text UNIQUE NOT NULL,        -- 班級代碼，例如 'ai10a-7k2p'
  name text NOT NULL, created_at timestamptz
)
team(
  id uuid PK, class_id uuid → classroom, name text NOT NULL,   -- 第 1 組…
  UNIQUE(class_id, name)
)
member(
  id uuid PK, class_id uuid → classroom, seat_no int NOT NULL,
  nickname text,                                 -- 首次登入才填
  role text CHECK (role IN ('student','teacher')),
  team_id uuid → team NULL,
  pin_hash text NOT NULL,
  failed_logins int DEFAULT 0, locked_until timestamptz,
  UNIQUE(class_id, seat_no)
)
member_session(
  token_hash text PK, member_id uuid → member, expires_at timestamptz
)
task(
  id uuid PK, class_id uuid → classroom,
  team_id uuid → team NULL,                      -- NULL＝全班任務
  title text NOT NULL, description text DEFAULT '',
  created_by uuid → member, created_at timestamptz, closed_at timestamptz
)
prompt_output(
  id uuid PK, prompt_id uuid → prompt, member_id uuid → member,
  kind text CHECK (kind IN ('text','image')),
  text_body text,                                -- kind=text，上限 20,000 字
  image_full text, image_thumb text,             -- kind=image，base64 JPEG
  created_at timestamptz, deleted_at timestamptz
)
write_log(member_id uuid, at timestamptz)        -- 限流用
```

### 修改現有的 `prompt` 表（只在班級專案）

```sql
ALTER TABLE prompt ADD COLUMN class_id uuid REFERENCES classroom(id);
ALTER TABLE prompt ADD COLUMN team_id  uuid REFERENCES team(id);
ALTER TABLE prompt ADD COLUMN author_member_id uuid REFERENCES member(id);
ALTER TABLE prompt ADD COLUMN task_id  uuid REFERENCES task(id);
ALTER TABLE prompt ADD COLUMN featured boolean NOT NULL DEFAULT false;   -- 老師精選
```

**必改：本文最短長度。** 現行規則是 `body` 20–24,000 字，但學生寫的生圖 prompt 常常不到 20 字（例如「把這張照片變成吉卜力風」只有 11 個字），會存不進去。班級專案要把 `prompt.body`、`source_body` 的 CHECK，以及 `shared_prompt_save()` 裡的長度驗證，一起改成 1–24,000。

`author_id` 照舊填共用使用者（`00000000-…-0001`），真正的作者記在 `author_member_id`。版本機制沿用 003 的 `group_id`、`version_no`、`version_note`；「這版改了什麼、為什麼」就用 `version_note`，班級版的介面要把它設為**必填**。

### 圖片存法（v1 刻意從簡）

圖片以 base64 JPEG 存在 `prompt_output`，不用 Supabase Storage。原因是 Storage 的上傳權限要搭配 Supabase Auth 或 Edge Function，10 天內做不完。

- 由瀏覽器先縮圖：原圖長邊縮到 1280px、品質 0.8，縮圖長邊 320px。
- 伺服器端驗證：`image_full` ≤ 400 KB、`image_thumb` ≤ 40 KB，並且開頭必須是 JPEG 的 base64 標記（`/9j/`）。
- 列表只回傳縮圖，點開才用 `output_get` 取原圖。
- 用量估算：30 人 × 每人 20 張 × 400 KB ≈ 240 MB，在免費方案 500 MB 以內。**v2 再搬到 Storage。**

### RPC：`class_api(request jsonb)`

- 屬性：`SECURITY DEFINER`、`SET search_path=''`。只 `GRANT EXECUTE` 給 anon，其他資料表全部 `REVOKE`，比照 002 的做法。
- 除了 `login`，每個操作都必須帶 `token`。先解出成員；token 無效或過期就丟出例外「請重新登入」。
- 所有讀取都限定在該成員所屬的班級（`class_id`）。
- 寫入限流：每位學生 10 分鐘內最多 60 次寫入，超過就回傳「操作太頻繁，請稍後再試」。

| op | 誰可以用 | 說明 |
|---|---|---|
| `login` | 任何人 | `{class_code, seat_no, pin}` → `{token, member}`；失敗計次、鎖定 |
| `me` / `set_nickname` | 本人 | 取得自己的資料；設定暱稱（2–12 字，同班不可重複） |
| `list` | 同班 | 全班 prompt（最新版）＋作者暱稱、組別、任務、精選、最新一張輸出縮圖；可用 `scope: mine / team / class / featured`、`task_id` 篩選 |
| `save` / `edit` / `version` | 作者本人 | 包一層 002/003 的既有邏輯，自動填入 `class_id`、`team_id`、`author_member_id`；`version` 要求 `version_note` 非空 |
| `delete` | 作者本人或老師 | 軟刪除（`deleted_at`） |
| `output_add` | prompt 作者本人 | `{prompt_id, kind, text_body | image_full+image_thumb}`，一個版本最多 5 筆輸出 |
| `output_delete` | 輸出者本人或老師 | 軟刪除 |
| `output_get` | 同班 | 取原圖 |
| `task_list` | 同班 | 全班任務，加上自己組的任務 |
| `task_create` | 老師；學生只能建本組任務 | `{title, description, team_id?}` |
| `compare` | 同班 | `{task_id}` → 該任務底下所有 prompt（每人最新版與全部歷史版本）及其輸出，依組別、座號排序 |
| `feature` | 老師 | 切換精選 |
| `roster` / `team_assign` / `pin_reset` | 老師 | 名單、分組、重設 PIN（回傳新 PIN 一次，之後只存 hash） |
| `export` | 老師 | 全班資料 JSON（不含 PIN hash、token），格式要能被原版的「匯入我的 Prompt」讀進去 |

---

## 五、介面（只在 `classMode` 下出現）

### 1. 登入頁
- 三個欄位：班級代碼、座號、PIN，大字、適合 iPad。
- 首次登入後進入「設定暱稱」頁。

### 2. 頂端列
- 顯示班級名、組別、暱稱、登出。

### 3. 列表頁（沿用現有卡片）
- 卡片多顯示：作者暱稱、組別標籤、輸出縮圖、★精選。
- 篩選分頁：我的／本組／全班／精選，外加任務下拉選單。
- **隱藏**：ChatGPT/Claude 匯入、合併版本、管理分類、英文版本（學生用不到，只會造成混亂）。

### 4. 編輯頁
- 多一個「屬於哪個任務」下拉選單（可不選）。
- 「存成新版本」時，「這版改了什麼、為什麼」為必填。
- **輸出區**：兩個按鈕，「貼上文字結果」和「上傳圖片」。上傳用 `<input type="file" accept="image/*">`，iPad 可從相簿或相機選取。上傳前在瀏覽器縮圖，並顯示進度。
- 上傳按鈕旁固定提示：「請勿上傳同學或任何真人的照片」。

### 5. 任務頁與比較頁（本版重點）
- 任務頁：卡片列出任務標題、說明、已有幾人交。
- 比較頁：**每位組員一欄**並排顯示：暱稱、prompt 本文、`version_note`、輸出（圖片點開放大）。
  - 寬螢幕一列 3–5 欄，iPad 直向 2 欄，手機 1 欄。
  - 每一欄上方可以切換版本（V1、V2…），用來看「改之前和改之後」。
  - 全班任務可以依組別分區顯示。

### 6. 老師後台
- 名單：座號、暱稱、組別（下拉直接改）、重設 PIN、最後登入時間。
- 任務管理：新增、關閉。
- 最近上傳的圖片牆，每張都有刪除鈕（管理用）。
- 匯出 JSON。
- 投影模式（有空再做）：單一 prompt 全螢幕大字。

---

## 六、驗收清單（10/2 前逐條實測）

以下全部要在**真的 iPad Safari** 和手機上各跑一次，不能只在電腦上測。

1. 原版網站的建置結果與改動前一致；原版 Supabase 專案沒有任何變更。
2. 30 個帳號在 5 分鐘內同時登入、各自新增 prompt，沒有錯誤。
3. 學生 A 呼叫 `delete`、`edit`、`output_delete` 去動學生 B 的資料 → 被拒絕（直接用 curl 打 RPC 驗證，不能只靠介面藏按鈕）。
4. 老師可以刪除任何人的 prompt 和圖片。
5. 別班的班級代碼與 token 讀不到這一班的任何資料。
6. 11 字的 prompt 可以存；空白的不行。
7. iPad 從相簿上傳 HEIC 照片 → 自動轉成 JPEG 並縮圖，成功存入；10 MB 的原圖也能處理。
8. 同一個任務底下 5 位組員各兩個版本 → 比較頁 5 欄正確顯示，而且可以切換版本。
9. PIN 連續錯 5 次會被鎖；老師重設後可以重新登入。
10. 老師匯出的 JSON，可以用原版的「匯入我的 Prompt」讀進去。

---

## 七、開發順序（9/22 → 10/2）

| 日期 | 工作 |
|---|---|
| 9/23 | 開班級 Supabase 專案，套 001–003。寫 004：資料表、改長度限制、`class_api` 的 `login`、`me`、`list`、`save`。寫 SQL 測試 |
| 9/24 | 完成 `class_api` 其餘 op。用 curl 跑驗收第 3、5、9 項 |
| 9/25 | 前端：`classMode` 開關、登入頁、暱稱、頂端列、列表篩選、隱藏不需要的功能 |
| 9/26 | 編輯頁：任務選單、必填改版說明、輸出區（文字＋圖片縮圖上傳） |
| 9/27 | 任務頁與比較頁 |
| 9/28 | 老師後台、名單腳本、匯出 |
| 9/29 | 建立 `rthtsai/prompt-class` repo，建置並部署；產生正式名單與 PIN |
| 9/30 | iPad／手機實測，跑完整份驗收清單，修 bug |
| 10/1 | 保留作緩衝。PIN 單列印好，備課 |

**來不及時的取捨順序**：先砍老師後台的圖片牆與投影模式，再砍比較頁的版本切換。身分、權限、輸出上傳、比較頁本身不能砍。

---

## 八、上線前另外要做的一件事（原版）

原版目前任何人都能匿名編輯、刪除。學生知道 `rthtsai.github.io/prompt-class` 以後，很容易猜到 `/prompt-search`。建議在 10/2 前替原版的 `edit`、`delete`、`delete_many`、`merge` 等寫入操作加一組共用密碼，存成 hash 放在資料庫。這項改動與班級版無關，另開一個 commit。
