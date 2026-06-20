// PDF parser —— 基于 pdfium-render 0.9（thread_safe 默认启用，Pdfium: Send）。
//
// pdfium 的 C 库非线程安全；pdfium-render 在 thread_safe feature 下用全局
// Mutex 串行化所有 binding 调用。这里额外用 static Mutex<Option<Pdfium>>
// 保证 Pdfium 单例只 new 一次（Pdfium::new 内部对 OnceCell assert!，二次
// 调用会 panic，故不能每次重新 new）。
//
// 绑定策略：优先 bind_to_system_library（系统库路径），失败则回退到
// PDFIUM_DYNAMIC_LIB_PATH 环境变量或平台默认路径。

use super::{DocMeta, ExtractedImage, ParsedDoc, ParseError};
use crate::image_utils::{self, ExtractOptions};

use std::sync::Mutex;

use pdfium_render::prelude::*;

// 全局 Pdfium 单例——thread_safe feature 下 Pdfium 实现 Send + Sync，
// 故可放入 static Mutex。Pdfium::new 内部对全局 OnceCell assert!，
// 只能调用一次，所以必须 lazy-init 到 static。
static PDFIUM: Mutex<Option<Pdfium>> = Mutex::new(None);

fn platform_default_lib_path() -> String {
    #[cfg(target_os = "macos")]
    {
        "/usr/local/lib/libpdfium.dylib".into()
    }
    #[cfg(target_os = "linux")]
    {
        "/usr/lib/x86_64-linux-gnu/libpdfium.so".into()
    }
    #[cfg(target_os = "windows")]
    {
        "pdfium.dll".into()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        "libpdfium".into()
    }
}

/// 取（必要时初始化）全局 Pdfium 单例。
///
/// 返回 `MutexGuard` 让调用方持有锁直到本次解析完成——因为 pdfium-render
/// 内部对全局 binding 的并发保护依赖外层串行化更稳妥。持有 guard 期间
/// 不可跨 await 点（本函数无 async），且不可在 guard 存活时递归 lock。
fn with_pdfium<R>(
    f: impl FnOnce(&Pdfium) -> Result<R, ParseError>,
) -> Result<R, ParseError> {
    let mut guard = PDFIUM
        .lock()
        .map_err(|e| ParseError::PdfiumError(format!("pdfium mutex poisoned: {}", e)))?;
    if guard.is_none() {
        let bindings = Pdfium::bind_to_system_library()
            .or_else(|_| {
                let path = std::env::var("PDFIUM_DYNAMIC_LIB_PATH")
                    .unwrap_or_else(|_| platform_default_lib_path());
                Pdfium::bind_to_library(path)
            })
            .map_err(|e| ParseError::PdfiumError(format!("bind pdfium: {}", e)))?;
        *guard = Some(Pdfium::new(bindings));
    }
    let pdfium = guard.as_ref().expect("pdfium just initialized");
    f(pdfium)
}

pub fn parse(bytes: &[u8]) -> Result<ParsedDoc, ParseError> {
    let opts = ExtractOptions::default();

    // 持有 pdfium 锁完成整个解析，避免在迭代 document/page 时锁被释放。
    with_pdfium(|pdfium| {
        let doc = pdfium
            .load_pdf_from_byte_slice(bytes, None)
            .map_err(|e| ParseError::PdfiumError(format!("load pdf: {}", e)))?;

        let page_count = doc.pages().len() as u32;
        let mut text = String::new();
        let mut images: Vec<ExtractedImage> = Vec::new();
        let mut image_count: usize = 0;

        for (page_idx, page) in doc.pages().iter().enumerate() {
            // 文本提取：page.text() → PdfPageText，.all() 返回该页全部文本。
            if let Ok(page_text) = page.text() {
                let t = page_text.all();
                if !t.trim().is_empty() {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(&t);
                }
            }

            // 图片提取：遍历页面对象，筛选 image 对象，get_raw_image → DynamicImage。
            if image_count < opts.max_images {
                for obj in page.objects().iter() {
                    if image_count >= opts.max_images {
                        break;
                    }
                    if let Some(img_obj) = obj.as_image_object() {
                        let raw = match img_obj.get_raw_image() {
                            Ok(img) => img,
                            Err(_) => continue,
                        };
                        let name = format!("page_{}_img_{}.png", page_idx, image_count);
                        if let Some(png) = image_utils::encode_png(&raw, &name, &opts) {
                            images.push(ExtractedImage { name, data: png });
                            image_count += 1;
                        }
                    }
                }
            }
        }

        Ok(ParsedDoc {
            text,
            images,
            meta: DocMeta {
                filename: String::new(),
                page_count: Some(page_count),
                file_type: "pdf".to_string(),
            },
        })
    })
}
