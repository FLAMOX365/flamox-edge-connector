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
#[derive(Debug, PartialEq)]
enum SidecarMessage {
    Response { id: String, result: Reply },
    StateChanged,
    UiRequest { id: String, request: Value },
}

fn parse_message(line: &[u8]) -> Result<SidecarMessage, String> {
    if line.len() > MAXIMUM_FRAME_BYTES {
        return Err("Desktop response exceeds its transport limit.".into());
    }
    let value: Value = serde_json::from_slice(line).map_err(|_| "Invalid desktop response.")?;
    let identifier = || {
        value
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| "Invalid desktop response identifier.".to_string())
    };
    match value.get("type").and_then(Value::as_str) {
        Some("response") => {
            let id = identifier()?;
            let result = match value.get("error") {
                Some(Value::String(error)) => Err(error.clone()),
                Some(_) => return Err("Invalid desktop error response.".into()),
                None => Ok(value
                    .get("result")
                    .cloned()
                    .ok_or("Missing desktop result.")?),
            };
            Ok(SidecarMessage::Response { id, result })
        }
        Some("state-changed") => Ok(SidecarMessage::StateChanged),
        Some("ui-request") => {
            let id = identifier()?;
            let request = value
                .get("request")
                .filter(|request| request.get("message").and_then(Value::as_str).is_some())
                .cloned()
                .ok_or("Invalid desktop dialog request.")?;
            Ok(SidecarMessage::UiRequest { id, request })
        }
        _ => Err("Unknown desktop response.".into()),
    }
}

fn validate_request(method: &str, arguments: &[Value]) -> Result<(), String> {
    if !METHODS.contains(&method) || arguments.len() > 4 {
        return Err("Unknown desktop operation.".into());
    }
    Ok(())
}

impl Bridge {
    fn complete(&self, id: &str, result: Reply) {
        if let Ok(mut replies) = self.replies.lock() {
            if let Some(reply) = replies.remove(id) {
                let _ = reply.send(result);
            }
        }
    }
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
    validate_request(&method, &args)?;
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
                            let message = match parse_message(&line) { Ok(message) => message, Err(_) => { bridge.stop(); let _ = handle.emit("connector-state-changed", ()); break; } };
                            match message {
                                SidecarMessage::Response { id, result } => bridge.complete(&id, result),
                                SidecarMessage::StateChanged => { let _ = handle.emit("connector-state-changed", ()); }
                                SidecarMessage::UiRequest { id, request } => {
                                    let message = request["message"].as_str().expect("Validated dialog message");
                                    let title = request.get("title").and_then(Value::as_str).unwrap_or("Edge Connector");
                                    let kind = match request.get("kind").and_then(Value::as_str) { Some("error") => MessageDialogKind::Error, Some("warning") => MessageDialogKind::Warning, _ => MessageDialogKind::Info };
                                    let reply_bridge = bridge.clone();
                                    if let Some(window) = handle.get_webview_window("main") {
                                        handle.dialog().message(message).title(title).kind(kind).parent(&window).show(move |_| { let _ = reply_bridge.write(&json!({"type":"ui-result", "id":id, "displayed":true})); });
                                    } else {
                                        let _ = reply_bridge.write(&json!({"type":"ui-result", "id":id, "displayed":false}));
                                    }
                                }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn bridge() -> Bridge {
        Bridge {
            child: Arc::new(Mutex::new(None)),
            replies: Arc::new(Mutex::new(HashMap::new())),
            sequence: Arc::new(AtomicU64::new(1)),
        }
    }

    #[test]
    fn rejects_unknown_operations_and_excess_arguments() {
        assert!(validate_request("getState", &[]).is_ok());
        assert!(validate_request("executeAction", &[json!({"extensionId":"test"})]).is_ok());
        for operation in ["__proto__", "constructor", "exec", "shell", "shutdown", ""] {
            assert!(validate_request(operation, &[]).is_err());
        }
        assert!(validate_request("getState", &vec![Value::Null; 5]).is_err());
    }

    #[test]
    fn parses_unicode_binary_results_errors_and_push_messages() {
        let response = json!({"type":"response", "id":"1", "result":{"message":"Grüße", "bytes":{"encoding":"base64", "data":"AP8="}}});
        assert_eq!(
            parse_message(&serde_json::to_vec(&response).unwrap()),
            Ok(SidecarMessage::Response {
                id: "1".into(),
                result: Ok(response["result"].clone())
            })
        );
        assert_eq!(
            parse_message(br#"{"type":"response","id":"2","error":"Denied"}"#),
            Ok(SidecarMessage::Response {
                id: "2".into(),
                result: Err("Denied".into())
            })
        );
        assert_eq!(
            parse_message(br#"{"type":"state-changed"}"#),
            Ok(SidecarMessage::StateChanged)
        );
        assert!(matches!(parse_message(br#"{"type":"ui-request","id":"dialog","request":{"message":"Hello","kind":"warning"}}"#), Ok(SidecarMessage::UiRequest { .. })));
        assert_eq!(
            parse_message(br#"{"type":"response","id":"3","result":null}"#),
            Ok(SidecarMessage::Response {
                id: "3".into(),
                result: Ok(Value::Null)
            })
        );
    }

    #[test]
    fn rejects_malformed_frames_instead_of_leaving_requests_pending() {
        for frame in [
            "{",
            "null",
            "[]",
            r#"{"type":"unknown"}"#,
            r#"{"type":"response","result":true}"#,
            r#"{"type":"response","id":"","result":true}"#,
            r#"{"type":"response","id":"1"}"#,
            r#"{"type":"response","id":"1","error":false}"#,
            r#"{"type":"ui-request","id":"1","request":{"message":42}}"#,
        ] {
            assert!(
                parse_message(frame.as_bytes()).is_err(),
                "Accepted malformed frame: {frame}"
            );
        }
    }

    #[test]
    fn correlates_out_of_order_replies_and_ignores_duplicate_or_late_ids() {
        let bridge = bridge();
        let (one, mut first) = oneshot::channel();
        let (two, mut second) = oneshot::channel();
        bridge.replies.lock().unwrap().insert("1".into(), one);
        bridge.replies.lock().unwrap().insert("2".into(), two);
        bridge.complete("2", Ok(json!(2)));
        assert_eq!(second.try_recv(), Ok(Ok(json!(2))));
        assert!(first.try_recv().is_err());
        bridge.complete("2", Err("duplicate".into()));
        bridge.complete("unknown", Ok(Value::Null));
        bridge.complete("1", Err("denied".into()));
        assert_eq!(first.try_recv(), Ok(Err("denied".into())));
        assert!(bridge.replies.lock().unwrap().is_empty());
    }

    #[test]
    fn stopping_drains_pending_replies_and_is_idempotent() {
        let bridge = bridge();
        let (sender, mut receiver) = oneshot::channel();
        bridge
            .replies
            .lock()
            .unwrap()
            .insert("pending".into(), sender);
        bridge.stop();
        assert_eq!(
            receiver.try_recv(),
            Ok(Err("Desktop process stopped.".into()))
        );
        bridge.stop();
        assert!(bridge.replies.lock().unwrap().is_empty());
        assert!(bridge.write(&json!({"type":"request"})).is_err());
    }
}
