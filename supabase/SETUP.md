# 開啟跨裝置同步

沒有做這些設定時，同步功能完全關閉，「我的投稿」照舊只存在瀏覽器 localStorage—— `data/sync-config.json` 不存在就是關閉狀態，這也是 artifact 預覽頁能正常運作的原因（那裡的 CSP 會擋掉所有外部主機）。

## 1. 建立 Supabase 專案

<https://supabase.com> → New project。免費方案綽綽有餘：12 筆投稿的 JSON 是 2.7 KB。

## 2. 建立資料表與 RLS

SQL Editor → 貼上 `supabase/schema.sql` → Run。

裡面有四條 RLS policy，全部綁 `auth.uid()`。**這不是可選的**：anon key 會直接印在網頁裡（它本來就設計成公開），沒有 RLS 的話任何人都讀得到所有人的資料列。

## 3. 開啟 GitHub 登入

Authentication → Providers → GitHub → Enable。

需要一組 GitHub OAuth App（Settings → Developer settings → OAuth Apps → New）：

- Homepage URL：`https://<你的帳號>.github.io/conference-calendar/`
- Authorization callback URL：Supabase 那頁顯示的 callback（`https://<project>.supabase.co/auth/v1/callback`）

把 Client ID / Secret 填回 Supabase。

Authentication → URL Configuration → Redirect URLs 加入：

```
https://<你的帳號>.github.io/conference-calendar/
http://localhost:*/
```

## 4. 把設定寫進 repo

```bash
cat > data/sync-config.json <<'JSON'
{ "url": "https://<project>.supabase.co", "anonKey": "<anon public key>" }
JSON
npm run build
```

這把金鑰進版控是正確的——它本來就設計成公開，真正的防線是 RLS。

Supabase 已把金鑰改名：**`anon` → `sb_publishable_...`**、`service_role` → `sb_secret_...`，舊名稱 2026 年底棄用。兩者目前都能用。設定檔的欄位仍叫 `anonKey`（那是我們自己的欄位名），填新的 publishable key 即可。

**絕對不要填 `sb_secret_` 開頭的那把。** 它會繞過 RLS，放進公開 repo 等於把整個資料庫交出去。

## 5. （選用）在網站上增刪會議

需要先完成 1 到 4，網站要靠同一個 GitHub 登入認出你。做完之後，登入的你會在「依會議」看到「管理會議」，其他人什麼都看不到。不做這一步，網站完全照舊。

**一、建一個只能動 issue 的 GitHub token。** GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token：

- Repository access：**Only select repositories**，選 `chihduo/conference-calendar`
- Permissions → Repository permissions：**Issues → Read and write**。Metadata 會自動變成 Read-only，其他全部維持 No access。
- Expiration：選一年並記下日期。過期時網站會直接顯示「GitHub token 無效或已過期」。

**二、把 token 存進 Supabase。** Dashboard → Edge Functions → Secrets → Add new secret，名稱填 `CC_GITHUB_TOKEN`，值貼上剛才的 token。token 只存在這裡，瀏覽器和 repo 都看不到。

**三、部署函式。** Dashboard → Edge Functions → Deploy a new function → Via Editor，名稱填 `conference-requests`，內容整份貼上 `supabase/functions/conference-requests/index.ts`，按 Deploy。部署完到這支函式的 Details，把 **Enforce JWT Verification** 關掉：函式自己會向 Supabase Auth 確認登入、再比對 GitHub 帳號，閘道那一層只是重複的檢查。

用 CLI 是同一件事：

```bash
npx supabase secrets set CC_GITHUB_TOKEN=github_pat_... --project-ref ingdodgwhapesmkzwbph
npx supabase functions deploy conference-requests --project-ref ingdodgwhapesmkzwbph --no-verify-jwt
```

函式的程式碼以後改了，要再部署一次；網站本身照常由 `deploy.yml` 發佈。

**四、確認。** 先確認函式在線上、而且會擋掉沒登入的請求，應該回 `{"error":"請先登入"}`：

```bash
URL=$(node -p "require('./data/sync-config.json').url")
KEY=$(node -p "require('./data/sync-config.json').anonKey")
curl -s -H "apikey: $KEY" "$URL/functions/v1/conference-requests"
```

然後重新整理網站、確認已登入，「依會議」最上面應該出現「管理會議」。沒有出現的話，網站只會安靜地維持原樣，原因通常是其中之一：函式沒部署成功（網站收到 404，當作沒有這個功能）、登入的不是 token 主人的 GitHub 帳號（403），或是 Enforce JWT Verification 沒關而閘道拒絕了登入。

## 免費方案會暫停

Supabase 對免費專案有 **7 天無活動即暫停**的規則，而「活動」指的是**資料庫活動**，不是 API 呼叫、也不是你有沒有開 dashboard。官方的說法是「每天幾次對資料庫的請求」。

`keepalive.yml` 每 4 小時呼叫一次 `touch_heartbeat()`（一天六次），是獨立的 workflow，不掛在每晚的 refresh 上。

**必須先跑 `supabase/0003-heartbeat.sql` 和 `supabase/0004-heartbeat-write.sql`。**

這件事我做錯過兩次，兩次都是一週後專案暫停才發現：

1. 第一版讀 `submissions`，但 anon 對那張表沒有授權，每晚回 `401`。**被拒絕的請求不算活動**，而 `continue-on-error` 讓那個步驟顯示綠燈。
2. 第二版讀 `heartbeat` 成功拿到 `200`，但**一天只打一次**——那正是規則要抓的「low activity」。

所以現在是：**寫入**（`UPDATE` 在任何解讀下都算資料庫活動，讀取算不算沒有文件保證）、**一天六次**、而且**留下可查的痕跡**。

隨時可以確認它有沒有真的抵達資料庫：

```bash
URL=$(node -p "require('./data/sync-config.json').url")
KEY=$(node -p "require('./data/sync-config.json').anonKey")
curl -s -H "apikey: $KEY" "$URL/rest/v1/heartbeat?select=last_seen,hits"
```

`last_seen` 應該在 4 小時之內。前兩次失敗之所以拖了一週才發現，正是因為當時沒有這個東西可以問。

## 這個設計會怎麼運作

**寫入一律走線上。** 瀏覽器不持有可寫副本，所以兩台裝置不可能各自前進，沒有合併、沒有衝突解決。

**快取只供顯示。** 離線時看得到上次同步的內容，但所有控制項停用。不能離線編輯正是分歧無法產生的原因。

**過期分頁用 CAS 擋掉。** 早上開著的分頁，寫入時會帶上它讀到的 `updated_at`；資料庫端 `save_submission` 比對不符就丟 `stale_write`，前端重新載入並告知，而不是默默蓋掉中午在手機上做的變更。

## 沒有測到的部分

`npm run test:sync` 用 stub 過的後端涵蓋 session 處理、唯讀快取、離線拒寫、CAS、 401 過期、以及登入導回時把 token 從網址列清掉——19 項。

**真實的 GoTrue 授權往返沒有辦法在這裡測**，需要實際的專案憑證。第一次設定完請確認：登入後有導回、網址列沒有殘留 `access_token`、以及在第二台裝置上看得到同一份資料。

網站增刪也一樣：`npm run test:function` 在 Node 裡跑真的函式，對的是 stub 過的 Supabase Auth 和 GitHub；`npm run test:admin` 則對 stub 過的函式測網站介面。真實的 token 和登入只有部署後才碰得到，第一次設定完請從網站新增一個會議，看卡片從「處理中」走到「完成」。
