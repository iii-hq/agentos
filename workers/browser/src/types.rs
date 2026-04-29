use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
}

impl Default for Viewport {
    fn default() -> Self {
        Self { width: 1280, height: 720 }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BrowserSession {
    pub id: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    #[serde(rename = "currentUrl")]
    pub current_url: String,
    pub headless: bool,
    pub viewport: Viewport,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "lastActivity")]
    pub last_activity: i64,
    #[serde(rename = "scriptPath")]
    pub script_path: String,
}
