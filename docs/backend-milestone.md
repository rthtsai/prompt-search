# Prompt 辭典 · 第一階段實作

依據 `PromptSearch_規格書_v1.md` 建立的 TypeScript 後端，先處理規格 §10 的資料整理與搜尋門檻。**目前可以從命令列完整操作匯入、檢查預覽、接受與搜尋；還沒有網頁介面，也尚未完成正式服務驗收。**

## 已實作

- PostgreSQL schema：prompt 為主鍵、固定 12 大分類、最多兩層分類、作者、變數、使用紀錄及解鎖帳本。
- 貼上文字、`.txt`、`.md`、JSON 陣列、ChatGPT／Claude JSON 匯出解析；對話只取使用者訊息。
- Normalization + 64-bit SimHash；相似度嚴格大於 0.9 合併，長文為主，短文留下 fork 來源紀錄，重複來源不參與搜尋。
- 單次 Responses strict JSON schema 抽取名稱、摘要、用途、分類、標籤與變數；用變數原值還原本文檢查，避免模型偷偷改寫任務。
- 最多 500 則／10 MB 批次處理、最多四個 AI 工作並行、進度回報與逐筆錯誤。整理先產生本機預覽，接受後才交易式落庫。
- 正式搜尋：`text-embedding-3-small` 1536 維向量 + pg_bigm 中文全文 + 分類／標籤／模型精確匹配；每路 top 50，RRF `1/(60+rank)` 融合，再按個人使用、最近使用、使用次數與品質重排，回傳 top 10。
- 搜尋文字同義詞展開、明確分類／標籤／模型篩選、本文命中句與 highlight offsets。
- 私人資料隔離；公開但未解鎖的專業 prompt 不回傳本文、變數或原文片段。自己的 prompt 與非專業公開 prompt 不鎖定。
- AI 向量服務失敗時降級成全文與精確匹配，回應包含 `degraded: true`。

## 本機立即試用

需要 Node.js 24 或以上。套件已在這份工作目錄安裝；移到另一台電腦時先執行 `pnpm install --frozen-lockfile`。

```sh
pnpm demo
pnpm test
pnpm typecheck
```

這台 Mac 的 Node 沒有加入一般 PATH，可以用已隨附的 [run-demo.command](./run-demo.command)，或執行：

```sh
/Users/richardtsai/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node src/cli.ts demo
```

Demo 會建立六筆範例與一笔使用紀錄，儲存在 `.data/demo.json`，並逐項顯示七個搜尋案例的第一筆結果。再次執行 demo 會重設這份範例檔；正式資料庫不受影響。

**Demo 使用特徵雜湊向量與中文 bigram BM25，目的是測試程式流程；它不是正式 AI 語意搜尋，也沒有假裝呼叫 AI。** 正式 adapter 才使用 OpenAI embedding、PostgreSQL pgvector 與 pg_bigm；兩種 embedding 模型不能混用。

### 匯入自己的範例

```sh
node src/cli.ts import prompts.md --demo --preview .data/review.json
# 開啟 review.json 檢查整理結果
node src/cli.ts accept .data/review.json --demo
node src/cli.ts search "寫季度報告的" --demo
node src/cli.ts search "Midjourney 日系插畫" --demo --model midjourney
```

貼上文字也可以使用標準輸入：

```sh
echo '請為公司：晨光設計，撰寫季度報告，分析營收與成本並輸出摘要與表格。' | node src/cli.ts import - --demo
```

`import` 不會自動接受。`review.json` 包含原始本文、整理後本文、變數原值、embedding 與逐筆錯誤，請存放在私人位置。接受會儲存成功項目；失敗項目不會被當成成功。若要修改 prompt 本文，修改來源後重新整理，才能同步更新變數與向量；本階段尚未提供預覽編輯器。

## 連接正式 PostgreSQL 與 AI

需要 PostgreSQL 17、pgvector、pg_bigm，以及可用的 OpenAI API key 與支援 strict JSON schema 的整理模型。

```sh
cp .env.example .env
# 編輯 .env：填入 DATABASE_URL、OPENAI_API_KEY、OPENAI_EXTRACTION_MODEL
docker compose up -d --build
pnpm cli migrate
pnpm cli init-user
pnpm cli import fixtures/prompts.json --preview .data/live-review.json
pnpm cli accept .data/live-review.json
pnpm cli search "寫季度報告的"
```

