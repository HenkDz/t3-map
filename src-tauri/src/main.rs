#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;

use std::sync::{Arc, Mutex};
use tauri::{webview::NewWindowResponse, Manager, Url, WebviewUrl, WebviewWindowBuilder};

fn is_bridge(url: &Url, port: u16) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(port)
        && url.username().is_empty()
        && url.password().is_none()
}

fn open_external(url: &Url) {
    if matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
    {
        if let Err(error) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>) {
            eprintln!("Could not open external link: {error}");
        }
    }
}

fn show_error(window: &tauri::WebviewWindow, error: &str) {
    let message = serde_json::to_string(error).unwrap();
    let _ = window.eval(format!("document.getElementById('title').textContent='T3 Map could not start';document.getElementById('message').textContent='Close this window and try again. Check that the bundled runtime and bridge files are present.';document.getElementById('detail').textContent={message};"));
}

fn main() {
    let app = tauri::Builder::default()
        .manage(Mutex::new(None::<bridge::Bridge>))
        .setup(|app| {
            let handle = app.handle().clone();
            let startup_error = Arc::new(Mutex::new(None::<String>));
            let pending_error = startup_error.clone();
            // Start off the UI thread; the loading/error window uses only bundled HTML.
            let startup =
                WebviewWindowBuilder::new(app, "startup", WebviewUrl::App("index.html".into()))
                    .title("T3 Map")
                    .inner_size(900.0, 600.0)
                    .on_page_load(move |window, payload| {
                        if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                            if let Some(error) = pending_error.lock().unwrap().as_ref() {
                                show_error(&window, error);
                            }
                        }
                    })
                    .build()?;
            std::thread::spawn(move || {
                let result = (|| -> Result<(), String> {
                    let resources = handle.path().resource_dir().map_err(|e| e.to_string())?;
                    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
                    let node = executable
                        .parent()
                        .ok_or("Missing executable directory.")?
                        .join("node.exe");
                    let child =
                        bridge::Bridge::start(&node, &resources.join("bridge/server/index.mjs"))?;
                    let port = child.port;
                    println!("T3 Map desktop bridge ready at http://127.0.0.1:{port}/");
                    let url = format!("http://127.0.0.1:{port}/")
                        .parse()
                        .map_err(|e| format!("Invalid bridge URL: {e}"))?;
                    *handle
                        .state::<Mutex<Option<bridge::Bridge>>>()
                        .lock()
                        .unwrap() = Some(child);
                    WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(url))
                        .title("T3 Map")
                        .inner_size(1440.0, 900.0)
                        .min_inner_size(800.0, 600.0)
                        .visible(false)
                        .disable_drag_drop_handler()
                        .on_navigation(move |url| {
                            if is_bridge(url, port) {
                                true
                            } else {
                                open_external(url);
                                false
                            }
                        })
                        .on_new_window(|url, _| {
                            open_external(&url);
                            NewWindowResponse::Deny
                        })
                        .on_page_load(|window, payload| {
                            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                                let _ = window.show();
                                if let Some(startup) =
                                    window.app_handle().get_webview_window("startup")
                                {
                                    let _ = startup.close();
                                }
                            }
                        })
                        .build()
                        .map_err(|e| e.to_string())?;
                    Ok(())
                })();
                if let Err(error) = result {
                    eprintln!("T3 Map startup failed: {error}");
                    handle
                        .state::<Mutex<Option<bridge::Bridge>>>()
                        .lock()
                        .unwrap()
                        .take();
                    *startup_error.lock().unwrap() = Some(error.clone());
                    show_error(&startup, &error);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Could not initialize the T3 Map desktop window");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            app.state::<Mutex<Option<bridge::Bridge>>>()
                .lock()
                .unwrap()
                .take();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_is_bound_to_the_owned_http_origin() {
        assert!(is_bridge(
            &"http://127.0.0.1:53123/api/health".parse().unwrap(),
            53123
        ));
        for url in [
            "http://127.0.0.1:4773/",
            "https://127.0.0.1:53123/",
            "http://localhost:53123/",
            "http://127.0.0.1.evil.example:53123/",
            "http://user@127.0.0.1:53123/",
        ] {
            assert!(!is_bridge(&url.parse().unwrap(), 53123));
        }
    }
}
