use iii_sdk::{III, RegisterFunction};
use iii_sdk::error::IIIError;
use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};




fn canonicalize(manifest: &Value) -> String {
    canonical_json(manifest)
}

fn canonical_json(val: &Value) -> String {
    match val {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => serde_json::to_string(s).unwrap_or_default(),
        Value::Array(arr) => {
            let items: Vec<String> = arr.iter().map(canonical_json).collect();
            format!("[{}]", items.join(","))
        }
        Value::Object(obj) => {
            let mut keys: Vec<&String> = obj.keys().collect();
            keys.sort();
            let pairs: Vec<String> = keys
                .iter()
                .map(|k| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(*k).unwrap_or_default(),
                        canonical_json(&obj[*k])
                    )
                })
                .collect();
            format!("{{{}}}", pairs.join(","))
        }
    }
}

fn hash_manifest(manifest: &Value) -> Vec<u8> {
    let canonical = canonicalize(manifest);
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    hasher.finalize().to_vec()
}

fn sign_manifest(manifest: &Value, private_key_hex: &str) -> Result<String, IIIError> {
    let key_bytes = hex::decode(private_key_hex)
        .map_err(|e| IIIError::Handler(e.to_string()))?;
    let key_array: [u8; 32] = key_bytes
        .try_into()
        .map_err(|_| IIIError::Handler("Private key must be 32 bytes".into()))?;
    let signing_key = SigningKey::from_bytes(&key_array);

    let digest = hash_manifest(manifest);
    let signature = signing_key.sign(&digest);
    Ok(hex::encode(signature.to_bytes()))
}

fn verify_manifest(manifest: &Value, signature_hex: &str, public_key_hex: &str) -> Result<bool, IIIError> {
    let pub_bytes = hex::decode(public_key_hex)
        .map_err(|e| IIIError::Handler(e.to_string()))?;
    let pub_array: [u8; 32] = pub_bytes
        .try_into()
        .map_err(|_| IIIError::Handler("Public key must be 32 bytes".into()))?;
    let verifying_key = VerifyingKey::from_bytes(&pub_array)
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let sig_bytes = hex::decode(signature_hex)
        .map_err(|e| IIIError::Handler(e.to_string()))?;
    let sig_array: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| IIIError::Handler("Signature must be 64 bytes".into()))?;
    let signature = ed25519_dalek::Signature::from_bytes(&sig_array);

    let digest = hash_manifest(manifest);
    Ok(verifying_key.verify(&digest, &signature).is_ok())
}

