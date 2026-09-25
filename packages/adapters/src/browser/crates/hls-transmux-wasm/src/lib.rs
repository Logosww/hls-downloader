use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use hls_transmux::{
    ByteRange, Error as TransmuxError, HlsInput, OutputFormat, Source, SourceLocation,
    TextResource, TransmuxOptions, TransmuxReport, transmux_hls_to_mp4_bytes,
    transmux_hls_to_writer_async,
};
use js_sys::{Function, Object, Reflect, Uint8Array};
use tokio::io::AsyncWrite;
use wasm_bindgen::prelude::*;

thread_local! {
    static CALLBACKS: RefCell<HashMap<u32, Function>> = RefCell::new(HashMap::new());
    static NEXT_CALLBACK_ID: Cell<u32> = const { Cell::new(1) };
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[derive(Debug, Default)]
struct PreloadedSource {
    texts: HashMap<String, String>,
    bytes: HashMap<String, Vec<u8>>,
    ranges: HashMap<(String, u64, u64), Vec<u8>>,
}

fn location_key(location: &SourceLocation) -> String {
    match location {
        SourceLocation::Url(url) => url.to_string(),
        SourceLocation::File(path) => path.to_string_lossy().into_owned(),
    }
}

impl Source for PreloadedSource {
    fn read_text<'a>(
        &'a self,
        location: &'a SourceLocation,
    ) -> Pin<Box<dyn Future<Output = Result<TextResource, TransmuxError>> + Send + 'a>> {
        Box::pin(async move {
            let key = location_key(location);
            let content = self.texts.get(&key).ok_or_else(|| {
                TransmuxError::invalid(format!("PreloadedSource: no text found for {key}"))
            })?;
            Ok(TextResource {
                content: content.clone(),
                location: location.clone(),
            })
        })
    }

    fn read_bytes<'a>(
        &'a self,
        location: &'a SourceLocation,
        range: Option<&'a ByteRange>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, TransmuxError>> + Send + 'a>> {
        Box::pin(async move {
            let key = location_key(location);
            if let Some(range) = range {
                if let Some(bytes) = self.ranges.get(&(key.clone(), range.offset, range.length)) {
                    return Ok(bytes.clone());
                }
                if let Some(bytes) = self.bytes.get(&key) {
                    let start = usize::try_from(range.offset)
                        .map_err(|_| TransmuxError::invalid("byte range offset overflow"))?;
                    let length = usize::try_from(range.length)
                        .map_err(|_| TransmuxError::invalid("byte range length overflow"))?;
                    let end = start
                        .checked_add(length)
                        .ok_or_else(|| TransmuxError::invalid("byte range overflow"))?;
                    return bytes
                        .get(start..end)
                        .map(|slice| slice.to_vec())
                        .ok_or_else(|| {
                            TransmuxError::invalid("byte range exceeds resource length")
                        });
                }
            }
            self.bytes.get(&key).cloned().ok_or_else(|| {
                TransmuxError::invalid(format!("PreloadedSource: no bytes found for {key}"))
            })
        })
    }
}

