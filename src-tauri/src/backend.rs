use std::{collections::HashMap, io::{BufRead, BufReader, Write}, path::PathBuf, process::{Child, ChildStdin, Command, Stdio}, sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}}, time::Duration};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;
use crate::desktop;
use crate::lifecycle::{ExitGate, disconnected_status};

type Reply = oneshot::Sender<Result<Value, String>>;
struct Process { child: Option<Child>, input: Option<ChildStdin>, pending: HashMap<u64, Reply> }
pub struct Backend {
    process: Mutex<Process>, sequence: AtomicU64, exit: ExitGate,
    pub status: Mutex<Value>, node: PathBuf, script: PathBuf, host: Value,
}

impl Backend {
    pub fn start(app: AppHandle) -> Result<Arc<Self>, Box<dyn std::error::Error>> {
        let resources = if cfg!(target_os = "windows") { std::env::current_exe()?.parent().unwrap().join("resources/native") }
            else { app.path().resource_dir()?.join("native") };
        let name = app.package_info().name.clone();
        let data = std::env::var_os("WECHAT_DOT_DATA").map(PathBuf::from).unwrap_or(app.path().config_dir()?.join(&name));
        std::fs::create_dir_all(&data)?;
        let executable = std::env::current_exe()?;
        let host = json!({ "name": name, "version": app.package_info().version.to_string(), "isPackaged": true,
            "appDirectory": resources, "resourcesDirectory": resources, "userDirectory": data,
            "cacheDirectory": app.path().cache_dir()?, "executablePath": executable, "pid": std::process::id() });
        let backend = Arc::new(Self {
            process: Mutex::new(Process { child: None, input: None, pending: HashMap::new() }),
            sequence: AtomicU64::new(0), exit: ExitGate::default(), status: Mutex::new(json!({})),
            node: resources.join(if cfg!(target_os = "windows") { "node.exe" } else { "node" }), script: resources.join("backend.cjs"), host,
        });
        let output = backend.spawn()?;
        let worker = backend.clone();
        std::thread::spawn(move || worker.supervise(app, output));
        Ok(backend)
    }
    fn spawn(&self) -> std::io::Result<std::process::ChildStdout> {
        let mut command = Command::new(&self.node);
        command.arg(&self.script).arg(self.host.to_string()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
        #[cfg(target_os = "windows")]
        { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        let mut child = command.spawn()?;
        let output = child.stdout.take().unwrap();
        let mut process = self.process.lock().unwrap();
        process.input = child.stdin.take(); process.child = Some(child);
        Ok(output)
    }
    fn supervise(self: Arc<Self>, app: AppHandle, mut output: std::process::ChildStdout) {
        loop {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
                if let Some(id) = value["id"].as_u64() {
                    if let Some(reply) = self.process.lock().unwrap().pending.remove(&id) {
                        let result = value["error"].as_str().map(|e| Err(e.to_owned())).unwrap_or_else(|| Ok(value["result"].clone()));
                        let _ = reply.send(result);
                    }
                } else { desktop::event(&app, &self, &value); }
            }
            let child = {
                let mut process = self.process.lock().unwrap(); process.input = None;
                for (_, reply) in process.pending.drain() { let _ = reply.send(Err("后台连接已断开，正在自动重试…".into())); }
                process.child.take()
            };
            if let Some(mut child) = child { let _ = child.wait(); }
            if self.is_stopping() { return }
            let status = disconnected_status(&self.status.lock().unwrap());
            desktop::event(&app, &self, &json!({ "event": "status", "value": status }));
            loop {
                std::thread::sleep(Duration::from_secs(3));
                if self.is_stopping() { return }
                match self.spawn() { Ok(pipe) => { output = pipe; break }, Err(error) => eprintln!("Backend restart: {error}") }
            }
        }
    }
    pub async fn request(&self, method: &str, args: Value) -> Result<Value, String> {
        let id = self.sequence.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        {
            let mut process = self.process.lock().unwrap();
            let input = process.input.as_mut().ok_or("后台正在自动重试，请稍候。")?;
            writeln!(input, "{}", json!({ "id": id, "method": method, "args": args })).map_err(|e| e.to_string())?;
            process.pending.insert(id, sender);
        }
        receiver.await.map_err(|_| "后台已断开，正在自动重试…".to_owned())?
    }
    pub fn is_stopping(&self) -> bool { self.exit.stopping() }
    pub fn exit_ready(&self) -> bool { self.exit.ready() }
}

pub fn shutdown(app: &AppHandle) {
    let backend = app.state::<Arc<Backend>>().inner().clone();
    if !backend.exit.begin() { return }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = tokio::time::timeout(Duration::from_secs(15), backend.request("shutdown", json!([]))).await;
        if let Some(child) = backend.process.lock().unwrap().child.as_mut() { let _ = child.kill(); }
        backend.exit.finish(); app.exit(0);
    });
}