pub fn register(iii: &III) {
    iii.register_function(
        RegisterFunction::new_async("security::sign_manifest", move |input: Value| async move {
            let manifest = input.get("manifest").cloned().unwrap_or(json!({}));
            let private_key = input["privateKey"]
                .as_str()
                .ok_or_else(|| IIIError::Handler("privateKey is required".into()))?;

            let signature = sign_manifest(&manifest, private_key)?;
            let digest = hex::encode(hash_manifest(&manifest));

            Ok::<Value, IIIError>(json!({
                "signature": signature,
                "digest": digest,
            }))
        })
        .description("Sign a manifest with Ed25519"),
    );

    iii.register_function(
        RegisterFunction::new_async("security::verify_manifest", move |input: Value| async move {
            let manifest = input.get("manifest").cloned().unwrap_or(json!({}));
            let signature = input["signature"]
                .as_str()
                .ok_or_else(|| IIIError::Handler("signature is required".into()))?;
            let public_key = input["publicKey"]
                .as_str()
                .ok_or_else(|| IIIError::Handler("publicKey is required".into()))?;

            let valid = verify_manifest(&manifest, signature, public_key)?;
            let digest = hex::encode(hash_manifest(&manifest));

            Ok::<Value, IIIError>(json!({
                "valid": valid,
                "digest": digest,
            }))
        })
        .description("Verify a manifest signature with Ed25519"),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_keypair() -> (String, String) {
        let signing_key = SigningKey::from_bytes(&[
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
            17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
        ]);
        let verifying_key = signing_key.verifying_key();
        (
            hex::encode(signing_key.to_bytes()),
            hex::encode(verifying_key.to_bytes()),
        )
    }

    #[test]
    fn test_canonical_json_null() {
        assert_eq!(canonical_json(&Value::Null), "null");
    }

    #[test]
    fn test_canonical_json_bool_true() {
        assert_eq!(canonical_json(&json!(true)), "true");
    }

    #[test]
    fn test_canonical_json_bool_false() {
        assert_eq!(canonical_json(&json!(false)), "false");
    }

    #[test]
    fn test_canonical_json_number() {
        assert_eq!(canonical_json(&json!(42)), "42");
    }

    #[test]
    fn test_canonical_json_string() {
        assert_eq!(canonical_json(&json!("hello")), "\"hello\"");
    }

    #[test]
    fn test_canonical_json_array() {
        let val = json!([1, "two", true]);
        assert_eq!(canonical_json(&val), "[1,\"two\",true]");
    }

    #[test]
    fn test_canonical_json_object_keys_sorted() {
        let val = json!({"z": 1, "a": 2, "m": 3});
        let result = canonical_json(&val);
        assert_eq!(result, "{\"a\":2,\"m\":3,\"z\":1}");
    }

    #[test]
    fn test_canonical_json_nested_object_sorted() {
        let val = json!({"b": {"d": 1, "c": 2}, "a": 0});
        let result = canonical_json(&val);
        assert_eq!(result, "{\"a\":0,\"b\":{\"c\":2,\"d\":1}}");
    }

    #[test]
    fn test_canonical_json_empty_object() {
        assert_eq!(canonical_json(&json!({})), "{}");
    }

    #[test]
    fn test_canonical_json_empty_array() {
        assert_eq!(canonical_json(&json!([])), "[]");
    }

    #[test]
    fn test_canonicalize_delegates_to_canonical_json() {
        let val = json!({"key": "value"});
        assert_eq!(canonicalize(&val), canonical_json(&val));
    }

    #[test]
    fn test_hash_manifest_deterministic() {
        let manifest = json!({"name": "test", "version": "1.0"});
        let h1 = hash_manifest(&manifest);
        let h2 = hash_manifest(&manifest);
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_hash_manifest_different_for_different_content() {
        let m1 = json!({"name": "test1"});
        let m2 = json!({"name": "test2"});
        assert_ne!(hash_manifest(&m1), hash_manifest(&m2));
    }

    #[test]
    fn test_hash_manifest_same_regardless_of_key_order() {
        let m1 = json!({"a": 1, "b": 2});
        let m2 = json!({"b": 2, "a": 1});
        assert_eq!(hash_manifest(&m1), hash_manifest(&m2));
    }

    #[test]
    fn test_hash_manifest_is_32_bytes() {
        let manifest = json!({"test": true});
        let h = hash_manifest(&manifest);
        assert_eq!(h.len(), 32);
    }

    #[test]
    fn test_sign_verify_roundtrip() {
        let (private_key, public_key) = test_keypair();
        let manifest = json!({"name": "my-tool", "version": "1.0.0"});

        let signature = sign_manifest(&manifest, &private_key).unwrap();
        let valid = verify_manifest(&manifest, &signature, &public_key).unwrap();
        assert!(valid);
    }

    #[test]
    fn test_verify_fails_on_tampered_data() {
        let (private_key, public_key) = test_keypair();
        let manifest = json!({"name": "my-tool", "version": "1.0.0"});

        let signature = sign_manifest(&manifest, &private_key).unwrap();

        let tampered = json!({"name": "my-tool", "version": "2.0.0"});
        let valid = verify_manifest(&tampered, &signature, &public_key).unwrap();
        assert!(!valid);
    }

    #[test]
    fn test_verify_fails_with_wrong_key() {
        let (private_key, _) = test_keypair();
        let manifest = json!({"data": "test"});
        let signature = sign_manifest(&manifest, &private_key).unwrap();

        let other_key = SigningKey::from_bytes(&[
            32, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17,
            16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1,
        ]);
        let other_pub = hex::encode(other_key.verifying_key().to_bytes());

        let valid = verify_manifest(&manifest, &signature, &other_pub).unwrap();
        assert!(!valid);
    }

    #[test]
    fn test_sign_manifest_invalid_private_key_hex() {
        let manifest = json!({"test": true});
        let result = sign_manifest(&manifest, "not-hex");
        assert!(result.is_err());
    }

    #[test]
    fn test_sign_manifest_wrong_key_length() {
        let manifest = json!({"test": true});
        let result = sign_manifest(&manifest, "aabbccdd");
        assert!(result.is_err());
    }

    #[test]
    fn test_verify_manifest_invalid_signature_hex() {
        let (_, public_key) = test_keypair();
        let manifest = json!({"test": true});
        let result = verify_manifest(&manifest, "not-hex", &public_key);
        assert!(result.is_err());
    }

    #[test]
    fn test_verify_manifest_invalid_public_key_hex() {
        let manifest = json!({"test": true});
        let result = verify_manifest(&manifest, &"aa".repeat(64), "not-hex");
        assert!(result.is_err());
    }

    #[test]
    fn test_verify_manifest_wrong_signature_length() {
        let (_, public_key) = test_keypair();
        let manifest = json!({"test": true});
        let result = verify_manifest(&manifest, "aabb", &public_key);
        assert!(result.is_err());
    }

    #[test]
    fn test_verify_manifest_wrong_public_key_length() {
        let manifest = json!({"test": true});
        let result = verify_manifest(&manifest, &"aa".repeat(64), "aabb");
        assert!(result.is_err());
    }

    #[test]
    fn test_sign_empty_manifest() {
        let (private_key, public_key) = test_keypair();
        let manifest = json!({});
        let sig = sign_manifest(&manifest, &private_key).unwrap();
        assert!(verify_manifest(&manifest, &sig, &public_key).unwrap());
    }

    #[test]
    fn test_signature_is_128_hex_chars() {
        let (private_key, _) = test_keypair();
        let manifest = json!({"key": "value"});
        let sig = sign_manifest(&manifest, &private_key).unwrap();
        assert_eq!(sig.len(), 128);
    }

    #[test]
    fn test_sign_verify_complex_nested_manifest() {
        let (private_key, public_key) = test_keypair();
        let manifest = json!({
            "name": "complex-tool",
            "version": "2.0.0",
            "config": {
                "nested": {
                    "deep": {
                        "value": 42,
                        "list": [1, 2, 3, "four"],
                        "flag": true,
                        "nothing": null
                    }
                }
            },
            "tags": ["security", "signing", "test"]
        });
        let sig = sign_manifest(&manifest, &private_key).unwrap();
        assert!(verify_manifest(&manifest, &sig, &public_key).unwrap());
    }

    #[test]
    fn test_sign_verify_with_array_manifest() {
        let (private_key, public_key) = test_keypair();
        let manifest = json!([1, "two", true, null, [3, 4], {"key": "val"}]);
        let sig = sign_manifest(&manifest, &private_key).unwrap();
        assert!(verify_manifest(&manifest, &sig, &public_key).unwrap());
    }

    #[test]
    fn test_sign_verify_with_unicode_strings() {
        let (private_key, public_key) = test_keypair();
        let manifest = json!({
            "greeting": "\u{4f60}\u{597d}\u{4e16}\u{754c}",
            "emoji": "\u{1f600}\u{1f680}",
            "accent": "\u{e9}\u{e8}\u{ea}"
        });
        let sig = sign_manifest(&manifest, &private_key).unwrap();
        assert!(verify_manifest(&manifest, &sig, &public_key).unwrap());
    }

    #[test]
    fn test_sign_verify_null_manifest() {
        let (private_key, public_key) = test_keypair();
        let manifest = json!(null);
        let sig = sign_manifest(&manifest, &private_key).unwrap();
        assert!(verify_manifest(&manifest, &sig, &public_key).unwrap());
    }

    #[test]
    fn test_sign_empty_vs_null_manifest_different_signatures() {
        let (private_key, _) = test_keypair();
        let empty = json!({});
        let null = json!(null);
        let sig_empty = sign_manifest(&empty, &private_key).unwrap();
        let sig_null = sign_manifest(&null, &private_key).unwrap();
        assert_ne!(sig_empty, sig_null);
    }

    #[test]
    fn test_multiple_sign_verify_cycles_same_key() {
        let (private_key, public_key) = test_keypair();
        for i in 0..10 {
            let manifest = json!({"iteration": i, "data": format!("test-{}", i)});
            let sig = sign_manifest(&manifest, &private_key).unwrap();
            assert!(verify_manifest(&manifest, &sig, &public_key).unwrap());
        }
    }

    #[test]
    fn test_sign_same_manifest_twice_produces_same_signature() {
        let (private_key, _) = test_keypair();
        let manifest = json!({"deterministic": true});
        let sig1 = sign_manifest(&manifest, &private_key).unwrap();
        let sig2 = sign_manifest(&manifest, &private_key).unwrap();
        assert_eq!(sig1, sig2);
    }

    #[test]
    fn test_canonical_json_special_characters_in_strings() {
        let val = json!({"key": "value with \"quotes\" and \\backslash"});
        let result = canonical_json(&val);
        assert!(result.contains("\\\"quotes\\\""));
        assert!(result.contains("\\\\backslash"));
    }

    #[test]
    fn test_canonical_json_newlines_tabs_in_strings() {
        let val = json!({"text": "line1\nline2\ttab"});
        let result = canonical_json(&val);
        assert!(result.contains("\\n"));
        assert!(result.contains("\\t"));
    }

    #[test]
    fn test_canonical_json_unicode_string() {
        let val = json!({"emoji": "\u{1f600}"});
        let result = canonical_json(&val);
        assert!(result.contains("\u{1f600}") || result.contains("\\u"));
    }

    #[test]
    fn test_canonical_json_number_float() {
        let result = canonical_json(&json!(3.14));
        assert_eq!(result, "3.14");
    }

    #[test]
    fn test_canonical_json_number_negative() {
        let result = canonical_json(&json!(-99));
        assert_eq!(result, "-99");
    }

    #[test]
    fn test_canonical_json_nested_arrays() {
        let val = json!([[1, 2], [3, [4, 5]]]);
        assert_eq!(canonical_json(&val), "[[1,2],[3,[4,5]]]");
    }

    #[test]
    fn test_canonical_json_deeply_nested_objects() {
        let val = json!({"a": {"b": {"c": {"d": 1}}}});
        assert_eq!(canonical_json(&val), "{\"a\":{\"b\":{\"c\":{\"d\":1}}}}");
    }

    #[test]
    fn test_different_keys_produce_different_signatures() {
        let (private_key_1, _) = test_keypair();
        let key_2 = SigningKey::from_bytes(&[
            32, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17,
            16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1,
        ]);
        let private_key_2 = hex::encode(key_2.to_bytes());

        let manifest = json!({"data": "test"});
        let sig1 = sign_manifest(&manifest, &private_key_1).unwrap();
        let sig2 = sign_manifest(&manifest, &private_key_2).unwrap();
        assert_ne!(sig1, sig2);
    }

    #[test]
    fn test_hash_manifest_null() {
        let h1 = hash_manifest(&json!(null));
        let h2 = hash_manifest(&json!(null));
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_hash_manifest_array() {
        let h1 = hash_manifest(&json!([1, 2, 3]));
        let h2 = hash_manifest(&json!([1, 2, 4]));
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_canonical_json_empty_string() {
        assert_eq!(canonical_json(&json!("")), "\"\"");
    }

    #[test]
    fn test_verify_manifest_corrupted_signature_one_byte() {
        let (private_key, public_key) = test_keypair();
        let manifest = json!({"test": "data"});
        let sig = sign_manifest(&manifest, &private_key).unwrap();
        let mut sig_bytes: Vec<u8> = hex::decode(&sig).unwrap();
        sig_bytes[0] ^= 0xFF;
        let corrupted_sig = hex::encode(&sig_bytes);
        let valid = verify_manifest(&manifest, &corrupted_sig, &public_key).unwrap();
        assert!(!valid);
    }
}
