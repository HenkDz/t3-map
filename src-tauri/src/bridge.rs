use std::{
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

pub struct Bridge {
    child: Child,
    pub port: u16,
}

fn ready_port(line: &str) -> Result<u16, String> {
    let frame: serde_json::Value =
        serde_json::from_str(line).map_err(|_| "Invalid bridge readiness message.")?;
    if frame["type"] != "t3-map-ready" {
        return Err("Unexpected bridge readiness message.".into());
    }
    frame["port"]
        .as_u64()
        .and_then(|p| u16::try_from(p).ok())
        .filter(|p| *p != 0)
        .ok_or_else(|| "Invalid bridge port.".into())
}

impl Bridge {
    pub fn start(node: &Path, entry: &Path) -> Result<Self, String> {
        let entry = node_entry_path(entry)?;
        let mut command = Command::new(node);
        // Node 26 cannot resolve Windows verbatim paths passed as its entry argument.
        command
            .current_dir(entry.parent().ok_or("Missing bridge directory.")?)
            .arg(entry.file_name().ok_or("Missing bridge entry file.")?)
            .env("T3_MAP_PORT", "0")
            .env("T3_MAP_DESKTOP", "1")
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let child = command
            .spawn()
            .map_err(|e| format!("Could not start bundled Node ({}): {e}", node.display()))?;
        let mut bridge = Self { child, port: 0 };
        let stdout = bridge.child.stdout.take().unwrap();
        let mut stderr = bridge.child.stderr.take().unwrap();
        let detail = Arc::new(Mutex::new(String::new()));
        let errors = detail.clone();
        thread::spawn(move || {
            let mut buffer = [0; 1024];
            while let Ok(n) = stderr.read(&mut buffer) {
                if n == 0 {
                    break;
                }
                let mut text = errors.lock().unwrap();
                if text.len() < 8192 {
                    text.push_str(&String::from_utf8_lossy(&buffer[..n]));
                }
            }
        });
        let (tx, rx) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut lines = BufReader::new(stdout).lines();
            if let Some(line) = lines.next() {
                let _ = tx.send(line.map_err(|e| e.to_string()).and_then(|s| ready_port(&s)));
            }
            // Drain stdout so the owned process cannot block on a full pipe.
            for _ in lines {}
        });
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(Ok(port)) => {
                    bridge.port = port;
                    return Ok(bridge);
                }
                Ok(Err(error)) => return Err(error),
                _ => {}
            }
            if let Some(status) = bridge.child.try_wait().map_err(|e| e.to_string())? {
                return Err(format!(
                    "The local bridge exited ({status}).\n{}",
                    detail.lock().unwrap()
                ));
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "The local bridge did not become ready within 15 seconds.\n{}",
                    detail.lock().unwrap()
                ));
            }
        }
    }
}

fn node_entry_path(entry: &Path) -> Result<PathBuf, String> {
    // URL's Windows path conversion handles both verbatim drive and UNC prefixes.
    tauri::Url::from_file_path(entry)
        .and_then(|url| url.to_file_path())
        .map_err(|_| "The bridge entry must have a Unicode absolute path.".into())
}

impl Drop for Bridge {
    fn drop(&mut self) {
        // Only this Child handle is stopped; never look up or kill by port/name.
        drop(self.child.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            thread::sleep(Duration::from_millis(25));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_requires_owned_protocol_and_valid_bound_port() {
        assert_eq!(
            ready_port(r#"{"type":"t3-map-ready","port":53123}"#).unwrap(),
            53123
        );
        for line in [
            "http://127.0.0.1:4773",
            r#"{"type":"other","port":1}"#,
            r#"{"type":"t3-map-ready","port":0}"#,
            r#"{"type":"t3-map-ready","port":65536}"#,
        ] {
            assert!(ready_port(line).is_err());
        }
    }

    #[test]
    fn missing_runtime_has_useful_error() {
        assert!(Bridge::start(
            Path::new("missing-node-runtime.exe"),
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/server/index.mjs")
        )
        .err()
        .unwrap()
        .contains("Could not start bundled Node"));
    }

    #[test]
    fn canonical_entry_outside_repo_starts_and_drop_closes_listener() {
        use std::io::Write;
        use std::net::TcpStream;
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let target = if cfg!(target_arch = "aarch64") {
            "aarch64"
        } else {
            "x86_64"
        };
        let node = root.join(format!("binaries/node-{target}-pc-windows-msvc.exe"));
        let script =
            std::env::temp_dir().join(format!("t3-map lifecycle-{}.mjs", std::process::id()));
        let entry = tauri::Url::from_file_path(root.join("resources/server/index.mjs")).unwrap();
        std::fs::write(
            &script,
            format!(
                "process.env.T3_MAP_DEMO='1';await import({});",
                serde_json::to_string(entry.as_str()).unwrap()
            ),
        )
        .unwrap();
        let child = Bridge::start(&node, &std::fs::canonicalize(&script).unwrap()).unwrap();
        let address = format!("127.0.0.1:{}", child.port);
        let mut stream = TcpStream::connect(&address).unwrap();
        stream
            .write_all(
                format!("GET /api/health HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        drop(child);
        assert!(TcpStream::connect(&address).is_err());
        std::fs::remove_file(script).unwrap();
    }

    #[test]
    fn node_paths_normalize_drive_and_unc_prefixes_without_losing_characters() {
        for (input, expected) in [
            (
                r"\\?\C:\Program Files\T3 Map\index.mjs",
                r"C:\Program Files\T3 Map\index.mjs",
            ),
            (
                r"\\?\UNC\server\share\T3 Map\index.mjs",
                r"\\server\share\T3 Map\index.mjs",
            ),
            (r"C:\T3 Map\é #%\index.mjs", r"C:\T3 Map\é #%\index.mjs"),
        ] {
            assert_eq!(
                node_entry_path(Path::new(input)).unwrap(),
                Path::new(expected)
            );
        }
    }
}
