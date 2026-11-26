#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把配图嵌入 teacher_tutor_pptx 生成的课件（纯文字版式 → 图文版）。

用法:
  python pptx_embed_images.py <课件.pptx> <spec.json> [-o 输出.pptx]

spec.json 示例（页号从 0 起，0=封面）:
  {
    "1": "/path/timeline.png",
    "3": "/path/ed_sounds.png",
    "body_width": 6.2, "pic_x": 6.9, "pic_width": 5.8,
    "pic_top": 2.1, "pic_bottom_max": 6.85
  }
版式键可省，默认值即 teacher_tutor_pptx 实测版式（16:9，内容框 left 0.9in / top 1.9in）。

行为: 找到每页要点文本框（top≈1.9in 中最宽者）缩窄到 body_width；图片置于 pic_x、
宽 pic_width、top pic_top，底边超 pic_bottom_max 则回推；保存后回读校验每页 picture 数。

解释器: conda env Ai-english-3.11 的 python（有 python-pptx）。
"""
import json
import shutil
import sys
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
from pptx.util import Inches

EMU_PER_IN = 914400


def find_body(slide):
    """内容要点框 = top≈1.9in 且有文字的形状中最宽者。"""
    best = None
    for sh in slide.shapes:
        if sh.has_text_frame and sh.text_frame.text.strip() and abs(sh.top - Inches(1.9)) < Inches(0.3):
            if best is None or sh.width > best.width:
                best = sh
    return best


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        sys.exit(__doc__)
    src, spec_path = args[0], args[1]
    out = args[args.index("-o") + 1] if "-o" in args else src.replace(".pptx", "-images.pptx")
    with open(spec_path, encoding="utf-8") as f:
        spec = json.load(f)
    body_w = Inches(spec.get("body_width", 6.2))
    pic_x = Inches(spec.get("pic_x", 6.9))
    pic_w = Inches(spec.get("pic_width", 5.8))
    pic_top = Inches(spec.get("pic_top", 2.1))
    bottom_max = Inches(spec.get("pic_bottom_max", 6.85))

    shutil.copy(src, out)
    prs = Presentation(out)
    for k, img in spec.items():
        if not k.isdigit():
            continue
        slide = prs.slides[int(k)]
        body = find_body(slide)
        if body is not None:
            body.width = body_w
        else:
            print(f"slide {k}: body NOT FOUND（仍嵌图，注意可能叠字）")
        pic = slide.shapes.add_picture(img, pic_x, pic_top, width=pic_w)
        if pic.top + pic.height > bottom_max:
            pic.top = bottom_max - pic.height
        print(f"slide {k}: body={'缩至6.2in' if body else '-'} "
              f"pic top={pic.top / EMU_PER_IN:.2f}in h={pic.height / EMU_PER_IN:.2f}in")
    prs.save(out)

    chk = Presentation(out)  # 回读校验
    for k in spec:
        if k.isdigit():
            n = sum(1 for sh in chk.slides[int(k)].shapes if sh.shape_type == MSO_SHAPE_TYPE.PICTURE)
            print(f"verify slide {k}: {n} picture(s)")


if __name__ == "__main__":
    main()