fn parse_resource_map(resources: &JsValue) -> Result<(PreloadedSource, String), JsValue> {
    let obj = resources
        .dyn_ref::<Object>()
        .ok_or_else(|| JsValue::from_str("resources must be an object"))?;
    let playlist_url = Reflect::get(obj, &JsValue::from_str("playlistUrl"))?
        .as_string()
        .ok_or_else(|| JsValue::from_str("playlistUrl must be a string"))?;
    let texts_value = Reflect::get(obj, &JsValue::from_str("texts"))?;
    let bytes_value = Reflect::get(obj, &JsValue::from_str("bytes"))?;
    let ranges_value = Reflect::get(obj, &JsValue::from_str("ranges"))?;
    let texts_obj = texts_value
        .dyn_ref::<Object>()
        .ok_or_else(|| JsValue::from_str("texts must be an object"))?;
    let bytes_obj = bytes_value
        .dyn_ref::<Object>()
        .ok_or_else(|| JsValue::from_str("bytes must be an object"))?;

    let mut texts = HashMap::new();
    let text_keys = Object::keys(texts_obj);
    for index in 0..text_keys.length() {
        let key = text_keys.get(index).as_string().unwrap_or_default();
        let value = Reflect::get(texts_obj, &JsValue::from_str(&key))?
            .as_string()
            .ok_or_else(|| JsValue::from_str("text values must be strings"))?;
        texts.insert(key, value);
    }

    let mut bytes = HashMap::new();
    let byte_keys = Object::keys(bytes_obj);
    for index in 0..byte_keys.length() {
        let key = byte_keys.get(index).as_string().unwrap_or_default();
        let value = Reflect::get(bytes_obj, &JsValue::from_str(&key))?;
        let array = Uint8Array::new(&value);
        let mut buffer = vec![0_u8; array.length() as usize];
        array.copy_to(&mut buffer);
        bytes.insert(key, buffer);
    }

    let mut ranges = HashMap::new();
    let range_values = js_sys::Array::from(&ranges_value);
    for index in 0..range_values.length() {
        let value = range_values.get(index);
        let range_obj = value
            .dyn_ref::<Object>()
            .ok_or_else(|| JsValue::from_str("range entries must be objects"))?;
        let url = Reflect::get(range_obj, &JsValue::from_str("url"))?
            .as_string()
            .ok_or_else(|| JsValue::from_str("range url must be a string"))?;
        let offset = Reflect::get(range_obj, &JsValue::from_str("offset"))?
            .as_f64()
            .ok_or_else(|| JsValue::from_str("range offset must be a number"))?
            as u64;
        let length = Reflect::get(range_obj, &JsValue::from_str("length"))?
            .as_f64()
            .ok_or_else(|| JsValue::from_str("range length must be a number"))?
            as u64;
        let bytes_value = Reflect::get(range_obj, &JsValue::from_str("bytes"))?;
        let array = Uint8Array::new(&bytes_value);
        let mut buffer = vec![0_u8; array.length() as usize];
        array.copy_to(&mut buffer);
        ranges.insert((url, offset, length), buffer);
    }

    Ok((
        PreloadedSource {
            texts,
            bytes,
            ranges,
        },
        playlist_url,
    ))
}

fn create_input(resources: &JsValue) -> Result<HlsInput, JsValue> {
    let (source, playlist_url) = parse_resource_map(resources)?;
    let location = SourceLocation::Url(
        url::Url::parse(&playlist_url).map_err(|error| JsValue::from_str(&error.to_string()))?,
    );
    Ok(HlsInput::custom(Arc::new(source), location))
}

fn report_to_js(buffer: Option<&[u8]>, report: &TransmuxReport) -> Result<JsValue, JsValue> {
    let output = Object::new();
    if let Some(buffer) = buffer {
        Reflect::set(
            &output,
            &JsValue::from_str("buffer"),
            &Uint8Array::from(buffer),
        )?;
    }
    Reflect::set(
        &output,
        &JsValue::from_str("segmentCount"),
        &JsValue::from_f64(report.segment_count as f64),
    )?;
    Reflect::set(
        &output,
        &JsValue::from_str("bytesWritten"),
        &JsValue::from_f64(report.bytes_written as f64),
    )?;
    Ok(output.into())
}

#[wasm_bindgen]
pub async fn transmux_preloaded_to_mp4_report(resources: JsValue) -> Result<JsValue, JsValue> {
    let input = create_input(&resources)?;
    let (buffer, report) = transmux_hls_to_mp4_bytes(input, TransmuxOptions::default())
        .await
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
    report_to_js(Some(&buffer), &report)
}

struct CallbackWriter {
    id: u32,
}

impl AsyncWrite for CallbackWriter {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<Result<usize, std::io::Error>> {
        let result = CALLBACKS.with(|callbacks| {
            let callbacks = callbacks.borrow();
            let callback = callbacks
                .get(&self.id)
                .ok_or_else(|| std::io::Error::other("stream callback is no longer registered"))?;
            callback
                .call1(&JsValue::NULL, &Uint8Array::from(data).into())
                .map_err(|error| std::io::Error::other(format!("{error:?}")))?;
            Ok(data.len())
        });
        Poll::Ready(result)
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Result<(), std::io::Error>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
    ) -> Poll<Result<(), std::io::Error>> {
        Poll::Ready(Ok(()))
    }
}

