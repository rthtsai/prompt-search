# 共用雲端辭典部署

目前程式已具備 Supabase 共用儲存功能；必須建立 Supabase 專案並套用 SQL，才能切換正式網站。GitHub Pages 繼續負責網站，Supabase 負責資料。無需為辭典使用者建立帳號。

## 一次性設定

1. 用專案擁有者帳號登入 Supabase，建立資料庫專案。登入、服務條款與密碼由帳號擁有者完成。
2. 若已有本專案 `db/001_init.sql` 的資料表，只執行 `supabase/migrations/002_shared_library.sql`。全新專案先執行 `supabase/001_fresh_project.sql` 再執行 002。新專案保留同樣的資料表與關聯，文字索引使用 Supabase 支援的 pg_trgm，取代 pg_bigm。
3. 在建置環境設定下列公開資訊（不要設定 service_role 或資料庫密碼到前端）：

```sh
NEXT_PUBLIC_STORAGE_MODE=cloud
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_OR_ANON_KEY
PAGES_BASE_PATH=/prompt-search
```

4. 用以上環境變數執行 `pnpm pages:build`，將 `pages-demo/out/` 同步至 GitHub `main` 的 `docs/`，包含 `.nojekyll`。GitHub Pages 仍維持 `/docs` 發布。請勿上傳用測試網址建置的產物。
5. 打開正式網址，應看到「共用雲端辭典」，確認舊資料遷移結果。

## 資料與遷移

- 沿用 `prompt`、`category`、`app_user` 等既有 schema。共用辭典使用固定的共用工作空間作者，SQL RPC 只操作該工作空間；不會公開其他作者原有的私人資料。
- 任何持有公開金鑰的訪客都可操作共用辭典，符合此版本的無帳號需求。直接表格寫入權限未開放；RPC 會檢查欄位、批次大小與編輯版本。
- 真實 AI 向量未生成時 `embedding` 為 NULL，`embedding_model` 為 `not-generated`；沿用關鍵字搜尋，不偽造 AI 向量。
- 遷移包含已上線的 `prompt-dictionary-pages-v1` IndexedDB，以及 localStorage 舊版鍵 `prompts`、`promptLibrary`、`promptDictionary`、`prompt-search*`、`prompt-dictionary*`、`prompt-library*` 等。localStorage 支援陣列、`{prompts:[]}` 或 `{items:[]}`，本文支援 `body`／`content`／`prompt`。
- 未知或壞掉的資料不會清除。單一來源全部上傳並收到確認後才清除；失敗保留原來源，畫面提供重新同步。清除前再比對本機快照，避免另一分頁新資料被刪除。
- 伺服器以 NFKC、忽略大小寫與空白的本文 SHA-256 去重，利用既有 `(author_id, normalized_hash)` 唯一約束處理併發上傳。重複本文保留雲端現有 metadata，不覆蓋別人的編輯。
- localStorage 的 `prompt-search:cloud-cache:v1` 只保存已確認的雲端讀取結果。快取不是待上傳佇列，也不作遷移來源。離線讀取標示快取；離線寫入不回報儲存成功。
- 刪除寫入 `deleted_at`，資料立即從共用辭典消失，資料庫管理員仍可復原。舊裝置若再遷移同樣的已刪除本文，會保留本機資料並提示，而非悄悄復活刪除內容。
- 編輯、刪除使用 `updated_at` 比對；過期版本不會覆蓋最新資料。使用紀錄以事件 UUID 去重。
- 「匯出全部（JSON）」讀取完整雲端資料（分頁，不只畫面上的搜尋結果），同時附上尚未遷移的本機原始資料。雲端無法連線時會明確回報失敗，不將不完整快取冒充完整備份。

## 驗證與限制

`pnpm test` 包含本機 PostgreSQL（PGlite）的 RPC 整合測試、兩個獨立 client 的新增／重新讀取／編輯／刪除、真實 IndexedDB API 模擬器的遷移測試、部分上傳失敗重試、metadata 保留及超過 1,000 筆的完整讀取。PGlite 未附帶 pgvector，因此 SQL 測試僅將向量欄位型別改成陣列並略去 HNSW 索引，其餘 schema 與實際 migration 執行原始 SQL。

這些測試不等於實際 iPhone Safari／桌機 Chrome 驗收。正式專案連線後，需完成：

1. 手機 Safari 匯入含唯一測試名稱的 Prompt，按「加入我的辭典」。
2. 重新整理，確認同筆仍存在。
3. 在桌機 Chrome 開同一網址，搜尋該唯一名稱，確認內容相同。
4. 桌機修改，手機重新整理確認修改；測試刪除也應跨裝置生效。
5. 測試本機舊資料遷移、模擬斷網保留資料，及 JSON 下載可解析且筆數與完整雲端資料一致。
