use iii_sdk::iii::III;
use iii_sdk::error::IIIError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::process::Stdio;

#[allow(dead_code)]
mod iii_compat {
    use iii_sdk::{
        III, RegisterFunction, RegisterTriggerInput, TriggerRequest, FunctionRef, Trigger,
        Value,
    };
    use iii_sdk::error::IIIError;
    use std::future::Future;

    pub trait IIIExt {
        fn register_function_with_description<F, Fut>(
            &self,
            id: &str,
            desc: &str,
            f: F,
        ) -> FunctionRef
        where
            F: Fn(Value) -> Fut + Send + Sync + 'static,
            Fut: Future<Output = Result<Value, IIIError>> + Send + 'static;

        fn register_function_v0<F, Fut>(&self, id: &str, f: F) -> FunctionRef
        where
            F: Fn(Value) -> Fut + Send + Sync + 'static,
            Fut: Future<Output = Result<Value, IIIError>> + Send + 'static;

        fn register_trigger_v0(
            &self,
            kind: &str,
            function_id: &str,
            config: Value,
        ) -> Result<Trigger, IIIError>;

        fn trigger_v0(
            &self,
            function_id: &str,
            payload: Value,
        ) -> impl Future<Output = Result<Value, IIIError>> + Send;

        fn trigger_void(
            &self,
            function_id: &str,
            payload: Value,
        ) -> Result<(), IIIError>;
    }

    impl IIIExt for III {
        fn register_function_with_description<F, Fut>(
            &self,
            id: &str,
            desc: &str,
            f: F,
        ) -> FunctionRef
        where
            F: Fn(Value) -> Fut + Send + Sync + 'static,
            Fut: Future<Output = Result<Value, IIIError>> + Send + 'static,
        {
            self.register_function(
                RegisterFunction::new_async(id.to_string(), f).description(desc.to_string()),
            )
        }

        fn register_function_v0<F, Fut>(&self, id: &str, f: F) -> FunctionRef
        where
            F: Fn(Value) -> Fut + Send + Sync + 'static,
            Fut: Future<Output = Result<Value, IIIError>> + Send + 'static,
        {
            self.register_function(RegisterFunction::new_async(id.to_string(), f))
        }

        fn register_trigger_v0(
            &self,
            kind: &str,
            function_id: &str,
            config: Value,
        ) -> Result<Trigger, IIIError> {
            self.register_trigger(RegisterTriggerInput {
                trigger_type: kind.to_string(),
                function_id: function_id.to_string(),
                config,
                metadata: None,
            })
        }

        async fn trigger_v0(
            &self,
            function_id: &str,
            payload: Value,
        ) -> Result<Value, IIIError> {
            self.trigger(TriggerRequest {
                function_id: function_id.to_string(),
                payload,
                action: None,
                timeout_ms: None,
            })
            .await
        }

        fn trigger_void(
            &self,
            function_id: &str,
            payload: Value,
        ) -> Result<(), IIIError> {
            let iii = self.clone();
            let fid = function_id.to_string();
            tokio::spawn(async move {
                let _ = iii
                    .trigger(TriggerRequest {
                        function_id: fid,
                        payload,
                        action: None,
                        timeout_ms: None,
                    })
                    .await;
            });
            Ok(())
        }
    }
}
use iii_compat::IIIExt as _;



#[derive(Debug, Serialize, Deserialize)]
struct DockerExecRequest {
    command: Vec<String>,
    image: Option<String>,
    #[serde(rename = "memoryLimit")]
    memory_limit: Option<String>,
    #[serde(rename = "cpuLimit")]
    cpu_limit: Option<String>,
    #[serde(rename = "networkMode")]
    network_mode: Option<String>,
    #[serde(rename = "workspacePath")]
    workspace_path: Option<String>,
    #[serde(rename = "timeoutSecs")]
    timeout_secs: Option<u64>,
    env: Option<Vec<String>>,
}

const DEFAULT_IMAGE: &str = "ubuntu:22.04";
const DEFAULT_MEMORY_LIMIT: &str = "256m";
const DEFAULT_CPU_LIMIT: &str = "1.0";
const DEFAULT_NETWORK_MODE: &str = "none";
const DEFAULT_TIMEOUT_SECS: u64 = 30;

