# 開啟跨裝置同步

沒有做這些設定時，同步功能完全關閉，「我的投稿」照舊只存在瀏覽器 localStorage——
`data/sync-config.json` 不存在就是關閉狀態，這也是 artifact 預覽頁能正常運作的原因
（那裡的 CSP 會擋掉所有外部主機）。

## 1. 建立 Supabase 專案

<https://supabase.com> → New project。免費方案綽綽有餘：12 筆投稿的 JSON 是 2.7 KB。

## 2. 建立資料表與 RLS

SQL Editor → 貼上 `supabase/schema.sql` → Run。

裡面有四條 RLS policy，全部綁 `auth.uid()`。**這不是可選的**：anon key 會直接印在
網頁裡（它本來就設計成公開），沒有 RLS 的話任何人都讀得到所有人的資料列。

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

Supabase 已把金鑰改名：**`anon` → `sb_publishable_...`**、`service_role` → `sb_secret_...`，
舊名稱 2026 年底棄用。兩者目前都能用。設定檔的欄位仍叫 `anonKey`（那是我們自己的欄位名），
填新的 publishable key 即可。

**絕對不要填 `sb_secret_` 開頭的那把。** 它會繞過 RLS，放進公開 repo 等於把整個資料庫交出去。

## 免費方案會暫停

Supabase 對免費專案有 **7 天無活動即暫停**的規則。放假兩週沒開這個站，回來同步就是壞的，
要手動到 dashboard 按 Restore。

`refresh.yml` 每晚會順手 ping 一次資料庫（設定檔存在才執行），計時器因此不會歸零。
不需要額外服務，也不需要付費。

## 這個設計會怎麼運作

**寫入一律走線上。** 瀏覽器不持有可寫副本，所以兩台裝置不可能各自前進，
沒有合併、沒有衝突解決。

**快取只供顯示。** 離線時看得到上次同步的內容，但所有控制項停用。
不能離線編輯正是分歧無法產生的原因。

**過期分頁用 CAS 擋掉。** 早上開著的分頁，寫入時會帶上它讀到的 `updated_at`；
資料庫端 `save_submission` 比對不符就丟 `stale_write`，前端重新載入並告知，
而不是默默蓋掉中午在手機上做的變更。

## 沒有測到的部分

`npm run test:sync` 用 stub 過的後端涵蓋 session 處理、唯讀快取、離線拒寫、CAS、
401 過期、以及登入導回時把 token 從網址列清掉——19 項。

**真實的 GoTrue 授權往返沒有辦法在這裡測**，需要實際的專案憑證。第一次設定完請確認：
登入後有導回、網址列沒有殘留 `access_token`、以及在第二台裝置上看得到同一份資料。
