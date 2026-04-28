use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use iii_sdk::error::IIIError;
use iii_sdk::{III, InitOptions, RegisterFunction, RegisterTriggerInput, TriggerRequest, register_worker};
use rand::RngCore;
use scrypt::{Params, scrypt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const DEFAULT_AUTO_LOCK_MS: u64 = 30 * 60 * 1000;
const MIN_PASSWORD_LEN: usize = 8;
const SALT_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultEntry {
    key: String,
    iv: String,
    ciphertext: String,
    tag: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultMeta {
    salt: String,
    created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    rotated_at: Option<i64>,
}

#[derive(Default)]
struct VaultState {
    crypto_key: Option<Vec<u8>>,
    salt_b64: Option<String>,
    auto_lock_ms: u64,
    last_activity: Option<Instant>,
}

impl VaultState {
    fn unlocked(&self) -> bool {
        self.crypto_key.is_some()
    }

    fn check_auto_lock(&mut self) {
        if let (Some(last), key) = (self.last_activity, self.crypto_key.as_ref()) {
            if key.is_some() && last.elapsed() >= Duration::from_millis(self.auto_lock_ms) {
                self.crypto_key = None;
                self.last_activity = None;
            }
        }
    }

    fn touch(&mut self) {
        self.last_activity = Some(Instant::now());
    }

    #[allow(dead_code)]
    fn lock(&mut self) {
        self.crypto_key = None;
        self.last_activity = None;
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn random_bytes(len: usize) -> Vec<u8> {
    let mut buf = vec![0u8; len];
    rand::thread_rng().fill_bytes(&mut buf);
    buf
}

fn derive_key(password: &str, salt: &[u8]) -> Result<Vec<u8>, IIIError> {
    let params = Params::new(15, 8, 1, 32)
        .map_err(|e| IIIError::Handler(format!("scrypt params: {e}")))?;
    let mut out = vec![0u8; 32];
    scrypt(password.as_bytes(), salt, &params, &mut out)
        .map_err(|e| IIIError::Handler(format!("scrypt: {e}")))?;
    Ok(out)
}

fn encrypt(key: &[u8], plaintext: &str) -> Result<(String, String, String), IIIError> {
    let cipher_key = Key::<Aes256Gcm>::from_slice(key);
    let cipher = Aes256Gcm::new(cipher_key);
    let nonce_bytes = random_bytes(NONCE_LEN);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let combined = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext.as_bytes(),
                aad: &[],
            },
        )
        .map_err(|e| IIIError::Handler(format!("encrypt failed: {e}")))?;

    if combined.len() < TAG_LEN {
        return Err(IIIError::Handler("encrypted output too short".into()));
    }
    let split = combined.len() - TAG_LEN;
    let ciphertext = &combined[..split];
    let tag = &combined[split..];

    Ok((
        B64.encode(&nonce_bytes),
        B64.encode(ciphertext),
        B64.encode(tag),
    ))
}

fn decrypt(key: &[u8], iv_b64: &str, ciphertext_b64: &str, tag_b64: &str) -> Result<String, IIIError> {
    let cipher_key = Key::<Aes256Gcm>::from_slice(key);
    let cipher = Aes256Gcm::new(cipher_key);

    let iv = B64.decode(iv_b64).map_err(|e| IIIError::Handler(format!("iv decode: {e}")))?;
    let ciphertext = B64
        .decode(ciphertext_b64)
        .map_err(|e| IIIError::Handler(format!("ciphertext decode: {e}")))?;
    let tag = B64.decode(tag_b64).map_err(|e| IIIError::Handler(format!("tag decode: {e}")))?;

    if iv.len() != NONCE_LEN {
        return Err(IIIError::Handler("invalid iv length".into()));
    }
    if tag.len() != TAG_LEN {
        return Err(IIIError::Handler("invalid tag length".into()));
    }

    let mut combined = Vec::with_capacity(ciphertext.len() + tag.len());
    combined.extend_from_slice(&ciphertext);
    combined.extend_from_slice(&tag);

    let nonce = Nonce::from_slice(&iv);
    let plaintext = cipher
        .decrypt(
            nonce,
            Payload {
                msg: &combined,
                aad: &[],
            },
        )
        .map_err(|e| IIIError::Handler(format!("decrypt failed: {e}")))?;

    String::from_utf8(plaintext).map_err(|e| IIIError::Handler(format!("utf8: {e}")))
}

fn require_auth(input: &Value) -> Result<(), IIIError> {
    let expected = std::env::var("AGENTOS_API_KEY")
        .map_err(|_| IIIError::Handler("AGENTOS_API_KEY not configured".into()))?;
    let header = input
        .get("headers")
        .and_then(|h| h.get("authorization"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let token = header.strip_prefix("Bearer ").unwrap_or(header);
    if token == expected && !token.is_empty() {
        Ok(())
    } else {
        Err(IIIError::Handler("Unauthorized".into()))
    }
}

fn body_or_self(input: &Value) -> Value {
    input.get("body").cloned().unwrap_or_else(|| input.clone())
}

async fn state_get(iii: &III, scope: &str, key: &str) -> Option<Value> {
    iii.trigger(TriggerRequest {
        function_id: "state::get".to_string(),
        payload: json!({ "scope": scope, "key": key }),
        action: None,
        timeout_ms: None,
    })
    .await
    .ok()
}

async fn state_set(iii: &III, scope: &str, key: &str, value: Value) -> Result<(), IIIError> {
    iii.trigger(TriggerRequest {
        function_id: "state::set".to_string(),
        payload: json!({ "scope": scope, "key": key, "value": value }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;
    Ok(())
}

async fn state_delete(iii: &III, scope: &str, key: &str) -> Result<(), IIIError> {
    iii.trigger(TriggerRequest {
        function_id: "state::delete".to_string(),
        payload: json!({ "scope": scope, "key": key }),
        action: None,
        timeout_ms: None,
    })
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;
    Ok(())
}

async fn state_list(iii: &III, scope: &str) -> Vec<Value> {
    iii.trigger(TriggerRequest {
        function_id: "state::list".to_string(),
        payload: json!({ "scope": scope }),
        action: None,
        timeout_ms: None,
    })
    .await
    .ok()
    .and_then(|v| v.as_array().cloned())
    .unwrap_or_default()
}

fn audit_void(iii: &III, audit_type: &str, detail: Value) {
    let payload = json!({ "type": audit_type, "detail": detail });
    let iii = iii.clone();
    tokio::spawn(async move {
        let _ = iii
            .trigger(TriggerRequest {
                function_id: "security::audit".to_string(),
                payload,
                action: None,
                timeout_ms: None,
            })
            .await;
    });
}

type SharedState = Arc<Mutex<VaultState>>;

async fn vault_init(state: SharedState, iii: &III, input: Value) -> Result<Value, IIIError> {
    require_auth(&input)?;
    let body = body_or_self(&input);
    let password = body.get("password").and_then(|v| v.as_str()).unwrap_or("");
    if password.len() < MIN_PASSWORD_LEN {
        return Err(IIIError::Handler(format!(
            "Password must be at least {} characters",
            MIN_PASSWORD_LEN
        )));
    }

    let mut st = state.lock().await;

    if let Some(mins) = body.get("autoLockMinutes").and_then(|v| v.as_u64()) {
        st.auto_lock_ms = mins * 60_000;
    } else if st.auto_lock_ms == 0 {
        st.auto_lock_ms = DEFAULT_AUTO_LOCK_MS;
    }

    let existing = state_get(iii, "vault", "__meta").await;
    let salt: Vec<u8> = if let Some(meta) = existing.as_ref().and_then(|v| v.get("salt")).and_then(|v| v.as_str()) {
        B64.decode(meta).map_err(|e| IIIError::Handler(format!("salt decode: {e}")))?
    } else {
        let new_salt = random_bytes(SALT_LEN);
        let meta = VaultMeta {
            salt: B64.encode(&new_salt),
            created_at: now_ms(),
            rotated_at: None,
        };
        state_set(
            iii,
            "vault",
            "__meta",
            serde_json::to_value(&meta).map_err(|e| IIIError::Handler(e.to_string()))?,
        )
        .await?;
        new_salt
    };

    let key = derive_key(password, &salt)?;
    st.crypto_key = Some(key);
    st.salt_b64 = Some(B64.encode(&salt));
    st.touch();

    audit_void(
        iii,
        "vault_unlocked",
        json!({ "autoLockMs": st.auto_lock_ms }),
    );

    Ok(json!({
        "unlocked": true,
        "autoLockMinutes": st.auto_lock_ms / 60_000,
    }))
}

async fn vault_set(state: SharedState, iii: &III, input: Value) -> Result<Value, IIIError> {
    require_auth(&input)?;
    let body = body_or_self(&input);
    let key = body.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let value = body
        .get("value")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let mut st = state.lock().await;
    st.check_auto_lock();
    let crypto_key = st
        .crypto_key
        .clone()
        .ok_or_else(|| IIIError::Handler("Vault is locked. Call vault::init first.".into()))?;

    if key.is_empty() || key.starts_with("__") {
        return Err(IIIError::Handler("Invalid key".into()));
    }

    st.touch();
    drop(st);

    let (iv, ciphertext, tag) = encrypt(&crypto_key, &value)?;
    let now = now_ms();

    let existing = state_get(iii, "vault", &key).await;
    let created_at = existing
        .as_ref()
        .and_then(|v| v.get("createdAt"))
        .and_then(|v| v.as_i64())
        .unwrap_or(now);

    let entry = VaultEntry {
        key: key.clone(),
        iv,
        ciphertext,
        tag,
        created_at,
        updated_at: now,
    };

    let value = serde_json::to_value(&entry).map_err(|e| IIIError::Handler(e.to_string()))?;
    state_set(iii, "vault", &key, value).await?;

    audit_void(iii, "vault_set", json!({ "key": &key }));

    Ok(json!({
        "stored": true,
        "key": key,
        "updatedAt": now,
    }))
}

async fn vault_get(state: SharedState, iii: &III, input: Value) -> Result<Value, IIIError> {
    if input.get("headers").is_some() {
        require_auth(&input)?;
    }
    let body = body_or_self(&input);
    let key = body.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let mut st = state.lock().await;
    st.check_auto_lock();
    let crypto_key = st
        .crypto_key
        .clone()
        .ok_or_else(|| IIIError::Handler("Vault is locked. Call vault::init first.".into()))?;
    st.touch();
    drop(st);

    let entry = state_get(iii, "vault", &key)
        .await
        .filter(|v| v.get("ciphertext").and_then(|c| c.as_str()).is_some_and(|s| !s.is_empty()))
        .ok_or_else(|| IIIError::Handler(format!("Credential not found: {key}")))?;

    let iv = entry.get("iv").and_then(|v| v.as_str()).unwrap_or("");
    let ciphertext = entry.get("ciphertext").and_then(|v| v.as_str()).unwrap_or("");
    let tag = entry.get("tag").and_then(|v| v.as_str()).unwrap_or("");
    let plaintext = decrypt(&crypto_key, iv, ciphertext, tag)?;

    audit_void(iii, "vault_get", json!({ "key": &key }));

    Ok(json!({
        "key": key,
        "value": plaintext,
        "createdAt": entry.get("createdAt"),
        "updatedAt": entry.get("updatedAt"),
    }))
}

async fn vault_list(state: SharedState, iii: &III, input: Value) -> Result<Value, IIIError> {
    if input.get("headers").is_some() {
        require_auth(&input)?;
    }
    let mut st = state.lock().await;
    st.check_auto_lock();
    if !st.unlocked() {
        return Err(IIIError::Handler("Vault is locked. Call vault::init first.".into()));
    }
    st.touch();
    drop(st);

    let entries = state_list(iii, "vault").await;

    let keys: Vec<Value> = entries
        .into_iter()
        .filter(|e| {
            e.get("key").and_then(|v| v.as_str()) != Some("__meta")
                && e.get("value")
                    .and_then(|v| v.get("ciphertext"))
                    .and_then(|v| v.as_str())
                    .is_some_and(|s| !s.is_empty())
        })
        .filter_map(|e| {
            let key = e.get("key").and_then(|v| v.as_str())?.to_string();
            let v = e.get("value")?;
            Some(json!({
                "key": key,
                "createdAt": v.get("createdAt"),
                "updatedAt": v.get("updatedAt"),
            }))
        })
        .collect();

    let count = keys.len();
    Ok(json!({
        "keys": keys,
        "count": count,
    }))
}

async fn vault_delete(state: SharedState, iii: &III, input: Value) -> Result<Value, IIIError> {
    require_auth(&input)?;
    let body = body_or_self(&input);
    let key = body.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string();

    let mut st = state.lock().await;
    st.check_auto_lock();
    if !st.unlocked() {
        return Err(IIIError::Handler("Vault is locked. Call vault::init first.".into()));
    }
    st.touch();
    drop(st);

    if key == "__meta" {
        return Err(IIIError::Handler("Cannot delete vault metadata".into()));
    }

    state_delete(iii, "vault", &key).await?;
    audit_void(iii, "vault_delete", json!({ "key": &key }));

    Ok(json!({
        "deleted": true,
        "key": key,
    }))
}

async fn vault_rotate(state: SharedState, iii: &III, input: Value) -> Result<Value, IIIError> {
    require_auth(&input)?;
    let body = body_or_self(&input);
    let current_password = body
        .get("currentPassword")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let new_password = body
        .get("newPassword")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let mut st = state.lock().await;
    st.check_auto_lock();
    if !st.unlocked() {
        return Err(IIIError::Handler("Vault is locked. Call vault::init first.".into()));
    }
    if new_password.len() < MIN_PASSWORD_LEN {
        return Err(IIIError::Handler(format!(
            "New password must be at least {} characters",
            MIN_PASSWORD_LEN
        )));
    }
    drop(st);

    let meta = state_get(iii, "vault", "__meta")
        .await
        .ok_or_else(|| IIIError::Handler("vault metadata missing".into()))?;
    let old_salt_b64 = meta
        .get("salt")
        .and_then(|v| v.as_str())
        .ok_or_else(|| IIIError::Handler("vault salt missing".into()))?;
    let old_salt = B64
        .decode(old_salt_b64)
        .map_err(|e| IIIError::Handler(format!("salt decode: {e}")))?;
    let old_key = derive_key(&current_password, &old_salt)?;

    let entries = state_list(iii, "vault").await;
    let credentials: Vec<Value> = entries
        .into_iter()
        .filter(|e| {
            e.get("key").and_then(|v| v.as_str()) != Some("__meta")
                && e.get("value")
                    .and_then(|v| v.get("ciphertext"))
                    .and_then(|v| v.as_str())
                    .is_some_and(|s| !s.is_empty())
        })
        .collect();

    state_set(iii, "vault_backup", "__meta", meta.clone()).await?;
    for entry in &credentials {
        let k = entry.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let v = entry.get("value").cloned().unwrap_or(json!({}));
        state_set(iii, "vault_backup", &k, v).await?;
    }

    let new_salt = random_bytes(SALT_LEN);
    let new_key = derive_key(&new_password, &new_salt)?;

    let mut updates: Vec<(String, Value)> = Vec::new();
    for entry in &credentials {
        let k = entry.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let v = entry.get("value").cloned().unwrap_or(json!({}));

        let iv = v.get("iv").and_then(|v| v.as_str()).unwrap_or("");
        let ct = v.get("ciphertext").and_then(|v| v.as_str()).unwrap_or("");
        let tag = v.get("tag").and_then(|v| v.as_str()).unwrap_or("");
        let plaintext = decrypt(&old_key, iv, ct, tag)?;
        let (new_iv, new_ct, new_tag) = encrypt(&new_key, &plaintext)?;

        let mut new_value = v.clone();
        if let Some(obj) = new_value.as_object_mut() {
            obj.insert("iv".into(), json!(new_iv));
            obj.insert("ciphertext".into(), json!(new_ct));
            obj.insert("tag".into(), json!(new_tag));
            obj.insert("updatedAt".into(), json!(now_ms()));
        }
        updates.push((k, new_value));
    }

    let rotation_result: Result<(), IIIError> = async {
        for (k, v) in &updates {
            state_set(iii, "vault", k, v.clone()).await?;
        }
        let new_meta = json!({
            "salt": B64.encode(&new_salt),
            "createdAt": meta.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(now_ms()),
            "rotatedAt": now_ms(),
        });
        state_set(iii, "vault", "__meta", new_meta).await?;
        Ok(())
    }
    .await;

    if let Err(err) = rotation_result {
        for entry in &credentials {
            let k = entry.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if let Some(backup) = state_get(iii, "vault_backup", &k).await {
                let _ = state_set(iii, "vault", &k, backup).await;
            }
        }
        if let Some(backup_meta) = state_get(iii, "vault_backup", "__meta").await {
            let _ = state_set(iii, "vault", "__meta", backup_meta).await;
        }
        audit_void(
            iii,
            "vault_rotation_failed",
            json!({ "error": err.to_string(), "rolledBack": true }),
        );
        return Err(IIIError::Handler(format!(
            "Vault rotation failed, rolled back: {}",
            err
        )));
    }

    let mut st = state.lock().await;
    st.crypto_key = Some(new_key);
    st.salt_b64 = Some(B64.encode(&new_salt));
    st.touch();

    audit_void(
        iii,
        "vault_rotated",
        json!({ "credentialsRotated": updates.len() }),
    );

    Ok(json!({
        "rotated": updates.len(),
        "success": true,
    }))
}

async fn vault_backup(state: SharedState, iii: &III, input: Value) -> Result<Value, IIIError> {
    require_auth(&input)?;

    let mut st = state.lock().await;
    st.check_auto_lock();
    if !st.unlocked() {
        return Err(IIIError::Handler("Vault is locked. Call vault::init first.".into()));
    }
    st.touch();
    drop(st);

    let meta = state_get(iii, "vault", "__meta")
        .await
        .ok_or_else(|| IIIError::Handler("vault metadata missing".into()))?;

    let entries = state_list(iii, "vault").await;
    let credentials: Vec<Value> = entries
        .into_iter()
        .filter(|e| {
            e.get("key").and_then(|v| v.as_str()) != Some("__meta")
                && e.get("value")
                    .and_then(|v| v.get("ciphertext"))
                    .and_then(|v| v.as_str())
                    .is_some_and(|s| !s.is_empty())
        })
        .collect();

    state_set(iii, "vault_backup", "__meta", meta).await?;
    for entry in &credentials {
        let k = entry.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let v = entry.get("value").cloned().unwrap_or(json!({}));
        state_set(iii, "vault_backup", &k, v).await?;
    }

    audit_void(
        iii,
        "vault_backup_created",
        json!({ "credentialsCount": credentials.len() }),
    );

    Ok(json!({
        "backedUp": credentials.len(),
        "success": true,
    }))
}

async fn vault_restore(state: SharedState, iii: &III, input: Value) -> Result<Value, IIIError> {
    require_auth(&input)?;
    let body = body_or_self(&input);
    let password = body.get("password").and_then(|v| v.as_str()).map(String::from);

    let backup_meta = state_get(iii, "vault_backup", "__meta")
        .await
        .ok_or_else(|| IIIError::Handler("No vault backup found".into()))?;

    let backup_entries = state_list(iii, "vault_backup").await;
    let credentials: Vec<Value> = backup_entries
        .into_iter()
        .filter(|e| {
            e.get("key").and_then(|v| v.as_str()) != Some("__meta")
                && e.get("value")
                    .and_then(|v| v.get("ciphertext"))
                    .and_then(|v| v.as_str())
                    .is_some_and(|s| !s.is_empty())
        })
        .collect();

    state_set(iii, "vault", "__meta", backup_meta.clone()).await?;
    for entry in &credentials {
        let k = entry.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let v = entry.get("value").cloned().unwrap_or(json!({}));
        state_set(iii, "vault", &k, v).await?;
    }

    if let Some(pw) = password {
        if pw.len() < MIN_PASSWORD_LEN {
            return Err(IIIError::Handler(format!(
                "Password must be at least {} characters",
                MIN_PASSWORD_LEN
            )));
        }
        let salt_b64 = backup_meta
            .get("salt")
            .and_then(|v| v.as_str())
            .ok_or_else(|| IIIError::Handler("backup salt missing".into()))?;
        let salt = B64
            .decode(salt_b64)
            .map_err(|e| IIIError::Handler(format!("salt decode: {e}")))?;
        let key = derive_key(&pw, &salt)?;

        let mut st = state.lock().await;
        st.crypto_key = Some(key);
        st.salt_b64 = Some(salt_b64.to_string());
        if st.auto_lock_ms == 0 {
            st.auto_lock_ms = DEFAULT_AUTO_LOCK_MS;
        }
        st.touch();
    }

    audit_void(
        iii,
        "vault_restored",
        json!({ "credentialsCount": credentials.len() }),
    );

    Ok(json!({
        "restored": credentials.len(),
        "success": true,
    }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let ws_url = std::env::var("III_WS_URL").unwrap_or_else(|_| "ws://localhost:49134".to_string());
    let iii = register_worker(&ws_url, InitOptions::default());

    let state: SharedState = Arc::new(Mutex::new(VaultState {
        auto_lock_ms: DEFAULT_AUTO_LOCK_MS,
        ..Default::default()
    }));

    let s = state.clone();
    let i = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("vault::init", move |input: Value| {
            let s = s.clone();
            let i = i.clone();
            async move { vault_init(s, &i, input).await }
        })
        .description("Initialize vault with master password"),
    );

    let s = state.clone();
    let i = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("vault::set", move |input: Value| {
            let s = s.clone();
            let i = i.clone();
            async move { vault_set(s, &i, input).await }
        })
        .description("Store an encrypted credential"),
    );

    let s = state.clone();
    let i = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("vault::get", move |input: Value| {
            let s = s.clone();
            let i = i.clone();
            async move { vault_get(s, &i, input).await }
        })
        .description("Retrieve and decrypt a credential"),
    );

    let s = state.clone();
    let i = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("vault::list", move |input: Value| {
            let s = s.clone();
            let i = i.clone();
            async move { vault_list(s, &i, input).await }
        })
        .description("List stored credential keys without values"),
    );

    let s = state.clone();
    let i = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("vault::delete", move |input: Value| {
            let s = s.clone();
            let i = i.clone();
            async move { vault_delete(s, &i, input).await }
        })
        .description("Remove a credential"),
    );

    let s = state.clone();
    let i = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("vault::rotate", move |input: Value| {
            let s = s.clone();
            let i = i.clone();
            async move { vault_rotate(s, &i, input).await }
        })
        .description("Re-encrypt all credentials with a new master password"),
    );

    let s = state.clone();
    let i = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("vault::backup", move |input: Value| {
            let s = s.clone();
            let i = i.clone();
            async move { vault_backup(s, &i, input).await }
        })
        .description("Backup current vault state"),
    );

    let s = state.clone();
    let i = iii.clone();
    iii.register_function(
        RegisterFunction::new_async("vault::restore", move |input: Value| {
            let s = s.clone();
            let i = i.clone();
            async move { vault_restore(s, &i, input).await }
        })
        .description("Restore vault from backup"),
    );

    for (fn_id, path, method) in [
        ("vault::init", "api/vault/init", "POST"),
        ("vault::set", "api/vault/set", "POST"),
        ("vault::get", "api/vault/get", "POST"),
        ("vault::list", "api/vault/list", "GET"),
        ("vault::delete", "api/vault/delete", "POST"),
        ("vault::rotate", "api/vault/rotate", "POST"),
        ("vault::backup", "api/vault/backup", "POST"),
        ("vault::restore", "api/vault/restore", "POST"),
    ] {
        iii.register_trigger(RegisterTriggerInput {
            trigger_type: "http".to_string(),
            function_id: fn_id.to_string(),
            config: json!({ "api_path": path, "http_method": method }),
            metadata: None,
        })?;
    }

    tracing::info!("vault worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_random_bytes_returns_requested_length() {
        let b = random_bytes(32);
        assert_eq!(b.len(), 32);
    }

    #[test]
    fn test_random_bytes_are_random() {
        let a = random_bytes(32);
        let b = random_bytes(32);
        assert_ne!(a, b);
    }

    #[test]
    fn test_derive_key_deterministic() {
        let salt = vec![0u8; 32];
        let k1 = derive_key("password", &salt).unwrap();
        let k2 = derive_key("password", &salt).unwrap();
        assert_eq!(k1, k2);
        assert_eq!(k1.len(), 32);
    }

    #[test]
    fn test_derive_key_different_password_different_key() {
        let salt = vec![1u8; 32];
        let k1 = derive_key("password1", &salt).unwrap();
        let k2 = derive_key("password2", &salt).unwrap();
        assert_ne!(k1, k2);
    }

    #[test]
    fn test_derive_key_different_salt_different_key() {
        let k1 = derive_key("password", &vec![0u8; 32]).unwrap();
        let k2 = derive_key("password", &vec![1u8; 32]).unwrap();
        assert_ne!(k1, k2);
    }

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let key = derive_key("test-password", &vec![5u8; 32]).unwrap();
        let (iv, ct, tag) = encrypt(&key, "secret-value-123").unwrap();
        let plaintext = decrypt(&key, &iv, &ct, &tag).unwrap();
        assert_eq!(plaintext, "secret-value-123");
    }

    #[test]
    fn test_encrypt_unicode() {
        let key = derive_key("test-password", &vec![5u8; 32]).unwrap();
        let unicode = "emoji: \u{1f600} CJK: \u{4f60}\u{597d} arabic: \u{0645}\u{0631}\u{062d}\u{0628}\u{0627}";
        let (iv, ct, tag) = encrypt(&key, unicode).unwrap();
        let plaintext = decrypt(&key, &iv, &ct, &tag).unwrap();
        assert_eq!(plaintext, unicode);
    }

    #[test]
    fn test_encrypt_special_chars() {
        let key = derive_key("test-password", &vec![5u8; 32]).unwrap();
        let special = "key=val&foo=bar\n\ttab \"quotes\" 'single'";
        let (iv, ct, tag) = encrypt(&key, special).unwrap();
        let plaintext = decrypt(&key, &iv, &ct, &tag).unwrap();
        assert_eq!(plaintext, special);
    }

    #[test]
    fn test_encrypt_empty_string() {
        let key = derive_key("test-password", &vec![5u8; 32]).unwrap();
        let (iv, ct, tag) = encrypt(&key, "").unwrap();
        let plaintext = decrypt(&key, &iv, &ct, &tag).unwrap();
        assert_eq!(plaintext, "");
    }

    #[test]
    fn test_encrypt_long_value() {
        let key = derive_key("test-password", &vec![5u8; 32]).unwrap();
        let big = "x".repeat(100_000);
        let (iv, ct, tag) = encrypt(&key, &big).unwrap();
        let plaintext = decrypt(&key, &iv, &ct, &tag).unwrap();
        assert_eq!(plaintext, big);
    }

    #[test]
    fn test_encrypt_iv_unique() {
        let key = derive_key("test-password", &vec![5u8; 32]).unwrap();
        let (iv1, _, _) = encrypt(&key, "same").unwrap();
        let (iv2, _, _) = encrypt(&key, "same").unwrap();
        assert_ne!(iv1, iv2);
    }

    #[test]
    fn test_decrypt_with_wrong_key_fails() {
        let key1 = derive_key("password1", &vec![5u8; 32]).unwrap();
        let key2 = derive_key("password2", &vec![5u8; 32]).unwrap();
        let (iv, ct, tag) = encrypt(&key1, "secret").unwrap();
        let result = decrypt(&key2, &iv, &ct, &tag);
        assert!(result.is_err());
    }

    #[test]
    fn test_decrypt_tampered_ciphertext_fails() {
        let key = derive_key("test-password", &vec![5u8; 32]).unwrap();
        let (iv, ct, tag) = encrypt(&key, "secret").unwrap();
        let mut tampered = B64.decode(&ct).unwrap();
        if !tampered.is_empty() {
            tampered[0] ^= 0xFF;
        }
        let bad_ct = B64.encode(&tampered);
        let result = decrypt(&key, &iv, &bad_ct, &tag);
        assert!(result.is_err());
    }

    #[test]
    fn test_decrypt_invalid_iv_length_fails() {
        let key = derive_key("test-password", &vec![5u8; 32]).unwrap();
        let bad_iv = B64.encode(&[0u8; 8]);
        let result = decrypt(&key, &bad_iv, "AAAA", "AAAAAAAAAAAAAAAAAAAAAA==");
        assert!(result.is_err());
    }

    #[test]
    fn test_decrypt_invalid_tag_length_fails() {
        let key = derive_key("test-password", &vec![5u8; 32]).unwrap();
        let iv = B64.encode(&[0u8; 12]);
        let bad_tag = B64.encode(&[0u8; 4]);
        let result = decrypt(&key, &iv, "AAAA", &bad_tag);
        assert!(result.is_err());
    }

    #[test]
    fn test_vault_state_default_locked() {
        let st = VaultState::default();
        assert!(!st.unlocked());
    }

    #[test]
    fn test_vault_state_unlocked_when_key_set() {
        let st = VaultState {
            crypto_key: Some(vec![0u8; 32]),
            ..Default::default()
        };
        assert!(st.unlocked());
    }

    #[test]
    fn test_vault_state_lock_clears_key() {
        let mut st = VaultState {
            crypto_key: Some(vec![0u8; 32]),
            last_activity: Some(Instant::now()),
            auto_lock_ms: 1000,
            ..Default::default()
        };
        assert!(st.unlocked());
        st.lock();
        assert!(!st.unlocked());
        assert!(st.last_activity.is_none());
    }

    #[test]
    fn test_vault_state_touch_sets_activity() {
        let mut st = VaultState::default();
        assert!(st.last_activity.is_none());
        st.touch();
        assert!(st.last_activity.is_some());
    }

    #[test]
    fn test_vault_entry_serialization_camel_case() {
        let e = VaultEntry {
            key: "k1".into(),
            iv: "iv".into(),
            ciphertext: "ct".into(),
            tag: "t".into(),
            created_at: 1000,
            updated_at: 2000,
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["key"], "k1");
        assert_eq!(v["createdAt"], 1000);
        assert_eq!(v["updatedAt"], 2000);
    }

    #[test]
    fn test_vault_meta_serialization_camel_case() {
        let m = VaultMeta {
            salt: "s".into(),
            created_at: 100,
            rotated_at: Some(200),
        };
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["salt"], "s");
        assert_eq!(v["createdAt"], 100);
        assert_eq!(v["rotatedAt"], 200);
    }

    #[test]
    fn test_vault_meta_skips_none_rotated_at() {
        let m = VaultMeta {
            salt: "s".into(),
            created_at: 100,
            rotated_at: None,
        };
        let v = serde_json::to_value(&m).unwrap();
        assert!(v.get("rotatedAt").is_none());
    }

    #[test]
    fn test_body_or_self_with_body() {
        let req = json!({ "headers": {}, "body": { "key": "value" } });
        let body = body_or_self(&req);
        assert_eq!(body["key"], "value");
    }

    #[test]
    fn test_body_or_self_without_body() {
        let req = json!({ "key": "value" });
        let body = body_or_self(&req);
        assert_eq!(body["key"], "value");
    }

    #[test]
    fn test_require_auth_missing_env_fails() {
        unsafe { std::env::remove_var("AGENTOS_API_KEY") };
        let req = json!({});
        assert!(require_auth(&req).is_err());
    }

    #[test]
    fn test_require_auth_with_correct_token_passes() {
        unsafe { std::env::set_var("AGENTOS_API_KEY", "test-key-passes") };
        let req = json!({
            "headers": { "authorization": "Bearer test-key-passes" }
        });
        let result = require_auth(&req);
        unsafe { std::env::remove_var("AGENTOS_API_KEY") };
        assert!(result.is_ok());
    }

    #[test]
    fn test_require_auth_with_wrong_token_fails() {
        unsafe { std::env::set_var("AGENTOS_API_KEY", "expected-wrong") };
        let req = json!({
            "headers": { "authorization": "Bearer wrong-token" }
        });
        let result = require_auth(&req);
        unsafe { std::env::remove_var("AGENTOS_API_KEY") };
        assert!(result.is_err());
    }

    #[test]
    fn test_require_auth_missing_header_fails() {
        unsafe { std::env::set_var("AGENTOS_API_KEY", "expected-mh") };
        let req = json!({});
        let result = require_auth(&req);
        unsafe { std::env::remove_var("AGENTOS_API_KEY") };
        assert!(result.is_err());
    }

    #[test]
    fn test_require_auth_empty_token_fails() {
        unsafe { std::env::set_var("AGENTOS_API_KEY", "expected-et") };
        let req = json!({
            "headers": { "authorization": "Bearer " }
        });
        let result = require_auth(&req);
        unsafe { std::env::remove_var("AGENTOS_API_KEY") };
        assert!(result.is_err());
    }

    #[test]
    fn test_now_ms_positive() {
        assert!(now_ms() > 0);
    }

    #[test]
    fn test_constants() {
        assert_eq!(SALT_LEN, 32);
        assert_eq!(NONCE_LEN, 12);
        assert_eq!(TAG_LEN, 16);
        assert_eq!(MIN_PASSWORD_LEN, 8);
        assert_eq!(DEFAULT_AUTO_LOCK_MS, 30 * 60 * 1000);
    }

    #[test]
    fn test_encrypt_outputs_are_base64() {
        let key = derive_key("test-password", &vec![5u8; 32]).unwrap();
        let (iv, ct, tag) = encrypt(&key, "hello").unwrap();
        assert!(B64.decode(&iv).is_ok());
        assert!(B64.decode(&ct).is_ok());
        assert!(B64.decode(&tag).is_ok());
    }

    #[test]
    fn test_encrypt_iv_decodes_to_12_bytes() {
        let key = derive_key("test-password", &vec![5u8; 32]).unwrap();
        let (iv, _, _) = encrypt(&key, "hello").unwrap();
        let decoded = B64.decode(&iv).unwrap();
        assert_eq!(decoded.len(), NONCE_LEN);
    }

    #[test]
    fn test_encrypt_tag_decodes_to_16_bytes() {
        let key = derive_key("test-password", &vec![5u8; 32]).unwrap();
        let (_, _, tag) = encrypt(&key, "hello").unwrap();
        let decoded = B64.decode(&tag).unwrap();
        assert_eq!(decoded.len(), TAG_LEN);
    }
}
