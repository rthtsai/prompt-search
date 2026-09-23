# Prompt 辭典

可搜尋、分類、匯入、填變數並複製的繁體中文網頁 App。已有 Next.js 前端與桌面／手機排版。

## 執行方式

| 版本 | 執行位置 | 儲存方式 | 搜尋與整理 |
| --- | --- | --- | --- |
| Supabase 共用雲端版（待設定專案） | GitHub Pages + Supabase Postgres | 雲端為主，localStorage 僅作快取 | 共用新增／編輯／刪除、舊資料遷移、JSON 備份 |
| GitHub Pages 示範版 | 靜態網站，直接用瀏覽器開啟 | 目前瀏覽器的 IndexedDB | 中文關鍵字、同義詞與規則整理 |
| 本機開發版 | Next.js 本機服務 | `.data/web/library.json` | 本機測試向量與規則整理 |

正式 AI、雲端帳號、跨裝置同步、分享額度尚未連接到前端。原本的 PostgreSQL／pgvector／pg_bigm 與 OpenAI adapter 仍保留於 `src/`，目前透過 CLI 驗證，不能宣稱正式搜尋驗收已完成。

Supabase 連線程式、遷移 SQL 與測試已加入。**正式網站尚未切換雲端**：需先建立擁有者的 Supabase 專案，完成設定與實機驗收。詳見 [共用雲端部署與驗收](docs/supabase-setup.md)。

## 已有介面功能

- 搜尋、分類、標籤、最近使用與最常用排序。
- 填入變數，即時预覽完整 Prompt，再複製到剪貼簿。
- 複製成功後記錄使用次數，必填變數不能留空。
- 貼上文字、上傳 `.txt`／`.md`／`.json`、ChatGPT／Claude JSON 匯出解析。
- 匯入進度、整理預覽、確認後才加入辭典。
- 編輯範本、另存一份並保留來源關係。
- `/` 搜尋、方向鍵選取、Enter 使用；桌面與手機版排版。
- PWA manifest 與 App 圖示；安裝行為依瀏覽器支援。

Pages 版的資料只留在各自瀏覽器，其他訪客看不到；清除網站資料會刪除收藏，不會自動同步或備份。Pages 版只做正規化後的相同本文去重；正式後端的 SimHash 近似去重仍在 CLI pipeline。兩種版本的差異不是正式 AI 品質驗收。

## 共用雲端版新增功能（2026-09-22，需套用 `003` migration）

- **版本**：同一個 Prompt 可以有 V1、V2…，卡片只顯示最新版並標示「V5 · 5 版」，詳細頁可切換、刪除舊版；「存成新版本」保留原版。已分開存的舊資料可在「整理（多選）」勾選後「合併成版本」，並調整新舊順序。
- **中英文版本**：同一筆可另存英文版本，詳細頁用「中文／English」切換，複製時複製目前語言；兩種語言共用同一組變數設定。
- **分類**：分類存在資料庫，可在側欄「管理分類」新增、改名、排序、刪除（刪除後的 Prompt 移到「其他」，「其他」固定在最後）。「整理（多選）」可一次改分類、刪除；在「其他」分類裡，每張卡片可直接選分類移走；也可以把卡片直接拖到側欄或首頁的分類上（多選時會一起移動）。
- **同步**：上方顯示「已同步 HH:MM」，點一下重新整理；畫面開著時每 20 秒檢查一次雲端是否有變動，有才重新載入。
- **選項式變數**：編輯時可把每個 `{{變數}}` 設成自由填寫、下拉選單、單選按鈕或數字，並設定選項與是否必填。
- **刪除**：卡片右上角直接有刪除鈕（連同所有版本），詳細頁的刪除只刪目前版本。
- **範例圖片**：每則 Prompt 可以上傳最多 6 張產出範例（JPG／PNG／WebP，上傳前自動縮到長邊 1600px、3 MB 以內），詳細頁可放大檢視，卡片會顯示第一張當封面。圖片存在 Supabase Storage 的公開 bucket `prompt-examples`，任何人都看得到；移除只是從 Prompt 取消關聯，檔案仍留在 bucket 中。

套用方式：在 Supabase SQL Editor 依序執行 `supabase/migrations/003_versions_languages_categories.sql`、`004_examples.sql`、`004_storage.sql`（都可重複執行），再重新建置並發布 `docs/`。本機與瀏覽器示範版不支援上述管理功能，介面會自動隱藏。

## 本機啟動

需要 Node.js 24 或以上與 pnpm。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

開啟 `http://127.0.0.1:3000`。正式建置可執行 `pnpm build`，再執行 `pnpm start`。

## GitHub Pages 建置

```sh
PAGES_BASE_PATH=/prompt-search pnpm pages:build
```

可部署檔案在 `pages-demo/out/`，不需要 Node.js 伺服器，也不會呼叫本機 `/api`。

`PAGES_BASE_PATH` 必須符合實際網站路徑：

- 專案網站 `https://帳號.github.io/prompt-search/`：設定 `/prompt-search`。
- 放到既有網站子目錄 `https://帳號.github.io/iisr-lab/prompt-search/`：設定 `/iisr-lab/prompt-search`。
- 帳號根網站或自訂網域根目錄：設定空字串。

已部署至 https://rthtsai.github.io/prompt-search/ ，原始碼位於 https://github.com/rthtsai/prompt-search 。GitHub Pages 使用 `main` 分支的 `/docs` 資料夾；更新網站時，將 `pages-demo/out/` 的建置結果同步到 `docs/`（包含 `.nojekyll`）並提交。

`docs/github-pages-workflow.yml` 是日後改用 GitHub Actions 的選用範本，目前未啟用。

## 驗證

```sh
pnpm test
pnpm typecheck
pnpm build
pnpm pages:build
```

已有 58 項本機邏輯／CLI／App service／Pages 搜尋測試。Next.js 本機版與 Pages 版都已成功建置；公開網站已驗證首頁、中文搜尋與變數即時預覽；複製功能尚未確認剪貼簿結果，正式 AI／PostgreSQL 整合也尚未驗收。

`.env*`、`.data/`、`node_modules/`、`.next/` 不納入版本控制；只有 `.env.example` 是公開範例。

後端資料模型、正式服務設定與 CLI 流程見 [第一階段後端紀錄](docs/backend-milestone.md)。該文件是前一階段紀錄，前端現況以本文件為準。
