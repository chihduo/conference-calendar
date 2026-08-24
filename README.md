# 2027 FM/PL/AI 會議截稿行事曆

追蹤形式方法、程式語言與人工智慧領域會議的截稿日與後續里程碑，資料以 YAML 保存、
由分層抓取自動維護，輸出成一頁靜態網站與可訂閱的 `.ics`。

```
npm install
npm run build          # -> dist/index.html，直接雙擊即可開啟（不必起 server）
npm run validate       # schema + 合理性檢查
npm run refresh        # 抓取所有來源並寫回 YAML（--dry-run 只印不寫）
npm run add CONCUR     # 只給縮寫，自動補齊整份資料
npm run ranks FSE      # 查 ICORE 排名
```

## 兩層資料模型

**會議層**（`data/conferences/*.yml`，進版控）記錄 CFP 公布的事實。
**個人層**（瀏覽器 localStorage，永不上傳）記錄你自己投了什麼、進行到哪一步。

分開的理由很實際：repo 是公開的，而「哪篇論文正在哪裡審、哪一篇被拒過」不該留在
公開的 git 歷史裡。網站上的「我的投稿」可匯出／匯入 JSON 做備份與換機。

個人層真正的作用是**依狀態浮現里程碑**：標成 `submitted` 之後，該會議的
notification 才會浮上來；標成 `accepted` 之後才輪到 camera-ready 與註冊。
這些日期本來就在會議資料裡，狀態只決定哪些對你有意義。

## 里程碑是開放詞彙

`kind` 不是 enum。常用值有 `abstract` / `submission` / `rebuttal_start` /
`rebuttal_end` / `notification` / `revision` / `final_notification` /
`camera_ready` / `artifact_submission` / `registration`，但你隨時可以加
`visa_letter_deadline` 之類的新種類，不必改任何程式。

只有 `chain: true` 的里程碑（主審稿流程）會被檢查先後順序。artifact 與
early-rejection 刻意不在鏈上——artifact 在有些會議是投稿時交、有些是錄取後才交，
硬性排序會編碼一個不成立的假設。

## 四級信心

| 級別 | 意義 |
|---|---|
| `confirmed` | 官方 CFP 明載 |
| `announced` | 官網暫定，或來自社群來源 |
| `estimated` | 由前一屆 +364 天推算 |
| `unknown` | 欄位存在，日期尚未公布 |

推估用 **+364 天（52 週）而非 +1 年**，因為 CFP 截稿日固定在星期幾的程度遠高於
固定在日期。FMCAD 2026 abstract 是 5/4（週一），推估 2027 得到 5/3（仍是週一）。

## 抓取分層

| Tier | 來源 | 涵蓋 | 信心上限 |
|---|---|---|---|
| 0 | ICORE portal CSV | 排名，幾乎全部 | `confirmed` |
| 1 | `ccfddl/ccf-deadlines` | 主流會議，長尾差 | `announced` |
| 2 | `conf.researchr.org` | 僅 ACM SIGPLAN/SIGSOFT 家族，但里程碑最完整 | `confirmed` |
| 3 | WikiCFP | 長尾全中，社群填寫 | `announced` |
| 4 | 各會議官網 adapter | 視需要新增 | `confirmed` |

信心上限寫在 adapter 裡，不靠人記得：WikiCFP 抓到的東西**永遠不會**被寫成
`confirmed`。

## 自動寫入的護欄

`npm run refresh` 直接改 YAML，所以每一筆寫入都要先過關：

- **不覆蓋手填的官方日期。** `confidence: confirmed` 且沒有 `source_url` 的值是人
  從 CFP 讀來的；機器可以更新自己維護的日期，但不能推翻人的判讀。
- **同一 kind 有多個候選就一個都不寫。** ATVA 同時有 paper notification 與
  early-rejection notification；二選一等於擲骰子。
- **來源身分要對得上。** WikiCFP 以縮寫索引，而縮寫會跨領域衝突——它的 "SAS 2026"
  是 Society for Animation Studies，不是 Static Analysis Symposium。標題相似度低於
  0.4 一律丟棄。
- **合併後整個 edition 要重驗**（截稿日不得晚於會議開始、鏈上里程碑須依序、
  日期須落在合理年份區間）。不過就整批回退。
- **`locked: true`** 可釘住任何你確認過的值。
- 過不了的通通進 `data/_review_queue.json`，網站上會顯示。
- 每次 refresh 都是一次 bot commit，`git diff` 逐行可讀，`git revert` 就是還原鍵。

## 新增會議

三種方式，共用同一支 `scripts/add.mjs`：

1. 在 `data/wishlist.txt` 加一行縮寫（可直接在 GitHub 網頁上編輯），隔天 cron 展開
2. Actions → Add conference → Run workflow，填縮寫
3. 開一個標題就是縮寫、貼 `add-conference` 標籤的 issue；workflow 會跑完、commit、
   並在 issue 回報抓到什麼 — 這是唯一能從手機完成的路徑

抓不到就明說抓不到，不會寫出半殘的檔案。

## 排名

**排名是參考資料，不是收錄門檻。** 它用來排序、篩選，以及在一開始拉出候選名單；
低於任何等級的會議都可以留著（CIAA 是 C 級，照樣在清單裡）。不想要的會議設
`hidden: true` 或直接刪檔。

`rank.source` 一律記錄版本。CORE 已改制為 **ICORE**，現行版本是 **ICORE2026**
（取代 CORE2023），名次有變動。`rank.icore_id` 才是可靠的鍵——ICORE 裡的 "FSE"
有兩筆：Fast Software Encryption（B）和 ACM FoSE（A*，id 52）。

## 滾動截稿

有些會議一年收好幾輪（CSF 分 summer / fall / winter 三輪）。這種用
`<kind>_cycleN` 表示，例如 `submission_cycle2`、`notification_cycle2`。
後綴是解析出來的而不是列舉的，所以五輪的會議也不必改程式。

順序檢查會**分輪進行**——第 2 輪的投稿本來就早於第 1 輪的通知，跨輪比較會把正確的
行事曆判成壞的。「我的投稿」也只顯示每種里程碑最近的那一個，不會把三輪的通知全堆上來。
