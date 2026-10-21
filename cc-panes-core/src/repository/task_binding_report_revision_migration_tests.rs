#[test]
fn migration_43_preserves_existing_bindings_and_initializes_report_revision() {
    let db = Database::new_in_memory().unwrap();
    let conn = db.connection().unwrap();
    conn.execute("DELETE FROM schema_migrations WHERE version >= 43", [])
        .unwrap();
    conn.execute("ALTER TABLE task_bindings DROP COLUMN report_revision", [])
        .unwrap();
    conn.execute("INSERT INTO task_bindings(id,title,project_path,status,completion_summary,created_at,updated_at) VALUES ('legacy','legacy task','/repo','completed','existing result','created','updated')", []).unwrap();
    Database::run_migrations(&conn).unwrap();
    let row: (String, String, i64) = conn
        .query_row(
            "SELECT status,completion_summary,report_revision FROM task_bindings WHERE id='legacy'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(row, ("completed".into(), "existing result".into(), 0));
    Database::run_migrations(&conn).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT report_revision FROM task_bindings WHERE id='legacy'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}
