use cc_panes_ctl::cli::{execute, Cli};
use clap::{error::ErrorKind, Parser};

fn main() {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(error)
            if matches!(
                error.kind(),
                ErrorKind::DisplayHelp | ErrorKind::DisplayVersion
            ) =>
        {
            let _ = error.print();
            return;
        }
        Err(error) => {
            let _ = error.print();
            std::process::exit(3);
        }
    };
    if let Err(error) = execute(cli) {
        eprintln!("错误: {}", error.message);
        std::process::exit(error.code);
    }
}
