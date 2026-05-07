use ratatui::{
    layout::Rect,
    text::{Line, Span},
    widgets::Paragraph,
    Frame,
};

use crate::theme;

#[derive(Debug, Clone)]
pub struct StatusInput<'a> {
    pub engine_healthy: bool,
    pub worker_count: usize,
    pub agent: &'a str,
    pub realm: &'a str,
    pub session_active: bool,
    pub pending_approvals: usize,
    pub hint: &'a str,
}

pub fn render(input: &StatusInput) -> Line<'static> {
    let dot = if input.engine_healthy {
        Span::styled("● ", theme::ok())
    } else {
        Span::styled("○ ", theme::err())
    };
    let engine_lbl = if input.engine_healthy {
        Span::styled("engine ", theme::dim())
    } else {
        Span::styled("offline ", theme::err())
    };
    let workers = Span::styled(
        format!("{} workers ", input.worker_count),
        theme::dim(),
    );
    let agent = Span::styled(
        format!("· agent: {} ", input.agent),
        theme::accent(),
    );
    let realm = Span::styled(
        format!("· realm: {} ", input.realm),
        theme::dim(),
    );
    let session = if input.session_active {
        Span::styled("· streaming ", theme::ok())
    } else {
        Span::raw("")
    };
    let approvals = if input.pending_approvals > 0 {
        Span::styled(
            format!("· {} approvals pending ", input.pending_approvals),
            theme::warn(),
        )
    } else {
        Span::raw("")
    };
    let hint = Span::styled(format!("  {}", input.hint), theme::eyebrow());

    Line::from(vec![dot, engine_lbl, workers, agent, realm, session, approvals, hint])
}

pub fn draw(f: &mut Frame, area: Rect, input: &StatusInput) {
    let line = render(input);
    f.render_widget(Paragraph::new(line), area);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn healthy_engine_renders_dot() {
        let line = render(&StatusInput {
            engine_healthy: true,
            worker_count: 65,
            agent: "default",
            realm: "prod",
            session_active: false,
            pending_approvals: 0,
            hint: "?",
        });
        let txt: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(txt.contains("65 workers"));
        assert!(txt.contains("default"));
    }

    #[test]
    fn offline_shows_offline() {
        let line = render(&StatusInput {
            engine_healthy: false,
            worker_count: 0,
            agent: "-",
            realm: "-",
            session_active: false,
            pending_approvals: 0,
            hint: "",
        });
        let txt: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(txt.contains("offline"));
    }

    #[test]
    fn pending_approvals_shows_warn() {
        let line = render(&StatusInput {
            engine_healthy: true,
            worker_count: 1,
            agent: "a",
            realm: "r",
            session_active: false,
            pending_approvals: 3,
            hint: "",
        });
        let txt: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(txt.contains("3 approvals pending"));
    }

    #[test]
    fn streaming_shows_when_session_active() {
        let line = render(&StatusInput {
            engine_healthy: true,
            worker_count: 1,
            agent: "a",
            realm: "r",
            session_active: true,
            pending_approvals: 0,
            hint: "",
        });
        let txt: String = line.spans.iter().map(|s| s.content.as_ref()).collect();
        assert!(txt.contains("streaming"));
    }
}
