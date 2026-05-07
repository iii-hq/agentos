use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

use crate::help_overlay::centered_rect;
use crate::slash::fuzzy_match;
use crate::theme;

#[derive(Debug, Clone)]
pub struct PaletteItem {
    pub label: String,
    pub hint: String,
    pub action_key: String,
}

pub fn rank(items: &[PaletteItem], query: &str) -> Vec<(usize, i32)> {
    let mut scored: Vec<(usize, i32)> = items
        .iter()
        .enumerate()
        .filter_map(|(i, it)| fuzzy_match(query, &it.label).map(|s| (i, s)))
        .collect();
    scored.sort_by(|a, b| b.1.cmp(&a.1));
    scored
}

pub fn draw(f: &mut Frame, area: Rect, query: &str, items: &[PaletteItem], selected: usize) {
    let popup = centered_rect(60, 60, area);
    f.render_widget(Clear, popup);

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(3), Constraint::Min(0)])
        .split(popup);

    let input_block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme::accent())
        .title(Span::styled(" Command palette ", theme::title()));
    f.render_widget(
        Paragraph::new(format!("> {}_", query)).block(input_block),
        chunks[0],
    );

    let ranked = rank(items, query);
    let mut lines: Vec<Line> = Vec::new();
    for (rank_idx, (item_idx, _)) in ranked.iter().take(20).enumerate() {
        let item = &items[*item_idx];
        let style = if rank_idx == selected {
            Style::default().bg(theme::EMBER).fg(theme::PAPER).add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };
        lines.push(Line::from(vec![
            Span::styled(format!("  {:<24}", item.label), style),
            Span::styled(format!("  {}", item.hint), theme::dim()),
            Span::styled(format!("    {}", item.action_key), theme::eyebrow()),
        ]));
    }
    if ranked.is_empty() {
        lines.push(Line::from(Span::styled(
            "  No matches.",
            theme::dim(),
        )));
    }

    let list_block = Block::default()
        .borders(Borders::ALL)
        .border_style(theme::dim());
    f.render_widget(Paragraph::new(lines).block(list_block), chunks[1]);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<PaletteItem> {
        vec![
            PaletteItem { label: "Chat".into(), hint: "chat with agent".into(), action_key: "3".into() },
            PaletteItem { label: "Memory".into(), hint: "store + recall".into(), action_key: "m".into() },
            PaletteItem { label: "Approvals".into(), hint: "pending requests".into(), action_key: "9".into() },
        ]
    }

    #[test]
    fn rank_empty_query_returns_all() {
        let r = rank(&sample(), "");
        assert_eq!(r.len(), 3);
    }

    #[test]
    fn rank_filters_by_match() {
        let r = rank(&sample(), "mem");
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].0, 1);
    }

    #[test]
    fn rank_sorts_best_first() {
        let r = rank(&sample(), "a");
        assert!(!r.is_empty());
    }
}
