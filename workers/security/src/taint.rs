use iii_sdk::iii::III;
use iii_sdk::error::IIIError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

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



#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TaintLabel {
    ExternalNetwork,
    UserInput,
    Pii,
    Secret,
    UntrustedAgent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaintSet {
    labels: HashSet<TaintLabel>,
}

#[allow(dead_code)]
impl TaintSet {
    pub fn new() -> Self {
        Self { labels: HashSet::new() }
    }

    pub fn from_labels(labels: Vec<TaintLabel>) -> Self {
        Self { labels: labels.into_iter().collect() }
    }

    pub fn add(&mut self, label: TaintLabel) {
        self.labels.insert(label);
    }

    pub fn merge(&mut self, other: &TaintSet) {
        for label in &other.labels {
            self.labels.insert(*label);
        }
    }

    pub fn check(&self, label: &TaintLabel) -> bool {
        self.labels.contains(label)
    }

    pub fn declassify(&mut self, label: &TaintLabel) {
        self.labels.remove(label);
    }

    pub fn is_empty(&self) -> bool {
        self.labels.is_empty()
    }

    pub fn labels(&self) -> &HashSet<TaintLabel> {
        &self.labels
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaintedValue<T: Serialize> {
    pub value: T,
    pub taints: TaintSet,
}

impl<T: Serialize> TaintedValue<T> {
    pub fn new(value: T, taints: TaintSet) -> Self {
        Self { value, taints }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaintSink {
    LogOutput,
    NetworkSend,
    FileWrite,
    AgentResponse,
}

pub fn can_flow_to(labels: &TaintSet, sink: &TaintSink) -> bool {
    match sink {
        TaintSink::LogOutput => {
            !labels.check(&TaintLabel::Secret) && !labels.check(&TaintLabel::Pii)
        }
        TaintSink::NetworkSend => {
            !labels.check(&TaintLabel::Secret)
        }
        TaintSink::FileWrite => {
            !labels.check(&TaintLabel::Secret) && !labels.check(&TaintLabel::UntrustedAgent)
        }
        TaintSink::AgentResponse => {
            !labels.check(&TaintLabel::Secret)
        }
    }
}

fn parse_label(s: &str) -> Option<TaintLabel> {
    match s {
        "ExternalNetwork" => Some(TaintLabel::ExternalNetwork),
        "UserInput" => Some(TaintLabel::UserInput),
        "Pii" => Some(TaintLabel::Pii),
        "Secret" => Some(TaintLabel::Secret),
        "UntrustedAgent" => Some(TaintLabel::UntrustedAgent),
        _ => None,
    }
}

fn parse_sink(s: &str) -> Option<TaintSink> {
    match s {
        "LogOutput" => Some(TaintSink::LogOutput),
        "NetworkSend" => Some(TaintSink::NetworkSend),
        "FileWrite" => Some(TaintSink::FileWrite),
        "AgentResponse" => Some(TaintSink::AgentResponse),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_taint_set_new_is_empty() {
        let ts = TaintSet::new();
        assert!(ts.is_empty());
    }

    #[test]
    fn test_taint_set_add_label() {
        let mut ts = TaintSet::new();
        ts.add(TaintLabel::Secret);
        assert!(ts.check(&TaintLabel::Secret));
        assert!(!ts.is_empty());
    }

    #[test]
    fn test_taint_set_from_labels() {
        let ts = TaintSet::from_labels(vec![TaintLabel::Pii, TaintLabel::Secret]);
        assert!(ts.check(&TaintLabel::Pii));
        assert!(ts.check(&TaintLabel::Secret));
        assert!(!ts.check(&TaintLabel::UserInput));
    }

    #[test]
    fn test_taint_set_from_empty_labels() {
        let ts = TaintSet::from_labels(vec![]);
        assert!(ts.is_empty());
    }

    #[test]
    fn test_taint_set_all_five_labels() {
        let ts = TaintSet::from_labels(vec![
            TaintLabel::ExternalNetwork,
            TaintLabel::UserInput,
            TaintLabel::Pii,
            TaintLabel::Secret,
            TaintLabel::UntrustedAgent,
        ]);
        assert!(ts.check(&TaintLabel::ExternalNetwork));
        assert!(ts.check(&TaintLabel::UserInput));
        assert!(ts.check(&TaintLabel::Pii));
        assert!(ts.check(&TaintLabel::Secret));
        assert!(ts.check(&TaintLabel::UntrustedAgent));
    }

    #[test]
    fn test_taint_set_merge() {
        let mut ts1 = TaintSet::from_labels(vec![TaintLabel::Pii]);
        let ts2 = TaintSet::from_labels(vec![TaintLabel::Secret, TaintLabel::UserInput]);
        ts1.merge(&ts2);
        assert!(ts1.check(&TaintLabel::Pii));
        assert!(ts1.check(&TaintLabel::Secret));
        assert!(ts1.check(&TaintLabel::UserInput));
    }

    #[test]
    fn test_taint_set_merge_idempotent() {
        let mut ts1 = TaintSet::from_labels(vec![TaintLabel::Pii]);
        let ts2 = TaintSet::from_labels(vec![TaintLabel::Pii]);
        ts1.merge(&ts2);
        assert_eq!(ts1.labels().len(), 1);
    }

    #[test]
    fn test_taint_set_declassify() {
        let mut ts = TaintSet::from_labels(vec![TaintLabel::Secret, TaintLabel::Pii]);
        ts.declassify(&TaintLabel::Secret);
        assert!(!ts.check(&TaintLabel::Secret));
        assert!(ts.check(&TaintLabel::Pii));
    }

    #[test]
    fn test_taint_set_declassify_nonexistent() {
        let mut ts = TaintSet::from_labels(vec![TaintLabel::Pii]);
        ts.declassify(&TaintLabel::Secret);
        assert!(ts.check(&TaintLabel::Pii));
    }

    #[test]
    fn test_taint_set_declassify_all_becomes_empty() {
        let mut ts = TaintSet::from_labels(vec![TaintLabel::Secret]);
        ts.declassify(&TaintLabel::Secret);
        assert!(ts.is_empty());
    }

    #[test]
    fn test_taint_set_labels_returns_correct_set() {
        let ts = TaintSet::from_labels(vec![TaintLabel::ExternalNetwork, TaintLabel::UserInput]);
        let labels = ts.labels();
        assert_eq!(labels.len(), 2);
        assert!(labels.contains(&TaintLabel::ExternalNetwork));
        assert!(labels.contains(&TaintLabel::UserInput));
    }

    #[test]
    fn test_tainted_value_creation() {
        let tv = TaintedValue::new("hello".to_string(), TaintSet::from_labels(vec![TaintLabel::UserInput]));
        assert_eq!(tv.value, "hello");
        assert!(tv.taints.check(&TaintLabel::UserInput));
    }

    #[test]
    fn test_can_flow_to_log_output_no_secret_no_pii() {
        let ts = TaintSet::from_labels(vec![TaintLabel::UserInput, TaintLabel::ExternalNetwork]);
        assert!(can_flow_to(&ts, &TaintSink::LogOutput));
    }

    #[test]
    fn test_can_flow_to_log_output_blocked_by_secret() {
        let ts = TaintSet::from_labels(vec![TaintLabel::Secret]);
        assert!(!can_flow_to(&ts, &TaintSink::LogOutput));
    }

    #[test]
    fn test_can_flow_to_log_output_blocked_by_pii() {
        let ts = TaintSet::from_labels(vec![TaintLabel::Pii]);
        assert!(!can_flow_to(&ts, &TaintSink::LogOutput));
    }

    #[test]
    fn test_can_flow_to_network_send_no_secret() {
        let ts = TaintSet::from_labels(vec![TaintLabel::Pii, TaintLabel::UserInput]);
        assert!(can_flow_to(&ts, &TaintSink::NetworkSend));
    }

    #[test]
    fn test_can_flow_to_network_send_blocked_by_secret() {
        let ts = TaintSet::from_labels(vec![TaintLabel::Secret]);
        assert!(!can_flow_to(&ts, &TaintSink::NetworkSend));
    }

    #[test]
    fn test_can_flow_to_file_write_allowed() {
        let ts = TaintSet::from_labels(vec![TaintLabel::UserInput, TaintLabel::ExternalNetwork]);
        assert!(can_flow_to(&ts, &TaintSink::FileWrite));
    }

    #[test]
    fn test_can_flow_to_file_write_blocked_by_secret() {
        let ts = TaintSet::from_labels(vec![TaintLabel::Secret]);
        assert!(!can_flow_to(&ts, &TaintSink::FileWrite));
    }

    #[test]
    fn test_can_flow_to_file_write_blocked_by_untrusted_agent() {
        let ts = TaintSet::from_labels(vec![TaintLabel::UntrustedAgent]);
        assert!(!can_flow_to(&ts, &TaintSink::FileWrite));
    }

    #[test]
    fn test_can_flow_to_agent_response_allowed() {
        let ts = TaintSet::from_labels(vec![TaintLabel::UserInput, TaintLabel::Pii]);
        assert!(can_flow_to(&ts, &TaintSink::AgentResponse));
    }

    #[test]
    fn test_can_flow_to_agent_response_blocked_by_secret() {
        let ts = TaintSet::from_labels(vec![TaintLabel::Secret]);
        assert!(!can_flow_to(&ts, &TaintSink::AgentResponse));
    }

    #[test]
    fn test_can_flow_to_empty_taint_set_allowed_everywhere() {
        let ts = TaintSet::new();
        assert!(can_flow_to(&ts, &TaintSink::LogOutput));
        assert!(can_flow_to(&ts, &TaintSink::NetworkSend));
        assert!(can_flow_to(&ts, &TaintSink::FileWrite));
        assert!(can_flow_to(&ts, &TaintSink::AgentResponse));
    }

    #[test]
    fn test_parse_label_all_variants() {
        assert_eq!(parse_label("ExternalNetwork"), Some(TaintLabel::ExternalNetwork));
        assert_eq!(parse_label("UserInput"), Some(TaintLabel::UserInput));
        assert_eq!(parse_label("Pii"), Some(TaintLabel::Pii));
        assert_eq!(parse_label("Secret"), Some(TaintLabel::Secret));
        assert_eq!(parse_label("UntrustedAgent"), Some(TaintLabel::UntrustedAgent));
    }

    #[test]
    fn test_parse_label_unknown() {
        assert_eq!(parse_label("Unknown"), None);
        assert_eq!(parse_label(""), None);
        assert_eq!(parse_label("secret"), None);
    }

    #[test]
    fn test_parse_sink_all_variants() {
        assert_eq!(parse_sink("LogOutput"), Some(TaintSink::LogOutput));
        assert_eq!(parse_sink("NetworkSend"), Some(TaintSink::NetworkSend));
        assert_eq!(parse_sink("FileWrite"), Some(TaintSink::FileWrite));
        assert_eq!(parse_sink("AgentResponse"), Some(TaintSink::AgentResponse));
    }

    #[test]
    fn test_parse_sink_unknown() {
        assert_eq!(parse_sink("Unknown"), None);
        assert_eq!(parse_sink(""), None);
        assert_eq!(parse_sink("logoutput"), None);
    }

    #[test]
    fn test_taint_label_equality() {
        assert_eq!(TaintLabel::Secret, TaintLabel::Secret);
        assert_ne!(TaintLabel::Secret, TaintLabel::Pii);
    }

    #[test]
    fn test_taint_sink_equality() {
        assert_eq!(TaintSink::LogOutput, TaintSink::LogOutput);
        assert_ne!(TaintSink::LogOutput, TaintSink::FileWrite);
    }

    #[test]
    fn test_tainted_value_serialization() {
        let tv = TaintedValue::new("test data".to_string(), TaintSet::from_labels(vec![TaintLabel::Pii]));
        let serialized = serde_json::to_value(&tv).unwrap();
        assert_eq!(serialized["value"], "test data");
        assert!(serialized["taints"]["labels"].as_array().unwrap().len() == 1);
    }

    #[test]
    fn test_taint_set_duplicate_add() {
        let mut ts = TaintSet::new();
        ts.add(TaintLabel::Secret);
        ts.add(TaintLabel::Secret);
        assert_eq!(ts.labels().len(), 1);
    }

    #[test]
    fn test_tainted_value_with_number() {
        let tv = TaintedValue::new(42_i64, TaintSet::from_labels(vec![TaintLabel::Secret]));
        assert_eq!(tv.value, 42);
        assert!(tv.taints.check(&TaintLabel::Secret));
    }

    #[test]
    fn test_tainted_value_with_vec() {
        let tv = TaintedValue::new(vec![1, 2, 3], TaintSet::from_labels(vec![TaintLabel::Pii]));
        assert_eq!(tv.value.len(), 3);
        assert!(tv.taints.check(&TaintLabel::Pii));
    }

    #[test]
    fn test_tainted_value_with_nested_json() {
        let nested = json!({"user": {"name": "Alice", "age": 30}});
        let tv = TaintedValue::new(nested.clone(), TaintSet::from_labels(vec![TaintLabel::Pii, TaintLabel::UserInput]));
        assert_eq!(tv.value["user"]["name"], "Alice");
        assert!(tv.taints.check(&TaintLabel::Pii));
        assert!(tv.taints.check(&TaintLabel::UserInput));
    }

    #[test]
    fn test_tainted_value_with_boolean() {
        let tv = TaintedValue::new(true, TaintSet::new());
        assert!(tv.value);
        assert!(tv.taints.is_empty());
    }

    #[test]
    fn test_flow_control_external_network_all_sinks() {
        let ts = TaintSet::from_labels(vec![TaintLabel::ExternalNetwork]);
        assert!(can_flow_to(&ts, &TaintSink::LogOutput));
        assert!(can_flow_to(&ts, &TaintSink::NetworkSend));
        assert!(can_flow_to(&ts, &TaintSink::FileWrite));
        assert!(can_flow_to(&ts, &TaintSink::AgentResponse));
    }

    #[test]
    fn test_flow_control_user_input_all_sinks() {
        let ts = TaintSet::from_labels(vec![TaintLabel::UserInput]);
        assert!(can_flow_to(&ts, &TaintSink::LogOutput));
        assert!(can_flow_to(&ts, &TaintSink::NetworkSend));
        assert!(can_flow_to(&ts, &TaintSink::FileWrite));
        assert!(can_flow_to(&ts, &TaintSink::AgentResponse));
    }

    #[test]
    fn test_flow_control_pii_all_sinks() {
        let ts = TaintSet::from_labels(vec![TaintLabel::Pii]);
        assert!(!can_flow_to(&ts, &TaintSink::LogOutput));
        assert!(can_flow_to(&ts, &TaintSink::NetworkSend));
        assert!(can_flow_to(&ts, &TaintSink::FileWrite));
        assert!(can_flow_to(&ts, &TaintSink::AgentResponse));
    }

    #[test]
    fn test_flow_control_secret_all_sinks() {
        let ts = TaintSet::from_labels(vec![TaintLabel::Secret]);
        assert!(!can_flow_to(&ts, &TaintSink::LogOutput));
        assert!(!can_flow_to(&ts, &TaintSink::NetworkSend));
        assert!(!can_flow_to(&ts, &TaintSink::FileWrite));
        assert!(!can_flow_to(&ts, &TaintSink::AgentResponse));
    }

    #[test]
    fn test_flow_control_untrusted_agent_all_sinks() {
        let ts = TaintSet::from_labels(vec![TaintLabel::UntrustedAgent]);
        assert!(can_flow_to(&ts, &TaintSink::LogOutput));
        assert!(can_flow_to(&ts, &TaintSink::NetworkSend));
        assert!(!can_flow_to(&ts, &TaintSink::FileWrite));
        assert!(can_flow_to(&ts, &TaintSink::AgentResponse));
    }

    #[test]
    fn test_merge_with_empty_set() {
        let mut ts = TaintSet::from_labels(vec![TaintLabel::Secret, TaintLabel::Pii]);
        let empty = TaintSet::new();
        ts.merge(&empty);
        assert_eq!(ts.labels().len(), 2);
        assert!(ts.check(&TaintLabel::Secret));
        assert!(ts.check(&TaintLabel::Pii));
    }

    #[test]
    fn test_merge_empty_with_nonempty() {
        let mut ts = TaintSet::new();
        let other = TaintSet::from_labels(vec![TaintLabel::ExternalNetwork]);
        ts.merge(&other);
        assert_eq!(ts.labels().len(), 1);
        assert!(ts.check(&TaintLabel::ExternalNetwork));
    }

    #[test]
    fn test_merge_two_empty_sets() {
        let mut ts = TaintSet::new();
        let other = TaintSet::new();
        ts.merge(&other);
        assert!(ts.is_empty());
    }

    #[test]
    fn test_declassify_then_re_add() {
        let mut ts = TaintSet::from_labels(vec![TaintLabel::Secret]);
        ts.declassify(&TaintLabel::Secret);
        assert!(!ts.check(&TaintLabel::Secret));
        ts.add(TaintLabel::Secret);
        assert!(ts.check(&TaintLabel::Secret));
    }

    #[test]
    fn test_multiple_add_merge_declassify_sequence() {
        let mut ts = TaintSet::new();
        ts.add(TaintLabel::Pii);
        ts.add(TaintLabel::Secret);
        assert_eq!(ts.labels().len(), 2);

        let other = TaintSet::from_labels(vec![TaintLabel::UserInput, TaintLabel::ExternalNetwork]);
        ts.merge(&other);
        assert_eq!(ts.labels().len(), 4);

        ts.declassify(&TaintLabel::Secret);
        assert_eq!(ts.labels().len(), 3);
        assert!(!ts.check(&TaintLabel::Secret));

        ts.add(TaintLabel::UntrustedAgent);
        assert_eq!(ts.labels().len(), 4);

        ts.declassify(&TaintLabel::Pii);
        ts.declassify(&TaintLabel::UserInput);
        ts.declassify(&TaintLabel::ExternalNetwork);
        ts.declassify(&TaintLabel::UntrustedAgent);
        assert!(ts.is_empty());
    }

    #[test]
    fn test_tainted_value_serialization_roundtrip_string() {
        let tv = TaintedValue::new("sensitive data".to_string(), TaintSet::from_labels(vec![TaintLabel::Pii, TaintLabel::Secret]));
        let serialized = serde_json::to_string(&tv).unwrap();
        let deserialized: TaintedValue<String> = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized.value, "sensitive data");
        assert!(deserialized.taints.check(&TaintLabel::Pii));
        assert!(deserialized.taints.check(&TaintLabel::Secret));
    }

    #[test]
    fn test_tainted_value_serialization_roundtrip_json() {
        let data = json!({"key": "value", "nested": [1, 2, 3]});
        let tv = TaintedValue::new(data.clone(), TaintSet::from_labels(vec![TaintLabel::UserInput]));
        let serialized = serde_json::to_value(&tv).unwrap();
        assert_eq!(serialized["value"]["key"], "value");
        assert_eq!(serialized["value"]["nested"][1], 2);
        let labels = serialized["taints"]["labels"].as_array().unwrap();
        assert_eq!(labels.len(), 1);
        let deserialized: TaintedValue<Value> = serde_json::from_value(serialized).unwrap();
        assert_eq!(deserialized.value, data);
        assert!(deserialized.taints.check(&TaintLabel::UserInput));
    }

    #[test]
    fn test_taint_label_clone_and_copy() {
        let label = TaintLabel::Secret;
        let cloned = label.clone();
        let copied = label;
        assert_eq!(label, cloned);
        assert_eq!(label, copied);
    }

    #[test]
    fn test_taint_set_from_labels_with_duplicates() {
        let ts = TaintSet::from_labels(vec![TaintLabel::Pii, TaintLabel::Pii, TaintLabel::Pii]);
        assert_eq!(ts.labels().len(), 1);
        assert!(ts.check(&TaintLabel::Pii));
    }

    #[test]
    fn test_flow_secret_and_pii_combined() {
        let ts = TaintSet::from_labels(vec![TaintLabel::Secret, TaintLabel::Pii]);
        assert!(!can_flow_to(&ts, &TaintSink::LogOutput));
        assert!(!can_flow_to(&ts, &TaintSink::NetworkSend));
        assert!(!can_flow_to(&ts, &TaintSink::FileWrite));
        assert!(!can_flow_to(&ts, &TaintSink::AgentResponse));
    }

    #[test]
    fn test_flow_secret_and_untrusted_combined() {
        let ts = TaintSet::from_labels(vec![TaintLabel::Secret, TaintLabel::UntrustedAgent]);
        assert!(!can_flow_to(&ts, &TaintSink::LogOutput));
        assert!(!can_flow_to(&ts, &TaintSink::NetworkSend));
        assert!(!can_flow_to(&ts, &TaintSink::FileWrite));
        assert!(!can_flow_to(&ts, &TaintSink::AgentResponse));
    }

    #[test]
    fn test_flow_pii_and_untrusted_combined() {
        let ts = TaintSet::from_labels(vec![TaintLabel::Pii, TaintLabel::UntrustedAgent]);
        assert!(!can_flow_to(&ts, &TaintSink::LogOutput));
        assert!(can_flow_to(&ts, &TaintSink::NetworkSend));
        assert!(!can_flow_to(&ts, &TaintSink::FileWrite));
        assert!(can_flow_to(&ts, &TaintSink::AgentResponse));
    }

    #[test]
    fn test_declassify_secret_enables_all_flows() {
        let mut ts = TaintSet::from_labels(vec![TaintLabel::Secret]);
        assert!(!can_flow_to(&ts, &TaintSink::LogOutput));
        ts.declassify(&TaintLabel::Secret);
        assert!(can_flow_to(&ts, &TaintSink::LogOutput));
        assert!(can_flow_to(&ts, &TaintSink::NetworkSend));
        assert!(can_flow_to(&ts, &TaintSink::FileWrite));
        assert!(can_flow_to(&ts, &TaintSink::AgentResponse));
    }

    #[test]
    fn test_taint_set_serialization_roundtrip() {
        let ts = TaintSet::from_labels(vec![TaintLabel::ExternalNetwork, TaintLabel::UserInput, TaintLabel::Secret]);
        let serialized = serde_json::to_string(&ts).unwrap();
        let deserialized: TaintSet = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized.labels().len(), 3);
        assert!(deserialized.check(&TaintLabel::ExternalNetwork));
        assert!(deserialized.check(&TaintLabel::UserInput));
        assert!(deserialized.check(&TaintLabel::Secret));
    }

    #[test]
    fn test_parse_label_case_sensitivity() {
        assert_eq!(parse_label("secret"), None);
        assert_eq!(parse_label("SECRET"), None);
        assert_eq!(parse_label("pii"), None);
        assert_eq!(parse_label("PII"), None);
        assert_eq!(parse_label("userinput"), None);
        assert_eq!(parse_label("USERINPUT"), None);
    }

    #[test]
    fn test_parse_sink_case_sensitivity() {
        assert_eq!(parse_sink("logOutput"), None);
        assert_eq!(parse_sink("LOGOUTPUT"), None);
        assert_eq!(parse_sink("networkSend"), None);
        assert_eq!(parse_sink("filewrite"), None);
    }
}

pub fn register(iii: &III) {
    let _iii_declassify = iii.clone();
    iii.register_function_with_description(
        "taint::label",
        "Apply taint labels to a value",
        move |input: Value| async move {
            let value = input.get("value").cloned().unwrap_or(json!(null));
            let label_strs = input["labels"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>())
                .unwrap_or_default();

            let labels: Vec<TaintLabel> = label_strs
                .iter()
                .filter_map(|s| parse_label(s))
                .collect();

            let tainted = TaintedValue::new(value, TaintSet::from_labels(labels));
            serde_json::to_value(tainted).map_err(|e| IIIError::Handler(e.to_string()))
        },
    );

    iii.register_function_with_description(
        "taint::check",
        "Check if tainted value can flow to a sink",
        move |input: Value| async move {
            let taint_set: TaintSet = serde_json::from_value(
                input.get("taints").cloned().unwrap_or(json!({ "labels": [] }))
            ).map_err(|e| IIIError::Handler(e.to_string()))?;

            let sink_str = input["sink"].as_str().unwrap_or("");
            let sink = parse_sink(sink_str)
                .ok_or_else(|| IIIError::Handler(format!("Unknown sink: {}", sink_str)))?;

            let allowed = can_flow_to(&taint_set, &sink);
            let blocking_labels: Vec<&TaintLabel> = if !allowed {
                taint_set.labels().iter().collect()
            } else {
                vec![]
            };

            Ok(json!({
                "allowed": allowed,
                "sink": sink_str,
                "blockingLabels": blocking_labels,
            }))
        },
    );

    let iii_for_declassify = _iii_declassify;
    iii.register_function_with_description(
        "taint::declassify",
        "Remove taint labels from a value",
        move |input: Value| {
            let iii = iii_for_declassify.clone();
            async move {
                let mut taint_set: TaintSet = serde_json::from_value(
                    input.get("taints").cloned().unwrap_or(json!({ "labels": [] }))
                ).map_err(|e| IIIError::Handler(e.to_string()))?;

                let remove_strs = input["remove"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>())
                    .unwrap_or_default();

                for s in &remove_strs {
                    if let Some(label) = parse_label(s) {
                        taint_set.declassify(&label);
                    }
                }

                let _ = iii.trigger_void("security::audit", json!({
                    "type": "taint_declassified",
                    "detail": { "removedLabels": &remove_strs },
                }));

                let value = input.get("value").cloned().unwrap_or(json!(null));
                let result = TaintedValue::new(value, taint_set);
                serde_json::to_value(result).map_err(|e| IIIError::Handler(e.to_string()))
            }
        },
    );
}
