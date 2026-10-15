use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_shell::{
    ShellExt,
    process::{CommandChild, CommandEvent},
};
use tokio::sync::oneshot;

type Reply = Result<Value, String>;
const MAXIMUM_FRAME_BYTES: usize = 220 * 1024 * 1024;
const METHODS: &[&str] = &[
    "getState",
    "saveSettings",
    "connectManaged",
    "startConnector",
    "stopConnector",
    "installBundle",
    "reconfigureExtension",
    "activateExtension",
    "disableExtension",
    "rollbackExtension",
    "uninstallExtension",
    "executeAction",
    "digestExtension",
    "generatePublisherKey",
    "signExtension",
    "packExtension",
    "clearLogs",
];

#[derive(Clone)]
struct Bridge {
    child: Arc<Mutex<Option<CommandChild>>>,
    replies: Arc<Mutex<HashMap<String, oneshot::Sender<Reply>>>>,
    sequence: Arc<AtomicU64>,
}
impl Bridge {
    fn write(&self, value: &Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(value).map_err(|_| "Invalid desktop request.")?;
        if bytes.len() > MAXIMUM_FRAME_BYTES {
            return Err("Desktop request exceeds its transport limit.".into());
        }
        bytes.push(b'\n');
        let mut child = self
            .child
            .lock()
            .map_err(|_| "Desktop process is unavailable.")?;
        child
            .as_mut()
            .ok_or("Desktop process stopped.")?
            .write(&bytes)
            .map_err(|_| "Desktop process stopped.".into())
    }
    fn stop(&self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.take() {
                let _ = child.kill();
            }
        }
        if let Ok(mut replies) = self.replies.lock() {
            for (_, reply) in replies.drain() {
                let _ = reply.send(Err("Desktop process stopped.".into()));
            }
        }
    }
}

#[tauri::command]
async fn connector_request(
    method: String,
    args: Vec<Value>,
    bridge: tauri::State<'_, Bridge>,
) -> Reply {
    if !METHODS.contains(&method.as_str()) || args.len() > 4 {
        return Err("Unknown desktop operation.".into());
    }
    let id = bridge.sequence.fetch_add(1, Ordering::Relaxed).to_string();
    let (sender, receiver) = oneshot::channel();
    {
        let mut replies = bridge
            .replies
            .lock()
            .map_err(|_| "Desktop process is unavailable.")?;
        if replies.len() >= 64 {
            return Err("Too many pending desktop operations.".into());
        }
        replies.insert(id.clone(), sender);
    }
    if let Err(error) =
        bridge.write(&json!({"type":"request", "id":id, "method":method, "args":args}))
    {
        bridge
            .replies
            .lock()
            .map_err(|_| "Desktop process is unavailable.")?
            .remove(&id);
        return Err(error);
    }
    let result = tokio::time::timeout(Duration::from_secs(120), receiver).await;
    bridge
        .replies
        .lock()
        .map_err(|_| "Desktop process is unavailable.")?
        .remove(&id);
    match result {
        Ok(Ok(reply)) => reply,
        _ => Err("Desktop operation timed out or stopped.".into()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![connector_request])
        .setup(|app| {
            let script = if cfg!(debug_assertions) {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/connector/dist/desktop/main.js")
            } else {
                app.path().resource_dir()?.join("connector/dist/desktop/main.js")
            };
            let mut arguments = vec![script.to_string_lossy().into_owned()];
            let options: Vec<String> = std::env::args().skip(1).collect();
            if options.len() == 2 && options[0] == "--settings" { arguments.extend(options); }
            let (mut events, child) = app.shell().sidecar("node")?.args(arguments).spawn()?;
            let bridge = Bridge { child: Arc::new(Mutex::new(Some(child))), replies: Arc::new(Mutex::new(HashMap::new())), sequence: Arc::new(AtomicU64::new(1)) };
            app.manage(bridge.clone());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = events.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            if line.len() > MAXIMUM_FRAME_BYTES { bridge.stop(); break; }
                            let value: Value = match serde_json::from_slice(&line) { Ok(value) => value, Err(_) => { bridge.stop(); break; } };
                            match value.get("type").and_then(Value::as_str) {
                                Some("response") => {
                                    if let Some(id) = value.get("id").and_then(Value::as_str) {
                                        if let Ok(mut replies) = bridge.replies.lock() {
                                            if let Some(reply) = replies.remove(id) {
                                                let result = if let Some(error) = value.get("error").and_then(Value::as_str) { Err(error.to_string()) } else { Ok(value.get("result").cloned().unwrap_or(Value::Null)) };
                                                let _ = reply.send(result);
                                            }
                                        }
                                    }
                                }
                                Some("state-changed") => { let _ = handle.emit("connector-state-changed", ()); }
                                Some("ui-request") => {
                                    let Some(id) = value.get("id").and_then(Value::as_str).map(str::to_string) else { continue; };
                                    let request = &value["request"];
                                    let Some(message) = request.get("message").and_then(Value::as_str) else { continue; };
                                    let title = request.get("title").and_then(Value::as_str).unwrap_or("Edge Connector");
                                    let kind = match request.get("kind").and_then(Value::as_str) { Some("error") => MessageDialogKind::Error, Some("warning") => MessageDialogKind::Warning, _ => MessageDialogKind::Info };
                                    let reply_bridge = bridge.clone();
                                    handle.dialog().message(message).title(title).kind(kind).show(move |_| { let _ = reply_bridge.write(&json!({"type":"ui-result", "id":id, "displayed":true})); });
                                }
                                _ => { bridge.stop(); break; }
                            }
                        }
                        CommandEvent::Terminated(_) | CommandEvent::Error(_) => { bridge.stop(); let _ = handle.emit("connector-state-changed", ()); break; }
                        _ => {}
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Could not start Edge Connector Desktop.");
    app.run(|handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            handle.state::<Bridge>().stop();
        }
    });
}
