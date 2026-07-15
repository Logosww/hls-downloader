use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use hls_transmux::{
    HlsInput, MemorySource, OutputFormat, SourceLocation, TransmuxOptions, TransmuxReport,
    transmux_hls_to_mp4_bytes, transmux_hls_to_writer_async,
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

fn parse_resource_map(resources: &JsValue) -> Result<(MemorySource, String), JsValue> {
    let obj = resources
        .dyn_ref::<Object>()
        .ok_or_else(|| JsValue::from_str("resources must be an object"))?;
    let playlist_url = Reflect::get(obj, &JsValue::from_str("playlistUrl"))?
        .as_string()
        .ok_or_else(|| JsValue::from_str("playlistUrl must be a string"))?;
    let texts_value = Reflect::get(obj, &JsValue::from_str("texts"))?;
    let bytes_value = Reflect::get(obj, &JsValue::from_str("bytes"))?;
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

    Ok((MemorySource::with_data(texts, bytes), playlist_url))
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
