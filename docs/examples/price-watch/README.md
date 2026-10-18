# price-watch

Synthetic offline Assist example. Use `fbl packs test docs/examples/price-watch`.
The `.example.test` URL is a scene fixture; no website is fetched. `visible-page.html`
stands for already visible page data. The command reads that file using HTMLParser,
then writes only into the host-provided task working directory.

`prices.csv` starts with a synthetic previous price of 29.00, then records 25.00; the result shows a change of -4.00. Subsequent runs in the same directory compare against the last row.

All data, IDs, companies and locations are invented. No account, network or paid
model is needed. `risk: zero` means zero provider cost; these commands write local
files and therefore declare `read_only: false` and are not auto-run. Task folders
are separate; copy the reviewed output to your own durable collection explicitly.

中文：全部为合成数据，域名仅用于匹配。脚本只读包内的合成可见页面，
只向宿主任务目录写本地记录；不访问网络、不调用模型、不自动执行。
