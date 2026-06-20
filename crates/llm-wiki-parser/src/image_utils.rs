// PNG 编码 + 尺寸过滤（移植桌面 extract_images.rs 的 ExtractOptions）。
// 纯函数模块，被 parser/pdf.rs 用于把 pdfium 取出的 DynamicImage 转为 PNG 字节。

use image::GenericImageView;

/// 图片提取过滤参数（默认下限 100x100，上限 500 张）。
pub struct ExtractOptions {
    pub min_width: u32,
    pub min_height: u32,
    pub max_images: usize,
}

impl Default for ExtractOptions {
    fn default() -> Self {
        Self {
            min_width: 100,
            min_height: 100,
            max_images: 500,
        }
    }
}

/// 将 image crate 的 [DynamicImage] 编码为 PNG 字节。
/// 尺寸小于 `opts` 下限返回 `None`（跳过过小的图标/装饰图）。
/// `name` 预留给未来基于文件名/索引的过滤策略，目前仅做尺寸过滤。
pub fn encode_png(
    img: &image::DynamicImage,
    name: &str,
    opts: &ExtractOptions,
) -> Option<Vec<u8>> {
    let (w, h) = img.dimensions();
    if w < opts.min_width || h < opts.min_height {
        return None;
    }
    let _ = name; // name 暂未参与过滤逻辑，保留参数以便后续扩展
    let mut buf = std::io::Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Png).ok()?;
    Some(buf.into_inner())
}
