use super::*;
use hls_engine::crypto::key::KeyFuture;

#[path = "../../../../rust/keyed.rs"]
mod wire;
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn monotonic_ms() -> f64;
}
struct Host {
    read: u32,
    resolve: u32,
    abort: u32,
    start: f64,
}
fn call(id: u32, value: &JsValue) -> std::result::Result<JsValue, JsValue> {
    let cb = CALLBACKS.with(|c| c.borrow().get(&id).cloned());
    cb.ok_or_else(|| JsValue::from_str("closed bridge"))?
        .call1(&JsValue::NULL, value)
}
impl wire::Host for Host {
    fn now(&self) -> u64 {
        (monotonic_ms() - self.start).max(0.0) as u64
    }
    fn abort(&self, id: String) {
        let _ = call(self.abort, &JsValue::from_str(&id));
    }
    fn read(&self, r: String) -> wire::ReadFuture {
        let receiver = invoke_local(self.read, vec![JsValue::from_str(&r)]);
        Box::pin(async move {
            match receiver.await {
                Ok(Ok(JsValueResult::Bytes(b))) => Ok(b),
                _ => Err(hls_engine::legacy::Error::Http("read bridge failed".into())),
            }
        })
    }
    fn resolve(&self, r: String) -> KeyFuture<wire::Reply> {
        let result = call(self.resolve, &JsValue::from_str(&r));
        Box::pin(async move {
            let failure = || wire::Reply {
                status: "failure".into(),
                key: Vec::new(),
                version: None,
                ttl: None,
            };
            let Ok(value) = result else { return failure() };
            let Ok(value) =
                wasm_bindgen_futures::JsFuture::from(js_sys::Promise::resolve(&value)).await
            else {
                return failure();
            };
            let get = |name: &str| {
                js_sys::Reflect::get(&value, &JsValue::from_str(name)).unwrap_or(JsValue::UNDEFINED)
            };
            let bytes = get("key");
            if !bytes.is_instance_of::<Uint8Array>() {
                return wire::Reply {
                    status: "invalid".into(),
                    ..failure()
                };
            }
            wire::Reply {
                status: get("status").as_string().unwrap_or_default(),
                key: Uint8Array::new(&bytes).to_vec(),
                version: get("version").as_string(),
                ttl: get("ttl").as_string().and_then(|s| s.parse().ok()),
            }
        })
    }
}
#[wasm_bindgen]
pub fn parse_media_playlist_browser(text: String, url: String) -> String {
    wire::metadata(text, url)
}
struct TimelineOutputHost {
    control: u32,
    write: u32,
}
impl wire::timeline::OutputHost for TimelineOutputHost {
    fn control(&self, value: String) -> wire::timeline::OutputFuture<String> {
        let value = call(self.control, &JsValue::from_str(&value));
        Box::pin(async move {
            let value = value.map_err(|_| std::io::Error::other("output control failed"))?;
            let value = wasm_bindgen_futures::JsFuture::from(js_sys::Promise::resolve(&value))
                .await
                .map_err(|_| std::io::Error::other("output control failed"))?;
            Ok(value.as_string().unwrap_or_default())
        })
    }
    fn write(&self, index: String, bytes: Vec<u8>) -> wire::timeline::OutputFuture<()> {
        let receiver = invoke_local(
            self.write,
            vec![
                Uint8Array::from(bytes.as_slice()).into(),
                JsValue::from_str(&index),
            ],
        );
        Box::pin(async move {
            match receiver.await {
                Ok(Ok(_)) => Ok(()),
                _ => Err(std::io::Error::other("output write failed")),
            }
        })
    }
}
#[wasm_bindgen]
pub struct BrowserRecording {
    bridge: std::rc::Rc<wire::continuous::Bridge>,
    _callbacks: Vec<CallbackRegistration>,
}
#[wasm_bindgen]
impl BrowserRecording {
    #[wasm_bindgen(constructor)]
    pub fn new(
        request: String,
        read: Function,
        write: Function,
        resolve: Function,
        abort: Function,
        control: Function,
    ) -> std::result::Result<BrowserRecording, JsValue> {
        let read = CallbackRegistration::new(read);
        let write = CallbackRegistration::new(write);
        let resolve = CallbackRegistration::new(resolve);
        let abort = CallbackRegistration::new(abort);
        let control = CallbackRegistration::new(control);
        let host = Arc::new(Host {
            read: read.0,
            resolve: resolve.0,
            abort: abort.0,
            start: monotonic_ms(),
        });
        let output = Arc::new(TimelineOutputHost {
            control: control.0,
            write: write.0,
        });
        let bridge = wire::continuous::Bridge::new(&request, host, output)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(Self {
            bridge: std::rc::Rc::new(bridge),
            _callbacks: vec![read, write, resolve, abort, control],
        })
    }
    pub async fn command(&self, command: String) -> String {
        self.bridge.command(&command).await.to_string()
    }
    pub async fn run(&self) -> String {
        // Tokio's watch-based pause loop needs a cooperative task budget on WASM too.
        let local = tokio::task::LocalSet::new();
        let bridge = self.bridge.clone();
        let task = local.spawn_local(async move { bridge.run().await.to_string() });
        local
            .run_until(task)
            .await
            .unwrap_or_else(|_| wire::error("RECORDING_FAILED", "executor").to_string())
    }
}

#[wasm_bindgen]
pub fn query_capability_browser(request: String) -> String {
    wire::capability::query(&request)
}
