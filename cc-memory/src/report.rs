use crate::models::*;
use crate::repository::MemoryRepository;

pub struct ReportGenerator<'a> {
    repo: &'a MemoryRepository,
}

impl<'a> ReportGenerator<'a> {
    pub fn new(repo: &'a MemoryRepository) -> Self {
        Self { repo }
    }

    /// 生成日报
    pub fn daily_report(&self, query: &DailyReportQuery) -> Result<DailyReport, String> {
        // 解析日期范围：query.date 格式 "YYYY-MM-DD"
        let from = format!("{}T00:00:00+00:00", query.date);
        let to_date = chrono::NaiveDate::parse_from_str(&query.date, "%Y-%m-%d")
            .map_err(|e| format!("日期格式错误: {}", e))?;
        let next_day = to_date
            .checked_add_days(chrono::Days::new(1))
            .ok_or_else(|| "日期计算溢出".to_string())?;
        let to = format!("{}T00:00:00+00:00", next_day.format("%Y-%m-%d"));

        let memories = self.repo.list_by_date_range(
            &from,
            &to,
            query.workspace_name.as_deref(),
            query.project_path.as_deref(),
        )?;

        // 按 category 分组
        let mut groups: std::collections::HashMap<String, Vec<Memory>> =
            std::collections::HashMap::new();
        for mem in &memories {
            groups
                .entry(mem.category.as_str().to_string())
                .or_default()
                .push(mem.clone());
        }

        let mut entries: Vec<DailyReportEntry> = groups
            .into_iter()
            .map(|(category, items)| DailyReportEntry { category, items })
            .collect();

        // 固定排序：decision > lesson > pattern > preference > fact > plan > 其他
        let order = [
            "decision",
            "lesson",
            "pattern",
            "preference",
            "fact",
            "plan",
        ];
        entries.sort_by_key(|entry| {
            order
                .iter()
                .position(|&category| category == entry.category)
                .unwrap_or(order.len())
        });

        Ok(DailyReport {
            date: query.date.clone(),
            total_count: memories.len() as u64,
            entries,
        })
    }

    /// 格式化日报为 Markdown
    pub fn format_daily_report_markdown(&self, report: &DailyReport) -> String {
        let mut md = format!("# Daily Report: {}\n\n", report.date);
        md.push_str(&format!("Total: {} memories\n\n", report.total_count));

        for entry in &report.entries {
            md.push_str(&format!("## {}\n\n", entry.category));
            for item in &entry.items {
                md.push_str(&format!(
                    "### {} (importance: {})\n\n",
                    item.title, item.importance
                ));
                md.push_str(&format!("{}\n\n", item.content));
                if !item.tags.is_empty() {
                    md.push_str(&format!("Tags: {}\n\n", item.tags.join(", ")));
                }
            }
        }

        md
    }
}
