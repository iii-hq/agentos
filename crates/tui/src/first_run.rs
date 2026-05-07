use ratatui::{
    layout::Rect,
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
    Frame,
};

use crate::help_overlay::centered_rect;
use crate::theme;

#[derive(Debug, Clone, PartialEq)]
pub enum HealthState {
    EngineDown,
    EngineUpNoWorkers,
    Ready,
}

pub fn detect(engine_healthy: bool, worker_count: usize) -> HealthState {
    if !engine_healthy {
        HealthState::EngineDown
    } else if worker_count == 0 {
        HealthState::EngineUpNoWorkers
    } else {
        HealthState::Ready
    }
}

pub fn draw_engine_down(f: &mut Frame, area: Rect) {
    let popup = centered_rect(70, 60, area);
    f.render_widget(Clear, popup);

    let lines: Vec<Line> = vec![
        Line::from(Span::styled("AGENTOS · WELCOME", theme::eyebrow())),
        Line::raw(""),
        Line::from(Span::styled(
            "Engine is offline. Boot it in another terminal:",
            theme::title(),
        )),
        Line::raw(""),
        Line::from(Span::styled(
            "  1.  Install the iii engine binary",
            theme::dim(),
        )),
        Line::from(Span::styled(
            "      curl -fsSL https://install.iii.dev/iii/main/install.sh | sh",
            theme::accent(),
        )),
        Line::raw(""),
        Line::from(Span::styled("  2.  Set your model key", theme::dim())),
        Line::from(Span::styled(
            "      export ANTHROPIC_API_KEY=sk-ant-...",
            theme::accent(),
        )),
        Line::raw(""),
        Line::from(Span::styled("  3.  Start the engine", theme::dim())),
        Line::from(Span::styled(
            "      iii --config config.yaml",
            theme::accent(),
        )),
        Line::raw(""),
        Line::from(Span::styled("  4.  Spawn workers", theme::dim())),
        Line::from(Span::styled(
            "      bash scripts/dev-up.sh",
            theme::accent(),
        )),
        Line::raw(""),
        Line::from(Span::styled(
            "  TUI will detect the engine the moment it comes up.",
            theme::dim(),
        )),
        Line::raw(""),
        Line::from(Span::styled(
            "  Press q to quit · ? for keymap",
            theme::dim(),
        )),
    ];

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme::accent())
        .title(Span::styled(" First run ", theme::title()));

    f.render_widget(
        Paragraph::new(lines).block(block).wrap(Wrap { trim: false }),
        popup,
    );
}

pub fn draw_no_workers(f: &mut Frame, area: Rect) {
    let popup = centered_rect(70, 50, area);
    f.render_widget(Clear, popup);

    let lines: Vec<Line> = vec![
        Line::from(Span::styled("AGENTOS · NO WORKERS", theme::eyebrow())),
        Line::raw(""),
        Line::from(Span::styled(
            "Engine is up, but no workers are connected.",
            theme::title(),
        )),
        Line::raw(""),
        Line::from(Span::styled(
            "  Spawn the default 65-worker stack:",
            theme::dim(),
        )),
        Line::from(Span::styled(
            "    bash scripts/dev-up.sh",
            theme::accent(),
        )),
        Line::raw(""),
        Line::from(Span::styled(
            "  Or browse + install one at a time:",
            theme::dim(),
        )),
        Line::from(Span::styled(
            "    Press Ctrl+W for the worker picker",
            theme::accent(),
        )),
        Line::raw(""),
        Line::from(Span::styled(
            "  Press Esc to dismiss · ? for keymap",
            theme::dim(),
        )),
    ];

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme::accent())
        .title(Span::styled(" Almost there ", theme::title()));

    f.render_widget(
        Paragraph::new(lines).block(block).wrap(Wrap { trim: false }),
        popup,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_engine_down() {
        assert_eq!(detect(false, 0), HealthState::EngineDown);
        assert_eq!(detect(false, 99), HealthState::EngineDown);
    }

    #[test]
    fn detects_no_workers() {
        assert_eq!(detect(true, 0), HealthState::EngineUpNoWorkers);
    }

    #[test]
    fn detects_ready() {
        assert_eq!(detect(true, 1), HealthState::Ready);
    }
}
