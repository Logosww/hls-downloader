use js_sys::{Function, Uint8Array};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::sync::Arc;
use wasm_bindgen::prelude::*;
thread_local! {
    static CALLBACKS: RefCell<HashMap<u32, Function>> = RefCell::new(HashMap::new());
    static NEXT_CALLBACK_ID: Cell<u32> = const { Cell::new(1) };
}
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}
fn invoke_local(
    id: u32,
    args: Vec<JsValue>,
) -> tokio::sync::oneshot::Receiver<Result<JsValueResult, String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let call = CALLBACKS.with(|callbacks| {
        let callback = callbacks
            .borrow()
            .get(&id)
            .cloned()
            .ok_or_else(|| "operation has ended".to_string())?;
        let array = js_sys::Array::new();
        for arg in args {
            array.push(&arg);
        }
        callback
            .apply(&JsValue::NULL, &array)
            .map_err(|e| format!("{e:?}"))
    });
    wasm_bindgen_futures::spawn_local(async move {
        let result = match call {
            Ok(value) => wasm_bindgen_futures::JsFuture::from(js_sys::Promise::resolve(&value))
                .await
                .map(|value| {
                    if value.is_undefined() {
                        JsValueResult::Written
                    } else {
                        JsValueResult::Bytes(Uint8Array::new(&value).to_vec())
                    }
                })
                .map_err(|e| format!("{e:?}")),
            Err(error) => Err(error),
        };
        let _ = tx.send(result);
    });
    rx
}

enum JsValueResult {
    Bytes(Vec<u8>),
    Written,
}

struct CallbackRegistration(u32);
impl CallbackRegistration {
    fn new(callback: Function) -> Self {
        let id = NEXT_CALLBACK_ID.with(|next| {
            let id = next.get();
            next.set(id.wrapping_add(1).max(1));
            id
        });
        CALLBACKS.with(|callbacks| {
            callbacks.borrow_mut().insert(id, callback);
        });
        Self(id)
    }
}
impl Drop for CallbackRegistration {
    fn drop(&mut self) {
        CALLBACKS.with(|callbacks| {
            callbacks.borrow_mut().remove(&self.0);
        });
    }
}

mod keyed;
