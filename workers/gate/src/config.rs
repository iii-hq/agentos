pub struct GateConfig {
    pub ws_url: String,
    pub attempt_topic: Option<String>,
}

impl GateConfig {
    pub fn from_env() -> Self {
        Self {
            ws_url: std::env::var("III_WS_URL")
                .unwrap_or_else(|_| "ws://localhost:49134".to_string()),
            attempt_topic: std::env::var("GATE_ATTEMPT_TOPIC").ok(),
        }
    }
}
