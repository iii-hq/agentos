use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LifecycleState {
    Spawning,
    Working,
    Blocked,
    PrOpen,
    Review,
    Merged,
    Done,
    Failed,
    Recovering,
    Terminated,
}

impl LifecycleState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Spawning => "spawning",
            Self::Working => "working",
            Self::Blocked => "blocked",
            Self::PrOpen => "pr_open",
            Self::Review => "review",
            Self::Merged => "merged",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Recovering => "recovering",
            Self::Terminated => "terminated",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "spawning" => Some(Self::Spawning),
            "working" => Some(Self::Working),
            "blocked" => Some(Self::Blocked),
            "pr_open" => Some(Self::PrOpen),
            "review" => Some(Self::Review),
            "merged" => Some(Self::Merged),
            "done" => Some(Self::Done),
            "failed" => Some(Self::Failed),
            "recovering" => Some(Self::Recovering),
            "terminated" => Some(Self::Terminated),
            _ => None,
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Done | Self::Terminated)
    }

    pub fn allowed_targets(&self) -> &'static [LifecycleState] {
        match self {
            Self::Spawning => &[Self::Working, Self::Failed, Self::Terminated],
            Self::Working => &[Self::Blocked, Self::PrOpen, Self::Failed, Self::Terminated],
            Self::Blocked => &[Self::Working, Self::Failed, Self::Terminated],
            Self::PrOpen => &[Self::Review, Self::Merged, Self::Failed, Self::Terminated],
            Self::Review => &[Self::Merged, Self::PrOpen, Self::Failed, Self::Terminated],
            Self::Merged => &[Self::Done, Self::Terminated],
            Self::Done => &[],
            Self::Failed => &[Self::Recovering, Self::Terminated],
            Self::Recovering => &[Self::Working, Self::Failed, Self::Terminated],
            Self::Terminated => &[],
        }
    }

    pub fn allows(&self, target: LifecycleState) -> bool {
        self.allowed_targets().contains(&target)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reaction {
    pub id: String,
    pub from: LifecycleState,
    pub to: LifecycleState,
    pub action: String,
    #[serde(default)]
    pub payload: Value,
    #[serde(rename = "escalateAfter")]
    pub escalate_after: u32,
    #[serde(default)]
    pub attempts: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_states() {
        assert!(LifecycleState::Done.is_terminal());
        assert!(LifecycleState::Terminated.is_terminal());
        assert!(!LifecycleState::Working.is_terminal());
    }

    #[test]
    fn valid_transition_spawning_to_working() {
        assert!(LifecycleState::Spawning.allows(LifecycleState::Working));
    }

    #[test]
    fn invalid_transition_spawning_to_merged() {
        assert!(!LifecycleState::Spawning.allows(LifecycleState::Merged));
    }

    #[test]
    fn done_has_no_targets() {
        assert!(LifecycleState::Done.allowed_targets().is_empty());
    }

    #[test]
    fn from_str_round_trip() {
        for state in [
            LifecycleState::Spawning,
            LifecycleState::Working,
            LifecycleState::Blocked,
            LifecycleState::PrOpen,
            LifecycleState::Review,
            LifecycleState::Merged,
            LifecycleState::Done,
            LifecycleState::Failed,
            LifecycleState::Recovering,
            LifecycleState::Terminated,
        ] {
            assert_eq!(LifecycleState::from_str(state.as_str()), Some(state));
        }
    }
}