const ALLOWED_IMAGES: &[&str] = &[
    "agentos-sandbox",
    "node:20-slim",
    "python:3.12-slim",
    "rust:1-slim",
    "ubuntu:22.04",
    "ubuntu:24.04",
];

const BLOCKED_ENV_PREFIXES: &[&str] = &[
    "DOCKER_", "KUBERNETES_", "AWS_", "AZURE_", "GCP_", "HOME=", "PATH=",
];

const BLOCKED_PATHS: &[&str] = &[
    "/etc", "/var", "/root", "/proc", "/sys", "/dev", "/boot", "/bin", "/sbin", "/lib", "/run",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn make_request(overrides: Value) -> DockerExecRequest {
        let mut base = json!({
            "command": ["echo", "hello"],
        });
        if let (Some(base_obj), Some(over_obj)) = (base.as_object_mut(), overrides.as_object()) {
            for (k, v) in over_obj {
                base_obj.insert(k.clone(), v.clone());
            }
        }
        serde_json::from_value(base).unwrap()
    }

    #[test]
    fn test_allowed_images_contains_defaults() {
        assert!(ALLOWED_IMAGES.contains(&"ubuntu:22.04"));
        assert!(ALLOWED_IMAGES.contains(&"python:3.12-slim"));
        assert!(ALLOWED_IMAGES.contains(&"node:20-slim"));
        assert!(ALLOWED_IMAGES.contains(&"rust:1-slim"));
        assert!(ALLOWED_IMAGES.contains(&"agentos-sandbox"));
    }

    #[test]
    fn test_blocked_env_prefixes() {
        assert!(BLOCKED_ENV_PREFIXES.contains(&"DOCKER_"));
        assert!(BLOCKED_ENV_PREFIXES.contains(&"AWS_"));
        assert!(BLOCKED_ENV_PREFIXES.contains(&"KUBERNETES_"));
        assert!(BLOCKED_ENV_PREFIXES.contains(&"HOME="));
        assert!(BLOCKED_ENV_PREFIXES.contains(&"PATH="));
    }

    #[test]
    fn test_blocked_paths() {
        assert!(BLOCKED_PATHS.contains(&"/etc"));
        assert!(BLOCKED_PATHS.contains(&"/var"));
        assert!(BLOCKED_PATHS.contains(&"/root"));
        assert!(BLOCKED_PATHS.contains(&"/proc"));
        assert!(BLOCKED_PATHS.contains(&"/sys"));
    }

    #[test]
    fn test_default_constants() {
        assert_eq!(DEFAULT_IMAGE, "ubuntu:22.04");
        assert_eq!(DEFAULT_MEMORY_LIMIT, "256m");
        assert_eq!(DEFAULT_CPU_LIMIT, "1.0");
        assert_eq!(DEFAULT_NETWORK_MODE, "none");
        assert_eq!(DEFAULT_TIMEOUT_SECS, 30);
    }

    #[test]
    fn test_docker_exec_request_deserialization_minimal() {
        let json_val = json!({"command": ["ls", "-la"]});
        let req: DockerExecRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.command, vec!["ls", "-la"]);
        assert!(req.image.is_none());
        assert!(req.memory_limit.is_none());
        assert!(req.timeout_secs.is_none());
    }

    #[test]
    fn test_docker_exec_request_deserialization_full() {
        let json_val = json!({
            "command": ["python3", "script.py"],
            "image": "python:3.12-slim",
            "memoryLimit": "512m",
            "cpuLimit": "2.0",
            "networkMode": "bridge",
            "workspacePath": "/tmp/work",
            "timeoutSecs": 60,
            "env": ["FOO=bar"],
        });
        let req: DockerExecRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.command, vec!["python3", "script.py"]);
        assert_eq!(req.image, Some("python:3.12-slim".to_string()));
        assert_eq!(req.memory_limit, Some("512m".to_string()));
        assert_eq!(req.cpu_limit, Some("2.0".to_string()));
        assert_eq!(req.network_mode, Some("bridge".to_string()));
        assert_eq!(req.workspace_path, Some("/tmp/work".to_string()));
        assert_eq!(req.timeout_secs, Some(60));
        assert_eq!(req.env, Some(vec!["FOO=bar".to_string()]));
    }

    #[tokio::test]
    async fn test_docker_exec_empty_command() {
        let input = json!({"command": []});
        let result = docker_exec(input).await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("command must not be empty"));
    }

    #[tokio::test]
    async fn test_docker_exec_disallowed_image() {
        let input = json!({
            "command": ["echo", "hi"],
            "image": "malicious-image:latest",
        });
        let result = docker_exec(input).await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Docker image not allowed"));
    }

    #[tokio::test]
    async fn test_docker_exec_workspace_path_traversal() {
        let input = json!({
            "command": ["ls"],
            "workspacePath": "/tmp/../etc",
        });
        let result = docker_exec(input).await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Blocked workspace path"));
    }

    #[tokio::test]
    async fn test_docker_exec_workspace_root() {
        let input = json!({
            "command": ["ls"],
            "workspacePath": "/",
        });
        let result = docker_exec(input).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_docker_exec_workspace_blocked_path_etc() {
        let input = json!({
            "command": ["ls"],
            "workspacePath": "/etc",
        });
        let result = docker_exec(input).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_docker_exec_workspace_blocked_path_subdir() {
        let input = json!({
            "command": ["ls"],
            "workspacePath": "/etc/passwd",
        });
        let result = docker_exec(input).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_docker_exec_workspace_blocked_var() {
        let input = json!({
            "command": ["ls"],
            "workspacePath": "/var/log",
        });
        let result = docker_exec(input).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_docker_exec_blocked_env_docker() {
        let input = json!({
            "command": ["echo"],
            "env": ["DOCKER_HOST=tcp://evil:2375"],
        });
        let result = docker_exec(input).await;
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Blocked env var"));
    }

    #[tokio::test]
    async fn test_docker_exec_blocked_env_aws() {
        let input = json!({
            "command": ["echo"],
            "env": ["AWS_SECRET_ACCESS_KEY=supersecret"],
        });
        let result = docker_exec(input).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_docker_exec_blocked_env_kubernetes() {
        let input = json!({
            "command": ["echo"],
            "env": ["KUBERNETES_SERVICE_HOST=10.0.0.1"],
        });
        let result = docker_exec(input).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_docker_exec_blocked_env_home() {
        let input = json!({
            "command": ["echo"],
            "env": ["HOME=/root"],
        });
        let result = docker_exec(input).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_docker_exec_blocked_env_case_insensitive() {
        let input = json!({
            "command": ["echo"],
            "env": ["docker_host=evil"],
        });
        let result = docker_exec(input).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_docker_exec_invalid_json() {
        let input = json!("not an object");
        let result = docker_exec(input).await;
        assert!(result.is_err());
    }

    #[test]
    fn test_allowed_images_count() {
        assert_eq!(ALLOWED_IMAGES.len(), 6);
    }

    #[test]
    fn test_allowed_images_contains_ubuntu_24() {
        assert!(ALLOWED_IMAGES.contains(&"ubuntu:24.04"));
    }

    #[test]
    fn test_blocked_env_prefixes_count() {
        assert_eq!(BLOCKED_ENV_PREFIXES.len(), 7);
    }

    #[test]
    fn test_blocked_env_prefixes_gcp() {
        assert!(BLOCKED_ENV_PREFIXES.contains(&"GCP_"));
    }

    #[test]
    fn test_blocked_env_prefixes_azure() {
        assert!(BLOCKED_ENV_PREFIXES.contains(&"AZURE_"));
    }

    #[test]
    fn test_blocked_paths_count() {
        assert_eq!(BLOCKED_PATHS.len(), 11);
    }

    #[test]
    fn test_blocked_paths_dev() {
        assert!(BLOCKED_PATHS.contains(&"/dev"));
    }

    #[test]
    fn test_blocked_paths_boot() {
        assert!(BLOCKED_PATHS.contains(&"/boot"));
    }

    #[test]
    fn test_blocked_paths_bin() {
        assert!(BLOCKED_PATHS.contains(&"/bin"));
    }

    #[test]
    fn test_blocked_paths_sbin() {
        assert!(BLOCKED_PATHS.contains(&"/sbin"));
    }

    #[test]
    fn test_blocked_paths_lib() {
        assert!(BLOCKED_PATHS.contains(&"/lib"));
    }

    #[test]
    fn test_blocked_paths_run() {
        assert!(BLOCKED_PATHS.contains(&"/run"));
    }

    #[test]
    fn test_make_request_helper() {
        let req = make_request(json!({}));
        assert_eq!(req.command, vec!["echo", "hello"]);
        assert!(req.image.is_none());
    }

    #[test]
    fn test_make_request_with_overrides() {
        let req = make_request(json!({"image": "node:20-slim", "timeoutSecs": 120}));
        assert_eq!(req.image, Some("node:20-slim".to_string()));
        assert_eq!(req.timeout_secs, Some(120));
    }

    #[test]
    fn test_docker_exec_request_env_none_by_default() {
        let req = make_request(json!({}));
        assert!(req.env.is_none());
    }

    #[test]
    fn test_docker_exec_request_multiple_env() {
        let json_val = json!({"command": ["echo"], "env": ["FOO=1", "BAR=2", "BAZ=3"]});
        let req: DockerExecRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.env.as_ref().unwrap().len(), 3);
    }

    #[test]
    fn test_docker_exec_request_network_mode_options() {
        for mode in &["none", "bridge", "host"] {
            let json_val = json!({"command": ["echo"], "networkMode": mode});
            let req: DockerExecRequest = serde_json::from_value(json_val).unwrap();
            assert_eq!(req.network_mode.as_deref(), Some(*mode));
        }
    }

    #[tokio::test]
    async fn test_docker_exec_workspace_proc() {
        let input = json!({"command": ["ls"], "workspacePath": "/proc/self"});
        let result = docker_exec(input).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_docker_exec_workspace_sys() {
        let input = json!({"command": ["ls"], "workspacePath": "/sys/kernel"});
        let result = docker_exec(input).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_docker_exec_workspace_dev() {
        let input = json!({"command": ["ls"], "workspacePath": "/dev/null"});
        let result = docker_exec(input).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_docker_exec_workspace_boot() {
        let input = json!({"command": ["ls"], "workspacePath": "/boot/vmlinuz"});
        let result = docker_exec(input).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_docker_exec_workspace_double_dots() {
        let input = json!({"command": ["ls"], "workspacePath": "/home/user/../../etc"});
        let result = docker_exec(input).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_docker_exec_blocked_env_path() {
        let input = json!({"command": ["echo"], "env": ["PATH=/usr/bin"]});
        let result = docker_exec(input).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_docker_exec_blocked_env_without_equals() {
        let input = json!({"command": ["echo"], "env": ["HOME"]});
        let result = docker_exec(input).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("must contain '='"));
        let input2 = json!({"command": ["echo"], "env": ["SAFE_VAR"]});
        let result2 = docker_exec(input2).await;
        assert!(result2.is_err());
        assert!(result2.unwrap_err().to_string().contains("must contain '='"));
    }

    #[tokio::test]
    async fn test_docker_exec_blocked_env_gcp() {
        let input = json!({"command": ["echo"], "env": ["GCP_PROJECT=evil"]});
        let result = docker_exec(input).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_docker_exec_blocked_env_azure() {
        let input = json!({"command": ["echo"], "env": ["AZURE_SUBSCRIPTION=evil"]});
        let result = docker_exec(input).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_docker_exec_disallowed_alpine() {
        let input = json!({"command": ["echo"], "image": "alpine:latest"});
        let result = docker_exec(input).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("not allowed"));
    }

    #[tokio::test]
    async fn test_docker_exec_disallowed_custom_registry() {
        let input = json!({"command": ["echo"], "image": "evil.io/backdoor:latest"});
        let result = docker_exec(input).await;
        assert!(result.is_err());
    }

    #[test]
    fn test_docker_exec_request_serialization() {
        let req = DockerExecRequest {
            command: vec!["echo".to_string(), "test".to_string()],
            image: Some("ubuntu:22.04".to_string()),
            memory_limit: None,
            cpu_limit: None,
            network_mode: None,
            workspace_path: None,
            timeout_secs: Some(10),
            env: None,
        };
        let val = serde_json::to_value(&req).unwrap();
        assert_eq!(val["command"], json!(["echo", "test"]));
        assert_eq!(val["image"], "ubuntu:22.04");
        assert_eq!(val["timeoutSecs"], 10);
    }

    #[tokio::test]
    async fn test_docker_exec_json_array_input() {
        let input = json!([1, 2, 3]);
        let result = docker_exec(input).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_docker_exec_json_null() {
        let input = json!(null);
        let result = docker_exec(input).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_docker_exec_allowed_image_ubuntu_22() {
        let input = json!({"command": ["echo", "hi"], "image": "ubuntu:22.04"});
        let result = docker_exec(input).await;
        assert!(result.is_ok() || !result.unwrap_err().to_string().contains("not allowed"));
    }

    #[tokio::test]
    async fn test_docker_exec_allowed_image_python() {
        let input = json!({"command": ["echo"], "image": "python:3.12-slim"});
        let result = docker_exec(input).await;
        assert!(result.is_ok() || !result.unwrap_err().to_string().contains("not allowed"));
    }

    #[tokio::test]
    async fn test_docker_exec_allowed_image_node() {
        let input = json!({"command": ["echo"], "image": "node:20-slim"});
        let result = docker_exec(input).await;
        assert!(result.is_ok() || !result.unwrap_err().to_string().contains("not allowed"));
    }

    #[tokio::test]
    async fn test_docker_exec_allowed_image_rust() {
        let input = json!({"command": ["echo"], "image": "rust:1-slim"});
        let result = docker_exec(input).await;
        assert!(result.is_ok() || !result.unwrap_err().to_string().contains("not allowed"));
    }

    #[tokio::test]
    async fn test_docker_exec_disallowed_centos() {
        let input = json!({"command": ["echo"], "image": "centos:7"});
        let result = docker_exec(input).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("not allowed"));
    }

    #[tokio::test]
    async fn test_docker_exec_disallowed_empty_image_tag() {
        let input = json!({"command": ["echo"], "image": "evil:"});
        let result = docker_exec(input).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_docker_exec_workspace_safe_tmp() {
        let input = json!({"command": ["ls"], "workspacePath": "/tmp/sandbox"});
        let result = docker_exec(input).await;
        assert!(result.is_ok() || !result.unwrap_err().to_string().contains("Blocked workspace"));
    }

    #[tokio::test]
    async fn test_docker_exec_workspace_blocked_run() {
        let input = json!({"command": ["ls"], "workspacePath": "/run/docker"});
        let result = docker_exec(input).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_docker_exec_workspace_blocked_lib() {
        let input = json!({"command": ["ls"], "workspacePath": "/lib/modules"});
        let result = docker_exec(input).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_docker_exec_workspace_blocked_sbin() {
        let input = json!({"command": ["ls"], "workspacePath": "/sbin/init"});
        let result = docker_exec(input).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_docker_exec_workspace_blocked_bin() {
        let input = json!({"command": ["ls"], "workspacePath": "/bin/sh"});
        let result = docker_exec(input).await;
        assert!(result.is_err());
    }

    #[test]
    fn test_docker_exec_request_default_values() {
        let req = make_request(json!({}));
        assert!(req.memory_limit.is_none());
        assert!(req.cpu_limit.is_none());
        assert!(req.network_mode.is_none());
        assert!(req.workspace_path.is_none());
        assert!(req.timeout_secs.is_none());
        assert!(req.env.is_none());
    }

    #[test]
    fn test_docker_exec_request_memory_limit_values() {
        for limit in &["128m", "256m", "512m", "1g", "2g"] {
            let req = make_request(json!({"memoryLimit": limit}));
            assert_eq!(req.memory_limit.as_deref(), Some(*limit));
        }
    }

    #[test]
    fn test_docker_exec_request_cpu_limit_values() {
        for limit in &["0.5", "1.0", "2.0", "4.0"] {
            let req = make_request(json!({"cpuLimit": limit}));
            assert_eq!(req.cpu_limit.as_deref(), Some(*limit));
        }
    }

    #[test]
    fn test_docker_exec_request_timeout_range() {
        let req = make_request(json!({"timeoutSecs": 0}));
        assert_eq!(req.timeout_secs, Some(0));

        let req2 = make_request(json!({"timeoutSecs": 3600}));
        assert_eq!(req2.timeout_secs, Some(3600));
    }

    #[tokio::test]
    async fn test_docker_exec_single_command() {
        let input = json!({"command": ["ls"]});
        let result = docker_exec(input).await;
        assert!(result.is_ok() || !result.unwrap_err().to_string().contains("not allowed"));
    }

    #[test]
    fn test_default_image_is_in_allowed_list() {
        assert!(ALLOWED_IMAGES.contains(&DEFAULT_IMAGE));
    }

    #[test]
    fn test_default_network_mode_is_none() {
        assert_eq!(DEFAULT_NETWORK_MODE, "none");
    }

    #[test]
    fn test_default_timeout_is_30() {
        assert_eq!(DEFAULT_TIMEOUT_SECS, 30);
    }

    #[test]
    fn test_docker_exec_request_very_long_command() {
        let long_args: Vec<String> = (0..1000).map(|i| format!("arg-{}", i)).collect();
        let mut cmd = vec!["echo".to_string()];
        cmd.extend(long_args);
        let req = DockerExecRequest {
            command: cmd.clone(),
            image: None,
            memory_limit: None,
            cpu_limit: None,
            network_mode: None,
            workspace_path: None,
            timeout_secs: None,
            env: None,
        };
        assert_eq!(req.command.len(), 1001);
        let val = serde_json::to_value(&req).unwrap();
        assert_eq!(val["command"].as_array().unwrap().len(), 1001);
    }

    #[test]
    fn test_docker_exec_request_env_empty_value() {
        let json_val = json!({"command": ["echo"], "env": ["EMPTY_VAR="]});
        let req: DockerExecRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.env.as_ref().unwrap()[0], "EMPTY_VAR=");
    }

    #[test]
    fn test_docker_exec_request_env_special_chars() {
        let json_val = json!({"command": ["echo"], "env": ["SPECIAL=val with spaces", "QUOTED=it's \"quoted\"", "MULTI=line1\nline2"]});
        let req: DockerExecRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.env.as_ref().unwrap().len(), 3);
        assert!(req.env.as_ref().unwrap()[0].contains("spaces"));
    }

    #[test]
    fn test_docker_exec_request_env_no_equals_sign() {
        let json_val = json!({"command": ["echo"], "env": ["JUST_A_NAME"]});
        let req: DockerExecRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.env.as_ref().unwrap()[0], "JUST_A_NAME");
        assert!(!req.env.as_ref().unwrap()[0].contains('='), "env without = should be blocked at runtime");
    }

    #[test]
    fn test_docker_exec_request_workspace_deeply_nested() {
        let json_val = json!({"command": ["ls"], "workspacePath": "/tmp/a/b/c/d/e/f/g/h/i/j"});
        let req: DockerExecRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.workspace_path, Some("/tmp/a/b/c/d/e/f/g/h/i/j".to_string()));
    }

    #[test]
    fn test_docker_exec_request_workspace_unicode() {
        let json_val = json!({"command": ["ls"], "workspacePath": "/tmp/\u{4e16}\u{754c}"});
        let req: DockerExecRequest = serde_json::from_value(json_val).unwrap();
        assert!(req.workspace_path.unwrap().contains("\u{4e16}"));
    }

    #[test]
    fn test_all_allowed_images_exact() {
        let expected = vec![
            "agentos-sandbox",
            "node:20-slim",
            "python:3.12-slim",
            "rust:1-slim",
            "ubuntu:22.04",
            "ubuntu:24.04",
        ];
        for img in &expected {
            assert!(ALLOWED_IMAGES.contains(img), "Missing: {}", img);
        }
        assert_eq!(ALLOWED_IMAGES.len(), expected.len());
    }

    #[test]
    fn test_docker_exec_request_serialization_roundtrip_full() {
        let req = DockerExecRequest {
            command: vec!["python3".to_string(), "-c".to_string(), "print('hello')".to_string()],
            image: Some("python:3.12-slim".to_string()),
            memory_limit: Some("512m".to_string()),
            cpu_limit: Some("2.0".to_string()),
            network_mode: Some("none".to_string()),
            workspace_path: Some("/tmp/work".to_string()),
            timeout_secs: Some(60),
            env: Some(vec!["FOO=bar".to_string(), "BAZ=qux".to_string()]),
        };
        let serialized = serde_json::to_string(&req).unwrap();
        let deserialized: DockerExecRequest = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized.command, req.command);
        assert_eq!(deserialized.image, req.image);
        assert_eq!(deserialized.memory_limit, req.memory_limit);
        assert_eq!(deserialized.cpu_limit, req.cpu_limit);
        assert_eq!(deserialized.network_mode, req.network_mode);
        assert_eq!(deserialized.workspace_path, req.workspace_path);
        assert_eq!(deserialized.timeout_secs, req.timeout_secs);
        assert_eq!(deserialized.env, req.env);
    }

    #[test]
    fn test_docker_exec_request_serialization_roundtrip_minimal() {
        let req = DockerExecRequest {
            command: vec!["ls".to_string()],
            image: None,
            memory_limit: None,
            cpu_limit: None,
            network_mode: None,
            workspace_path: None,
            timeout_secs: None,
            env: None,
        };
        let serialized = serde_json::to_string(&req).unwrap();
        let deserialized: DockerExecRequest = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized.command, vec!["ls"]);
        assert!(deserialized.image.is_none());
        assert!(deserialized.env.is_none());
    }

    #[tokio::test]
    async fn test_docker_exec_blocked_path_every_entry() {
        for path in BLOCKED_PATHS {
            let input = json!({"command": ["ls"], "workspacePath": path});
            let result = docker_exec(input).await;
            assert!(result.is_err(), "Expected blocked for path: {}", path);
        }
    }

    #[tokio::test]
    async fn test_docker_exec_blocked_path_subdirectories() {
        for path in BLOCKED_PATHS {
            let subdir = format!("{}/subdir/deep", path);
            let input = json!({"command": ["ls"], "workspacePath": subdir});
            let result = docker_exec(input).await;
            assert!(result.is_err(), "Expected blocked for subdir of: {}", path);
        }
    }

    #[tokio::test]
    async fn test_docker_exec_blocked_env_all_prefixes() {
        let env_samples = vec![
            "DOCKER_TLS_VERIFY=1",
            "KUBERNETES_PORT=443",
            "AWS_ACCESS_KEY_ID=test",
            "AZURE_CLIENT_ID=test",
            "GCP_SERVICE_ACCOUNT=test",
            "HOME=/evil",
            "PATH=/evil",
        ];
        for env_var in env_samples {
            let input = json!({"command": ["echo"], "env": [env_var]});
            let result = docker_exec(input).await;
            assert!(result.is_err(), "Expected blocked for env: {}", env_var);
        }
    }

    #[tokio::test]
    async fn test_docker_exec_allowed_env_safe_variables() {
        let input = json!({"command": ["echo"], "env": ["MY_VAR=safe", "APP_PORT=3000", "DEBUG=true"]});
        let _result = docker_exec(input).await;
    }

    #[test]
    fn test_docker_exec_request_empty_env_vec() {
        let json_val = json!({"command": ["echo"], "env": []});
        let req: DockerExecRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.env.as_ref().unwrap().len(), 0);
    }

    #[test]
    fn test_docker_exec_request_single_command_word() {
        let json_val = json!({"command": ["whoami"]});
        let req: DockerExecRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.command.len(), 1);
        assert_eq!(req.command[0], "whoami");
    }

    #[test]
    fn test_docker_exec_request_command_with_flags() {
        let json_val = json!({"command": ["ls", "-la", "--color=auto", "/tmp"]});
        let req: DockerExecRequest = serde_json::from_value(json_val).unwrap();
        assert_eq!(req.command.len(), 4);
    }

    #[tokio::test]
    async fn test_docker_exec_disallowed_image_with_tag() {
        let input = json!({"command": ["echo"], "image": "debian:bullseye"});
        let result = docker_exec(input).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_docker_exec_disallowed_image_latest() {
        let input = json!({"command": ["echo"], "image": "latest"});
        let result = docker_exec(input).await;
        assert!(result.is_err());
    }
}

pub fn register(iii: &III) {
    iii.register_function_with_description(
        "sandbox::docker_exec",
        "Execute a command inside a Docker container sandbox",
        move |input: Value| async move { docker_exec(input).await },
    );
}

async fn docker_exec(input: Value) -> Result<Value, IIIError> {
    let req: DockerExecRequest = serde_json::from_value(input)
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    if req.command.is_empty() {
        return Err(IIIError::Handler("command must not be empty".into()));
    }

    let image = req.image.as_deref().unwrap_or(DEFAULT_IMAGE);

    if !ALLOWED_IMAGES.iter().any(|allowed| {
        image == *allowed
            || image.starts_with(&format!(
                "{}:",
                allowed.split(':').next().unwrap_or("")
            ))
    }) {
        return Err(IIIError::Handler(format!(
            "Docker image not allowed: {}. Allowed: {:?}",
            image, ALLOWED_IMAGES
        )));
    }

    let memory_limit = req.memory_limit.as_deref().unwrap_or(DEFAULT_MEMORY_LIMIT);
    let cpu_limit = req.cpu_limit.as_deref().unwrap_or(DEFAULT_CPU_LIMIT);
    let network_mode = req.network_mode.as_deref().unwrap_or(DEFAULT_NETWORK_MODE);
    let timeout_secs = req.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS);

    let id = uuid::Uuid::new_v4().to_string();
    let container_name = format!("agentos-sandbox-{}", &id[..8]);

    let mut args = vec![
        "run".to_string(),
        "--rm".to_string(),
        "--name".to_string(),
        container_name.clone(),
        "--memory".to_string(),
        memory_limit.to_string(),
        "--cpus".to_string(),
        cpu_limit.to_string(),
        "--network".to_string(),
        network_mode.to_string(),
        "--pids-limit".to_string(),
        "256".to_string(),
        "--read-only".to_string(),
        "--no-new-privileges".to_string(),
    ];

    if let Some(workspace) = &req.workspace_path {
        if workspace.contains("..")
            || workspace == "/"
            || BLOCKED_PATHS
                .iter()
                .any(|p| workspace == *p || workspace.starts_with(&format!("{}/", p)))
        {
            return Err(IIIError::Handler(
                "Blocked workspace path".to_string(),
            ));
        }
        args.push("-v".to_string());
        args.push(format!("{}:/workspace:rw", workspace));
        args.push("-w".to_string());
        args.push("/workspace".to_string());
    }

    if let Some(env_vars) = &req.env {
        for var in env_vars {
            if !var.contains('=') {
                return Err(IIIError::Handler(format!(
                    "Env var must contain '=': {}",
                    var
                )));
            }
            let upper = var.to_uppercase();
            let name_upper = upper.split('=').next().unwrap_or(&upper);
            let blocked = BLOCKED_ENV_PREFIXES.iter().any(|p| {
                let prefix = p.trim_end_matches('=');
                name_upper.starts_with(prefix)
            });
            if blocked {
                return Err(IIIError::Handler(format!(
                    "Blocked env var: {}",
                    var.split('=').next().unwrap_or("")
                )));
            }
            args.push("-e".to_string());
            args.push(var.clone());
        }
    }

    args.push(image.to_string());
    args.extend(req.command.clone());

    let start = std::time::Instant::now();

    let child = tokio::process::Command::new("docker")
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let timeout = tokio::time::Duration::from_secs(timeout_secs);
    let result = tokio::time::timeout(timeout, child.wait_with_output()).await;

    let duration_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let exit_code = output.status.code().unwrap_or(-1);

            Ok(json!({
                "exitCode": exit_code,
                "stdout": stdout,
                "stderr": stderr,
                "durationMs": duration_ms,
                "timedOut": false,
            }))
        }
        Ok(Err(e)) => {
            Ok(json!({
                "exitCode": -1,
                "stdout": "",
                "stderr": e.to_string(),
                "durationMs": duration_ms,
                "timedOut": false,
            }))
        }
        Err(_) => {
            let _ = tokio::process::Command::new("docker")
                .args(["rm", "-f", &container_name])
                .output()
                .await;

            Ok(json!({
                "exitCode": -1,
                "stdout": "",
                "stderr": "Execution timed out",
                "durationMs": duration_ms,
                "timedOut": true,
            }))
        }
    }
}
