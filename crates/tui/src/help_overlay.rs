use ratatui::{
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph, Wrap},
    Frame,
};

use crate::theme;

pub struct KeyBind {
    pub keys: &'static str,
    pub action: &'static str,
}

pub const KEYMAP: &[KeyBind] = &[
    KeyBind { keys: "/", action: "Slash command (/agent, /memory, /worker, ...)" },
    KeyBind { keys: "Enter", action: "Send message / confirm action" },
    KeyBind { keys: "Tab", action: "Autocomplete slash command" },
    KeyBind { keys: "Ctrl+P", action: "Command palette (jump to any pane)" },
    KeyBind { keys: "Ctrl+W", action: "Worker picker (browse + install)" },
    KeyBind { keys: "?", action: "Toggle this help" },
    KeyBind { keys: "Esc", action: "Close overlay / clear input" },
    KeyBind { keys: "Ctrl+L", action: "Clear chat scrollback" },
    KeyBind { keys: "Ctrl+C / q", action: "Quit" },
    KeyBind { keys: "y / n", action: "Approve / deny pending request (in approval modal)" },
    KeyBind { keys: "1-9, 0", action: "Switch to numbered pane (Dashboard, Agents, Chat...)" },
    KeyBind { keys: "j / k", action: "Move down / up in lists (vim)" },
];

pub fn centered_rect(percent_x: u16, percent_y: u16, r: Rect) -> Rect {
    let popup_layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - percent_y) / 2),
            Constraint::Percentage(percent_y),
            Constraint::Percentage((100 - percent_y) / 2),
        ])
        .split(r);

    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - percent_x) / 2),
            Constraint::Percentage(percent_x),
            Constraint::Percentage((100 - percent_x) / 2),
        ])
        .split(popup_layout[1])[1]
}

pub fn draw(f: &mut Frame, area: Rect) {
    let popup = centered_rect(70, 70, area);
    f.render_widget(Clear, popup);

    let mut lines: Vec<Line> = vec![
        Line::from(Span::styled(
            "AGENTOS · KEYMAP",
            theme::eyebrow(),
        )),
        Line::raw(""),
    ];
    for kb in KEYMAP {
        lines.push(Line::from(vec![
            Span::styled(format!("  {:<14}", kb.keys), theme::accent()),
            Span::raw(kb.action.to_string()),
        ]));
    }
    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled(
        "  Press Esc or ? to close.",
        theme::dim(),
    )));

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(theme::EMBER))
        .title(Span::styled(" Help ", Style::default().add_modifier(Modifier::BOLD)));

    f.render_widget(
        Paragraph::new(lines)
            .block(block)
            .alignment(Alignment::Left)
            .wrap(Wrap { trim: false }),
        popup,
    );
}
