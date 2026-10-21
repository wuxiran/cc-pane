//! Process-local, bounded delivery receipts. A body override is not a new result.
use std::collections::HashMap;
use std::hash::Hash;
use std::time::{Duration, Instant};

pub(super) const REPORT_CACHE_CAPACITY: usize = 4096;
pub(super) const REPORT_CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(super) struct ReportDeliveryKey {
    pub worker_id: String,
    pub report_revision: i64,
    pub status: String,
    pub leader_session_id: String,
}

struct Receipt {
    recorded_at: Instant,
    last_used: u64,
}

pub struct BoundedReportCache<K> {
    receipts: HashMap<K, Receipt>,
    sequence: u64,
}

impl<K> Default for BoundedReportCache<K> {
    fn default() -> Self {
        Self {
            receipts: HashMap::new(),
            sequence: 0,
        }
    }
}

impl<K: Clone + Eq + Hash> BoundedReportCache<K> {
    pub(super) fn contains(&mut self, key: &K, now: Instant) -> bool {
        self.prune(now);
        self.sequence = self.sequence.wrapping_add(1);
        if let Some(receipt) = self.receipts.get_mut(key) {
            receipt.last_used = self.sequence;
            true
        } else {
            false
        }
    }

    pub(super) fn insert(&mut self, key: K, now: Instant) -> bool {
        if self.contains(&key, now) {
            return false;
        }
        if self.receipts.len() >= REPORT_CACHE_CAPACITY {
            let oldest = self
                .receipts
                .iter()
                .min_by_key(|(_, receipt)| receipt.last_used)
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                self.receipts.remove(&oldest);
            }
        }
        self.receipts.insert(
            key,
            Receipt {
                recorded_at: now,
                last_used: self.sequence,
            },
        );
        true
    }

    fn prune(&mut self, now: Instant) {
        self.receipts.retain(|_, receipt| {
            now.saturating_duration_since(receipt.recorded_at) < REPORT_CACHE_TTL
        });
    }
}

pub(super) type SentReportCache = BoundedReportCache<ReportDeliveryKey>;
pub(super) type FailedReportCache = BoundedReportCache<(String, u32)>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ttl_covers_pending_lifetime_and_duplicate_reads_do_not_extend_it() {
        assert!(REPORT_CACHE_TTL > Duration::from_secs(30 * 60));
        let now = Instant::now();
        let mut cache = BoundedReportCache::default();
        assert!(cache.insert("receipt", now));
        assert!(cache.contains(&"receipt", now + Duration::from_secs(30 * 60)));
        assert!(cache.contains(&"receipt", now + REPORT_CACHE_TTL - Duration::from_secs(1)));
        assert!(!cache.contains(&"receipt", now + REPORT_CACHE_TTL));
        assert!(cache.insert("receipt", now + REPORT_CACHE_TTL));
    }

    #[test]
    fn capacity_uses_lru_and_never_grows_beyond_limit() {
        let now = Instant::now();
        let mut cache = BoundedReportCache::default();
        for key in 0..REPORT_CACHE_CAPACITY {
            assert!(cache.insert(key, now));
        }
        assert!(cache.contains(&0, now));
        assert!(cache.insert(REPORT_CACHE_CAPACITY, now));
        assert_eq!(cache.receipts.len(), REPORT_CACHE_CAPACITY);
        assert!(cache.contains(&0, now));
        assert!(!cache.contains(&1, now));
        for key in REPORT_CACHE_CAPACITY..REPORT_CACHE_CAPACITY * 3 {
            cache.insert(key, now);
        }
        assert_eq!(cache.receipts.len(), REPORT_CACHE_CAPACITY);
    }
}
