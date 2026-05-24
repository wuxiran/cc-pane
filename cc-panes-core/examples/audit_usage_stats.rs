use cc_panes_core::models::UsageEntry;
use cc_panes_core::services::codex_session_service;
use rusqlite::{params, Connection};
use std::collections::{BTreeMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default)]
struct Totals {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
}

#[derive(Debug, Clone)]
struct DbRow {
    date: String,
    cli_tool: String,
    workspace_name: String,
    totals: Totals,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let jsonl_path = args
        .first()
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(default_jsonl_path)?;
    let db_path = args
        .get(1)
        .map(PathBuf::from)
        .unwrap_or_else(default_db_path);
    let source_path = args
        .get(2)
        .cloned()
        .unwrap_or_else(|| jsonl_path.to_string_lossy().to_string());

    let (entries, offset) = codex_session_service::read_session_usage(&jsonl_path, 0)?;
    let parser_by_date = aggregate_entries(&entries);
    let db_rows = query_usage_stats(&db_path, &source_path)?;
    let db_by_date = aggregate_db_rows(&db_rows);
    let similar_sources = query_similar_sources(&db_path, &jsonl_path)?;

    println!("audit_file={}", jsonl_path.display());
    println!("db_path={}", db_path.display());
    println!("source_path={}", source_path);
    println!("parsed_entries={}", entries.len());
    println!("parsed_offset={}", offset);
    println!();
    println!("## entries");
    for (index, entry) in entries.iter().enumerate() {
        println!(
            "{:04}\tdate={}\tinput={}\toutput={}\tcache_read={}\tcache_creation={}",
            index + 1,
            entry.date,
            entry.token_input,
            entry.token_output,
            entry.token_cache_read,
            entry.token_cache_creation
        );
    }

    println!();
    println!("## parser aggregate");
    print_totals_by_date(&parser_by_date);

    println!();
    println!("## db rows");
    if db_rows.is_empty() {
        println!("(none)");
    } else {
        for row in &db_rows {
            println!(
                "date={}\tcli={}\tworkspace={}\tinput={}\toutput={}\tcache_read={}\tcache_creation={}",
                row.date,
                row.cli_tool,
                row.workspace_name,
                row.totals.input,
                row.totals.output,
                row.totals.cache_read,
                row.totals.cache_creation
            );
        }
    }

    if db_rows.is_empty() && !similar_sources.is_empty() {
        println!();
        println!("## similar source_path rows");
        for source in &similar_sources {
            println!("{}", source);
        }
    }

    println!();
    println!("## diff parser_minus_db");
    let mut dates = parser_by_date.keys().cloned().collect::<HashSet<_>>();
    dates.extend(db_by_date.keys().cloned());
    let mut dates = dates.into_iter().collect::<Vec<_>>();
    dates.sort();

    let mut matched = true;
    for date in dates {
        let parser = parser_by_date.get(&date).cloned().unwrap_or_default();
        let db = db_by_date.get(&date).cloned().unwrap_or_default();
        let input_diff = parser.input as i128 - db.input as i128;
        let output_diff = parser.output as i128 - db.output as i128;
        let cache_read_diff = parser.cache_read as i128 - db.cache_read as i128;
        let cache_creation_diff = parser.cache_creation as i128 - db.cache_creation as i128;
        if input_diff != 0 || output_diff != 0 || cache_read_diff != 0 || cache_creation_diff != 0 {
            matched = false;
        }
        println!(
            "date={}\tparser(input={},output={},cache_read={},cache_creation={})\tdb(input={},output={},cache_read={},cache_creation={})\tdiff(input={},output={},cache_read={},cache_creation={})",
            date,
            parser.input,
            parser.output,
            parser.cache_read,
            parser.cache_creation,
            db.input,
            db.output,
            db.cache_read,
            db.cache_creation,
            input_diff,
            output_diff,
            cache_read_diff,
            cache_creation_diff
        );
    }

    let parser_total = sum_totals(parser_by_date.values());
    let db_total = sum_totals(db_by_date.values());
    println!();
    println!(
        "parser_total input={} output={} cache_read={} cache_creation={}",
        parser_total.input,
        parser_total.output,
        parser_total.cache_read,
        parser_total.cache_creation
    );
    println!(
        "db_total input={} output={} cache_read={} cache_creation={}",
        db_total.input, db_total.output, db_total.cache_read, db_total.cache_creation
    );
    println!("status={}", if matched { "MATCH" } else { "MISMATCH" });