#[wasm_bindgen]
pub async fn transmux_preloaded_to_fmp4_stream(
    resources: JsValue,
    on_chunk: Function,
) -> Result<JsValue, JsValue> {
    let input = create_input(&resources)?;
    let callback_id = NEXT_CALLBACK_ID.with(|next| {
        let id = next.get();
        next.set(id.wrapping_add(1).max(1));
        id
    });
    CALLBACKS.with(|callbacks| {
        callbacks.borrow_mut().insert(callback_id, on_chunk);
    });

    let mut writer = CallbackWriter { id: callback_id };
    let result = transmux_hls_to_writer_async(
        input,
        &mut writer,
        TransmuxOptions {
            output_format: OutputFormat::FragmentedMp4,
            write_mfra: true,
            ..Default::default()
        },
    )
    .await;

    CALLBACKS.with(|callbacks| {
        callbacks.borrow_mut().remove(&callback_id);
    });

    let report = result.map_err(|error| JsValue::from_str(&error.to_string()))?;
    report_to_js(None, &report)
}

// JavaScript values stay on the local executor. Only owned Rust data and oneshot
// receivers cross the Send futures required by Source/AsyncWrite.
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

#[derive(Debug)]
struct DemandSource {
    id: u32,
    playlist_url: String,
    playlist: String,
}

impl Source for DemandSource {
    fn read_text<'a>(
        &'a self,
        location: &'a SourceLocation,
    ) -> Pin<Box<dyn Future<Output = Result<TextResource, TransmuxError>> + Send + 'a>> {
        Box::pin(async move {
            if location_key(location) != self.playlist_url {
                return Err(TransmuxError::invalid("unexpected playlist request"));
            }
            Ok(TextResource {
                content: self.playlist.clone(),
                location: location.clone(),
            })
        })
    }
    fn read_bytes<'a>(
        &'a self,
        location: &'a SourceLocation,
        range: Option<&'a ByteRange>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, TransmuxError>> + Send + 'a>> {
        let receiver = invoke_local(
            self.id,
            vec![
                JsValue::from_str(&location_key(location)),
                range
                    .map(|r| JsValue::from_f64(r.offset as f64))
                    .unwrap_or(JsValue::UNDEFINED),
                range
                    .map(|r| JsValue::from_f64(r.length as f64))
                    .unwrap_or(JsValue::UNDEFINED),
            ],
        );
        Box::pin(async move {
            match receiver
                .await
                .map_err(|_| TransmuxError::invalid("resource bridge closed"))?
                .map_err(TransmuxError::invalid)?
            {
                JsValueResult::Bytes(bytes) => Ok(bytes),
                _ => Err(TransmuxError::invalid("resource bridge returned no bytes")),
            }
        })
    }
}

struct DemandWriter {
    id: u32,
    pending: Option<(
        usize,
        tokio::sync::oneshot::Receiver<Result<JsValueResult, String>>,
    )>,
}
impl AsyncWrite for DemandWriter {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        if self.pending.is_none() {
            self.pending = Some((
                data.len(),
                invoke_local(self.id, vec![Uint8Array::from(data).into()]),
            ));
        }
        let (len, receiver) = self.pending.as_mut().unwrap();
        let len = *len;
        match Pin::new(receiver).poll(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(result) => {
                self.pending = None;
                Poll::Ready(match result {
                    Ok(Ok(_)) => Ok(len),
                    Ok(Err(error)) => Err(std::io::Error::other(error)),
                    Err(_) => Err(std::io::Error::other("writer bridge closed")),
                })
            }
        }
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
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

#[wasm_bindgen]
pub async fn transmux_demand_to_fmp4(
    playlist_url: String,
    playlist: String,
    read: Function,
    write: Function,
) -> Result<JsValue, JsValue> {
    let read = CallbackRegistration::new(read);
    let write = CallbackRegistration::new(write);
    let location = SourceLocation::Url(
        url::Url::parse(&playlist_url).map_err(|e| JsValue::from_str(&e.to_string()))?,
    );
    let source = DemandSource {
        id: read.0,
        playlist_url,
        playlist,
    };
    let mut writer = DemandWriter {
        id: write.0,
        pending: None,
    };
    let report = transmux_hls_to_writer_async(
        HlsInput::custom(Arc::new(source), location),
        &mut writer,
        TransmuxOptions {
            output_format: OutputFormat::FragmentedMp4,
            write_mfra: false,
            ..Default::default()
        },
    )
    .await
    .map_err(|e| JsValue::from_str(&e.to_string()))?;
    report_to_js(None, &report)
}
