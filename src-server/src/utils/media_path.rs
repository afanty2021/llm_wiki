//! SEC-2（终审必修）：媒体路径越界判据（词法规范化 + 许可根集前缀校验）。
//!
//! 背景：`media_assets.media_ref / playback_path` 是**本机绝对路径**（migration 013
//! 「本机绝对路径，只在本表出现」），`/media/:id` 曾对 DB 值 `File::open` 直开——
//! 值一旦越出媒体存放面（绝对路径指库外 / `..` 穿越 / 被改库），即任意文件读。
//!
//! 双侧收口共用本模块：
//! - **upsert 侧**（training.rs import_media_assets）：`playback_path` 给出时经
//!   [`path_within_roots_lexical`] 词法校验（无 IO——注册时转码副本可能尚未落盘），
//!   违规 400（风格同 target_ref 拒绝对路径：400 + 截断回显）；
//! - **服务侧**（media.rs get_media）：open 前 canonicalize（解析符号链接）+
//!   根集前缀校验，越界 404 + warn 日志。media_ref 与 playback_path 同标准
//!   （校验的是 COALESCE 后实际 open 的那个值）。
//!
//! 根集来自 `MEDIA__ALLOWED_ROOTS`（AppConfig.media.allowed_roots）；/media 开启
//! （signing_key 非空）时必须非空（config validate fail-closed）。

use std::path::{Component, Path, PathBuf};

/// 绝对路径的词法规范化（无 IO）：CurDir 丢弃、ParentDir 弹栈；`..` 越过根 → None。
/// 与 canonicalize 的差异：不解析符号链接、不要求文件存在——upsert 侧注册时
/// 转码副本可能尚未落盘，只能做词法级收口（服务侧再补 canonicalize 纵深）。
fn lexical_normalize_abs(input: &str) -> Option<PathBuf> {
    let p = Path::new(input);
    if !p.is_absolute() {
        return None;
    }
    let mut out = PathBuf::new();
    out.push("/");
    for comp in p.components() {
        match comp {
            Component::RootDir => {} // 已由初始 "/" 承载
            Component::Normal(c) => out.push(c),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() || out.as_os_str().is_empty() {
                    return None; // ".." 越过根 → 越界
                }
            }
            Component::Prefix(_) => return None, // Windows 盘符：本仓部署面为 unix，不收
        }
    }
    Some(out)
}

/// 相对路径锚定 `root` 后规范化：`..` 弹出根内组件，越出根 → None。
fn lexical_resolve(root: &str, input: &str) -> Option<PathBuf> {
    let mut out = lexical_normalize_abs(root)?;
    for comp in Path::new(input).components() {
        match comp {
            Component::Normal(c) => out.push(c),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(out)
}

/// upsert 侧判据：`input`（绝对原样规范化、相对则对每根锚定）是否落在某一许可根
/// （根亦词法规范化）之下。前缀比较按**路径组件**（Path::starts_with），非字符串
/// 前缀——"/media/root-evil" 不在 "/media/root" 之下。根集为空 → 一律 false
/// （fail-closed：无根可判即无 playback 可收）。
pub fn path_within_roots_lexical(roots: &[String], input: &str) -> bool {
    if input.trim().is_empty() {
        return false;
    }
    roots.iter().any(|root| {
        let Some(norm_root) = lexical_normalize_abs(root) else {
            return false;
        };
        let candidate = if Path::new(input).is_absolute() {
            lexical_normalize_abs(input)
        } else {
            lexical_resolve(root, input)
        };
        candidate.is_some_and(|c| c.starts_with(&norm_root))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots() -> Vec<String> {
        vec!["/media/root".to_string(), "/data/storage".to_string()]
    }

    #[test]
    fn absolute_under_root_passes() {
        assert!(path_within_roots_lexical(&roots(), "/media/root/a/b.mp4"));
        assert!(path_within_roots_lexical(&roots(), "/data/storage/x.mp4"));
    }

    #[test]
    fn absolute_outside_root_rejected() {
        // 库外绝对路径（任意文件读的原始形态）
        assert!(!path_within_roots_lexical(&roots(), "/etc/passwd"));
        assert!(!path_within_roots_lexical(&roots(), "/transcoded/a_h264.mp4"));
    }

    #[test]
    fn absolute_with_inner_dots_normalizes_then_checks() {
        // 词法规范化在**根内**消解 ".." → 通过（服务侧还有 canonicalize 纵深）
        assert!(path_within_roots_lexical(&roots(), "/media/root/sub/../a.mp4"));
        // 规范化后越出根 → 拒（"/media/root/../../etc/passwd" → "/etc/passwd"）
        assert!(!path_within_roots_lexical(&roots(), "/media/root/../../etc/passwd"));
    }

    #[test]
    fn traversal_escape_rejected() {
        // 相对路径对每根锚定后 ".." 弹栈越出根 → 拒
        assert!(!path_within_roots_lexical(&roots(), "../../etc/passwd"));
        assert!(!path_within_roots_lexical(&roots(), "sub/../../escape.mp4"));
    }

    #[test]
    fn traversal_staying_inside_passes() {
        assert!(path_within_roots_lexical(&roots(), "sub/../a.mp4"));
        assert!(path_within_roots_lexical(&roots(), "a.mp4"));
    }

    #[test]
    fn component_prefix_not_string_prefix() {
        // "/media/root-evil" 不是 "/media/root" 之下的组件前缀
        assert!(!path_within_roots_lexical(&roots(), "/media/root-evil/a.mp4"));
    }

    #[test]
    fn empty_roots_reject_everything() {
        // fail-closed：根集为空 → 任何 playback_path 都不可判为合法
        assert!(!path_within_roots_lexical(&[], "/media/root/a.mp4"));
        assert!(!path_within_roots_lexical(&[], "a.mp4"));
    }

    #[test]
    fn empty_or_blank_input_rejected() {
        assert!(!path_within_roots_lexical(&roots(), ""));
        assert!(!path_within_roots_lexical(&roots(), "   "));
    }

    #[test]
    fn root_itself_counts_as_within() {
        assert!(path_within_roots_lexical(&roots(), "/media/root"));
    }
}
