use hls_transmux::*;
use napi::bindgen_prelude::{Buffer, Promise};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use serde_json::json;
use std::{collections::HashMap, future::Future, pin::Pin, sync::Arc};
#[path = "../../../../rust/session.rs"]
mod wire;

struct CallbackSource {
    texts: HashMap<String, String>,
    read: ThreadsafeFunction<String, Promise<Buffer>>,
}
impl std::fmt::Debug for CallbackSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CallbackSource")
    }
}
impl Source for CallbackSource {
    fn read_text<'a>(
        &'a self,
        location: &'a SourceLocation,
    ) -> Pin<Box<dyn Future<Output = hls_transmux::Result<TextResource>> + Send + 'a>> {
        Box::pin(async move {
            let key = match location {
                SourceLocation::Url(u) => u.as_str(),
                _ => return Err(Error::invalid("expected URL")),
            };
            Ok(TextResource {
                content: self
                    .texts
                    .get(key)
                    .ok_or_else(|| Error::invalid("unknown playlist"))?
                    .clone(),
                location: location.clone(),
            })
        })
    }
    fn read_bytes<'a>(
        &'a self,
        location: &'a SourceLocation,
        range: Option<&'a ByteRange>,
    ) -> Pin<Box<dyn Future<Output = hls_transmux::Result<Vec<u8>>> + Send + 'a>> {
        Box::pin(async move {
            let request = json!({"url": match location { SourceLocation::Url(u) => u.to_string(), _ => return Err(Error::invalid("expected URL")) },
                "offset": range.map(|r| r.offset), "length": range.map(|r| r.length)}).to_string();
            let promise = self
                .read
                .call_async(Ok(request))
                .await
                .map_err(|_| Error::Http("resource callback failed".into()))?;
            Ok(promise
                .await
                .map_err(|_| Error::Http("resource callback failed".into()))?
                .to_vec())
        })
    }
}

#[napi]
pub async fn prepared_native(
    request: String,
    cancel_job_id: String,
    read: ThreadsafeFunction<String, Promise<Buffer>>,
    write: ThreadsafeFunction<Buffer, Promise<()>>,
    progress: ThreadsafeFunction<String>,
) -> napi::Result<String> {
    let request: wire::Request =
        serde_json::from_str(&request).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let cancel = super::registry()
        .get(&cancel_job_id)
        .map(|e| Arc::clone(&e))
        .ok_or_else(|| napi::Error::from_reason("missing cancellation token"))?;
    let mut texts = HashMap::new();
    texts.insert(request.primary.url.clone(), request.primary.text);
    if let Some(a) = &request.audio {
        texts.insert(a.url.clone(), a.text.clone());
    }
    let source = Arc::new(CallbackSource { texts, read });
    let input = |url: &str| -> napi::Result<HlsInput> {
        Ok(HlsInput::custom(
            source.clone(),
            SourceLocation::Url(
                url::Url::parse(url).map_err(|e| napi::Error::from_reason(e.to_string()))?,
            ),
        ))
    };
    let legacy = request.audio.is_none() && request.mode != "probe";
    let progress = Arc::new(progress);
    let callback = progress.clone();
    let legacy_options = TransmuxOptions {
        cancel: Some(cancel.clone()),
        write_mfra: false,
        output_format: if request.mode == "file" {
            OutputFormat::StreamingMp4
        } else {
            OutputFormat::FragmentedMp4
        },
        on_progress: Some(Arc::new(move |event| {
            callback.call(Ok(json!({"phase":"processing", "completed":event.completed_segments, "total":event.total_segments}).to_string()), ThreadsafeFunctionCallMode::NonBlocking);
        })),
        ..Default::default()
    };
    let prepared = if legacy {
        None
    } else {
        let mut inputs = HlsInputs::new(input(&request.primary.url)?);
        if let Some(a) = request.audio {
            inputs = inputs.with_audio(input(&a.url)?);
        }
        let options = PrepareOptions::default()
            .with_cancel(cancel.clone())
            .with_write_mfra(false)
            .with_budget(ResourceBudget::default().with_max_in_flight_reads(request.concurrency))
            .with_on_event(Arc::new(move |event| {
                progress.call(
                    Ok(wire::progress(event)),
                    ThreadsafeFunctionCallMode::NonBlocking,
                );
            }));
        match prepare_hls(inputs, options).await {
            Ok(p) => Some(p),
            Err(e) => return Ok(wire::failure(e).to_string()),
        }
    };
    let mapping = prepared
        .as_ref()
        .map(|p| wire::timeline(p.info().timeline()));
    let legacy_error = |e: Error| json!({"error":{"code": if matches!(e, Error::Cancelled) {"ABORTED"} else {"TRANSMUX_FAILED"}}});
    if request.mode == "probe" {
        return Ok(json!({"timeline": mapping, "totalSegments": 0}).to_string());
    }
    let result = if request.mode == "file" {
        let path = request
            .output
            .ok_or_else(|| napi::Error::from_reason("missing output"))?;
        if let Some(prepared) = prepared {
            prepared
                .write_to_file(path, FileOutputOptions::default())
                .await
                .map(|r| r.media().segment_count)
                .map_err(wire::failure)
        } else {
            transmux_hls_to_mp4_async(input(&request.primary.url)?, path, legacy_options)
                .await
                .map(|r| r.segment_count)
                .map_err(legacy_error)
        }
    } else {
        let (mut tx, mut rx) = tokio::io::duplex(256 * 1024);
        let token = cancel.clone();
        let pump = async move {
            use tokio::io::AsyncReadExt;
            let run = async {
                let mut bytes = vec![0; 64 * 1024];
                loop {
                    let n = rx.read(&mut bytes).await.map_err(|e| e.to_string())?;
                    if n == 0 {
                        break;
                    }
                    write
                        .call_async(Ok(Buffer::from(bytes[..n].to_vec())))
                        .await
                        .map_err(|e| e.to_string())?
                        .await
                        .map_err(|e| e.to_string())?;
                }
                Ok::<(), String>(())
            };
            tokio::select! { biased; _ = token.wait_cancelled() => Err("cancelled".into()), result = run => { if result.is_err() { token.cancel(); } result } }
        };
        let primary = input(&request.primary.url)?;
        let producer = async {
            let result = if let Some(prepared) = prepared {
                prepared
                    .write_to(&mut tx)
                    .await
                    .map(|r| r.media().segment_count)
                    .map_err(wire::failure)
            } else {
                transmux_hls_to_writer_async(primary, &mut tx, legacy_options)
                    .await
                    .map(|r| r.segment_count)
                    .map_err(legacy_error)
            };
            if result.is_err() {
                cancel.cancel();
            }
            drop(tx);
            result
        };
        let (result, pumped) = tokio::join!(producer, pump);
        if let Err(e) = pumped {
            if result.is_ok() {
                return Err(napi::Error::from_reason(e));
            }
        }
        result
    };
    Ok(match result {
        Ok(report) => json!({"timeline": mapping, "totalSegments": report}),
        Err(e) => e,
    }
    .to_string())
}