    Ok(())
}

fn default_jsonl_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let home = dirs::home_dir().ok_or("failed to resolve home directory")?;
    let sessions = home.join(".codex").join("sessions");
    let mut candidates = Vec::new();
    collect_jsonl_files(&sessions, &mut candidates)?;
    candidates.sort_by_key(|path| {
        fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .ok()
            .map(std::cmp::Reverse)
    });
    candidates
        .into_iter()
        .find(|path| {
            fs::metadata(path)
                .map(|metadata| {
                    let len = metadata.len();
                    (100_000..=2_000_000).contains(&len)
                })
                .unwrap_or(false)
        })
        .ok_or_else(|| "no suitable Codex jsonl file found".into())
}

fn collect_jsonl_files(root: &Path, files: &mut Vec<PathBuf>) -> std::io::Result<()> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let path = entry?.path();
        if path.is_dir() {
            collect_jsonl_files(&path, files)?;
        } else if path.extension().and_then(|value| value.to_str()) == Some("jsonl") {
            files.push(path);
        }
    }
    Ok(())
}

fn default_db_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(if cfg!(debug_assertions) {
            ".cc-panes-dev"
        } else {
            ".cc-panes"
        })
        .join("data.db")
}

fn aggregate_entries(entries: &[UsageEntry]) -> BTreeMap<String, Totals> {
    let mut by_date = BTreeMap::<String, Totals>::new();
    for entry in entries {
        let totals = by_date.entry(entry.date.clone()).or_default();
        totals.input += entry.token_input;
        totals.output += entry.token_output;
        totals.cache_read += entry.token_cache_read;
        totals.cache_creation += entry.token_cache_creation;
    }
    by_date
}

fn query_usage_stats(
    db_path: &Path,
    source_path: &str,
) -> Result<Vec<DbRow>, Box<dyn std::error::Error>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT date, cli_tool, workspace_name,
                token_input, token_output, token_cache_read, token_cache_creation
         FROM usage_stats
         WHERE source_path = ?1
         ORDER BY date, cli_tool, workspace_name",
    )?;
    let rows = stmt.query_map(params![source_path], |row| {
        Ok(DbRow {
            date: row.get(0)?,
            cli_tool: row.get(1)?,
            workspace_name: row.get(2)?,
            totals: Totals {
                input: i64_to_u64(row.get(3)?),
                output: i64_to_u64(row.get(4)?),
                cache_read: i64_to_u64(row.get(5)?),
                cache_creation: i64_to_u64(row.get(6)?),
            },
        })
    })?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn query_similar_sources(
    db_path: &Path,
    jsonl_path: &Path,
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let Some(file_name) = jsonl_path.file_name().and_then(|value| value.to_str()) else {
        return Ok(Vec::new());
    };
    let conn = Connection::open(db_path)?;
    let pattern = format!("%{}%", file_name);
    let mut stmt = conn.prepare(
        "SELECT source_path
         FROM usage_stats
         WHERE source_path LIKE ?1
         GROUP BY source_path
         ORDER BY source_path
         LIMIT 20",
    )?;
    let rows = stmt.query_map(params![pattern], |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn aggregate_db_rows(rows: &[DbRow]) -> BTreeMap<String, Totals> {
    let mut by_date = BTreeMap::<String, Totals>::new();
    for row in rows {
        let totals = by_date.entry(row.date.clone()).or_default();
        totals.input += row.totals.input;
        totals.output += row.totals.output;
        totals.cache_read += row.totals.cache_read;
        totals.cache_creation += row.totals.cache_creation;
    }
    by_date
}

fn print_totals_by_date(by_date: &BTreeMap<String, Totals>) {
    if by_date.is_empty() {
        println!("(none)");
        return;
    }

    for (date, totals) in by_date {
        println!(
            "date={}\tinput={}\toutput={}\tcache_read={}\tcache_creation={}",
            date, totals.input, totals.output, totals.cache_read, totals.cache_creation
        );
    }
}

fn sum_totals<'a>(totals: impl IntoIterator<Item = &'a Totals>) -> Totals {
    totals
        .into_iter()
        .fold(Totals::default(), |mut acc, totals| {
            acc.input += totals.input;
            acc.output += totals.output;
            acc.cache_read += totals.cache_read;
            acc.cache_creation += totals.cache_creation;
            acc
        })
}

fn i64_to_u64(value: i64) -> u64 {
    value.max(0) as u64
}
