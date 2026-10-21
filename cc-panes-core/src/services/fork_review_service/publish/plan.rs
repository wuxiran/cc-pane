use super::Change;
use crate::utils::AppResult;

pub(super) fn descendant(path: &str, ancestor: &str) -> bool {
    #[cfg(windows)]
    let normalized = (path.to_lowercase(), ancestor.to_lowercase());
    #[cfg(windows)]
    let (path, ancestor) = (normalized.0.as_str(), normalized.1.as_str());
    path.strip_prefix(ancestor)
        .is_some_and(|suffix| suffix.starts_with('/'))
}

/// Preserve selection order except for deletions required by a shape change.
pub(super) fn order(changes: &[Change]) -> AppResult<Vec<usize>> {
    let mut order = Vec::new();
    for (index, (path, _, after)) in changes.iter().enumerate() {
        if after.is_some() {
            for (other, (candidate, before, desired)) in changes.iter().enumerate() {
                let overlaps = descendant(path, candidate) || descendant(candidate, path);
                if overlaps && desired.is_some() {
                    return Err(
                        format!("Selected final files overlap: {path} and {candidate}").into(),
                    );
                }
                if overlaps && before.is_some() && desired.is_none() && !order.contains(&other) {
                    order.push(other);
                }
            }
        }
        if !order.contains(&index) {
            order.push(index);
        }
    }
    Ok(order)
}

/// Only remove directories needed by the selected target and selected deletions.
/// Unknown directories or files still occupying them must block the replacement.
pub(super) fn replaceable_directories(changes: &[Change], target: &str) -> Vec<String> {
    let mut directories = vec![target.to_string()];
    for (path, before, after) in changes {
        if before.is_none() || after.is_some() || !descendant(path, target) {
            continue;
        }
        let mut parent = path.as_str();
        while let Some((prefix, _)) = parent.rsplit_once('/') {
            if !descendant(prefix, target) {
                break;
            }
            directories.push(prefix.to_string());
            parent = prefix;
        }
    }
    directories.sort();
    directories.dedup();
    directories.sort_by_key(|path| std::cmp::Reverse(path.matches('/').count()));
    directories
}
