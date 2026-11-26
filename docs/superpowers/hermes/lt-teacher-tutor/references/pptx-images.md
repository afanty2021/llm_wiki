# 课件配图（matplotlib 生成 → python-pptx 嵌入）

`teacher_tutor_pptx` 产物是纯文字版式。配图需自行生成再嵌入，本页是全部参数与防坑。

## 环境与中文字体
- 可用解释器：`/opt/homebrew/Caskroom/miniconda/base/envs/Ai-english-3.11/bin/python`（自带 python-pptx；matplotlib 若缺则 `pip install matplotlib`）。系统 `/usr/bin/python3` 两者皆无，勿用。
- matplotlib 中文必须先注册字体，否则中文全变方框：
  ```python
  import matplotlib.font_manager as fm
  fm.fontManager.addfont("/System/Library/Fonts/PingFang.ttc")
  plt.rcParams["font.family"] = ["PingFang SC", "Hiragino Sans GB", "Arial Unicode MS"]
  ```
  findfont 的 bold weight warning 无害（降级 600），可忽略。
- 配色与课件 warm 主题一致：米色底 `#FDF6EC`、墨棕 `#4A3728`、红 `#C0392B`、青 `#1A7A6E`、金 `#B8860B`、蓝 `#2C5F8A`；`dpi=200`、`facecolor=CREAM` 存图。

## 版式参数（teacher_tutor_pptx 产物实测）
- 16:9；内容要点框 left 0.9in / top 1.9in / 宽 11.5in / 高 5.0in（每页相同）。
- 嵌入：文字框缩至宽 6.2in；图 x=6.9in、宽 5.8in、top 2.1in；图底边 clamp ≤6.85in（超出则回推 top）。

## 校验规则（不可省）
- **每张图先 vision_analyze 再嵌入**，问「中文是否正常（无方框乱码）？文字有无重叠溢出？」。实测缺陷率 2/3：气泡内文字溢出边框互相重叠、手算顶点的梯形色块与绝对定位文字层叠错乱——这类缺陷生成脚本自己发现不了。
- 排版防坑：文字放 `FancyBboxPatch(round)` 色块内居中并留足内边距；多行并列卡片用**等宽 FancyBboxPatch 堆叠**，勿用 Polygon/Trapezoid 手算顶点再叠绝对定位文字。
- vision_analyze 返回 `Request timed out` ≠ 图有问题：换**更简短的问题**重试（如「文字有无重叠？简答」），问题越长越易超时；仍失败再用 region crop 分块看。
- 修复排版后必须重新 vision 校验 + 重新嵌入（图内容变了，旧嵌入作废）。

## 嵌入
`scripts/pptx_embed_images.py <课件.pptx> <spec.json> [-o 输出.pptx]`，spec 即 {页号: 图路径}（可带版式覆盖键），自动缩文字框、置图、回读校验每页 picture 数。