若使用自己的遠端資料庫，可略過 Docker；先確認服務支援安裝 **pg_bigm**。不能只因服務有 pgvector 就當作滿足中文全文需求。隨附 Dockerfile 會安裝 pg_bigm 並預載 extension；這台環境沒有 Docker，因此尚未建置驗證這個映像。

`.env` 不會進入版本控制。不要把金鑰貼到聊天，也不要將資料庫憑證放進未來的瀏覽器程式碼。

`init-user` 是第一階段 CLI 的管理操作，不是帳號登入。`PROMPTSEARCH_USER_ID` 由可信的本機設定提供；未來 API 必須改由已驗證的登入 session 決定，不能直接信任前端傳入的 user ID。正式服務角色須使用最小權限、不得有 `BYPASSRLS`；本機 Docker 的管理帳號僅供開發。

### 正式驗收

在已套用 schema 的**測試資料庫**執行：

```sh
pnpm test:postgres
pnpm test:live
```

- `test:postgres`：以隨機測試使用者建立暫時資料，實際檢查三路召回、七個案例、交易回滾、權限隔離、解鎖遮蔽及 fork 外鍵；完成後清除該使用者的測試資料。未設定 `DATABASE_URL` 時明確標示 SKIP。
- `test:live`：會產生 OpenAI API 用量；驗證真實抽取與 embedding、規格案例及額外自然語言案例，分別回報冷查詢和暖查詢 p95。缺少設定會以非零退出碼停止，不會自動換成 demo。
- live 腳本只有六筆資料與單一使用者，屬於 smoke test。正式規模與併發負載的 p95 < 400ms 必須另外量測；目前未宣稱達標。外部 embedding 延遲也包含在冷查詢時間中。

## 本次驗證結果

| 檢查 | 結果 |
| --- | --- |
| TypeScript 嚴格型別檢查 | 通過 |
| 本機單元與 CLI 端到端測試 | 33 / 33 通過 |
| 規格查詢 | 七個離線斷言全部通過 |
| 500 則背景整理邏輯 | 通過；限制四個工作並行，事件迴圈可持續運作 |
| PostgreSQL / pgvector / pg_bigm 真實整合 | 尚未執行：未提供 DATABASE_URL |
| 真實 AI 抽取／語意品質／p95 | 尚未執行：缺少 API 與資料庫設定 |
| Docker 建置 | 尚未執行：這台環境沒有 Docker |

規格 §5 列出五類查詢、§10 稱六個測試；這裡把「把文章變短」「縮短」「精簡」各自測試，加上季報、履歷、Midjourney 與整段 prompt，共七項，避免漏掉任何列出的查詢。

## 下一個里程碑

目前先停在搜尋門檻的可檢查實作。正式資料庫與 AI 驗收完成後，再接 Next.js App Router、Tailwind、shadcn/ui 搜尋首頁、變數表單、真正剪貼簿操作、使用紀錄及 PWA。帳號登入、分享審核、額度增減與永久解鎖的交易服務尚未實作，這次僅建立資料模型與讀取遮蔽。收藏率／作者歷史品質訊號也待後续功能提供資料。

付費金流依規格 §2 的 v1 排除項目保留在後續版本，沒有因 §10 提到付費而提前加入。

第一階段匯入在 CLI process 內以 async worker 執行，會讓出事件迴圈，但不是可重啟的背景任務佇列；關閉 process 會中止未寫出的預覽。未來 PWA 的大量匯入需要另接持久化任務與進度端點。

## 程式結構

```text
db/001_init.sql             資料模型、索引、分類深度與 RLS
db/Dockerfile              PostgreSQL + pgvector + pg_bigm
src/parser.ts              純文字與對話匯出切分
src/importer.ts            去重、並行整理、預覽
src/ai.ts                  正式 AI 與明確標示的 demo provider
src/text.ts                中文 bigram、SimHash、查詢改寫與命中片段
src/postgres-store.ts      交易式落庫與三路 SQL 召回
src/memory-store.ts        離線測試 adapter
src/search.ts              RRF、個人化重排、鎖定內容遮蔽
src/cli.ts                 命令列操作
tests/                     本機與真實 PostgreSQL 測試
scripts/live-eval.ts        正式 AI + PostgreSQL smoke test
```

中文全文索引依 [pg_bigm 官方文件](https://pgbigm.github.io/pg_bigm/pg_bigm_en.html) 使用 `gin_bigm_ops` 與 `likequery`；向量距離與索引依 [pgvector 官方文件](https://github.com/pgvector/pgvector)。AI 介面依 [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) 與 [Embeddings](https://developers.openai.com/api/docs/guides/embeddings) 官方文件實作。
