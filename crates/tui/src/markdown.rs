use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};

use crate::theme;

pub fn render(body: &str) -> Vec<Line<'static>> {
    let mut out: Vec<Line<'static>> = Vec::new();
    let mut in_code = false;

    for raw in body.split('\n') {
        let line = raw.to_string();

        if let Some(rest) = line.strip_prefix("```") {
            in_code = !in_code;
            let lang = if in_code { rest.trim().to_string() } else { String::new() };
            out.push(Line::from(Span::styled(
                if in_code {
                    format!("┌─ {}", if lang.is_empty() { "code" } else { lang.as_str() })
                } else {
                    "└─".to_string()
                },
                Style::default().fg(theme::MUTED),
            )));
            continue;
        }

        if in_code {
            out.push(Line::from(Span::styled(
                format!("│ {}", line),
                Style::default().fg(Color::Rgb(0x33, 0x52, 0x74)),
            )));
            continue;
        }

        if let Some(rest) = line.strip_prefix("# ") {
            out.push(Line::from(Span::styled(
                rest.to_string(),
                Style::default().fg(theme::INK).add_modifier(Modifier::BOLD),
            )));
            continue;
        }
        if let Some(rest) = line.strip_prefix("## ") {
            out.push(Line::from(Span::styled(
                rest.to_string(),
                Style::default().fg(theme::EMBER).add_modifier(Modifier::BOLD),
            )));
            continue;
        }
        if let Some(rest) = line.strip_prefix("### ") {
            out.push(Line::from(Span::styled(
                rest.to_string(),
                Style::default().fg(theme::INK).add_modifier(Modifier::BOLD),
            )));
            continue;
        }
        if let Some(rest) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
            out.push(Line::from(vec![
                Span::styled("  • ", Style::default().fg(theme::EMBER)),
                Span::raw(rest.to_string()),
            ]));
            continue;
        }
        if line.starts_with("> ") {
            out.push(Line::from(vec![
                Span::styled("│ ", Style::default().fg(theme::MUTED)),
                Span::styled(
                    line[2..].to_string(),
                    Style::default().fg(theme::MUTED).add_modifier(Modifier::ITALIC),
                ),
            ]));
            continue;
        }

        out.push(render_inline(&line));
    }
    out
}

fn render_inline(line: &str) -> Line<'static> {
    let mut spans: Vec<Span<'static>> = Vec::new();
    let mut buf = String::new();
    let mut chars = line.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '`' {
            if !buf.is_empty() {
                spans.push(Span::raw(std::mem::take(&mut buf)));
            }
            let mut code = String::new();
            for cc in chars.by_ref() {
                if cc == '`' { break; }
                code.push(cc);
            }
            spans.push(Span::styled(
                code,
                Style::default().fg(Color::Rgb(0x33, 0x52, 0x74)).add_modifier(Modifier::BOLD),
            ));
        } else if c == '*' && chars.peek() == Some(&'*') {
            chars.next();
            if !buf.is_empty() {
                spans.push(Span::raw(std::mem::take(&mut buf)));
            }
            let mut bold = String::new();
            while let Some(&cc) = chars.peek() {
                chars.next();
                if cc == '*' && chars.peek() == Some(&'*') {
                    chars.next();
                    break;
                }
                bold.push(cc);
            }
            spans.push(Span::styled(
                bold,
                Style::default().add_modifier(Modifier::BOLD),
            ));
        } else {
            buf.push(c);
        }
    }
    if !buf.is_empty() {
        spans.push(Span::raw(buf));
    }
    if spans.is_empty() {
        spans.push(Span::raw(String::new()));
    }
    Line::from(spans)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_line_passes_through() {
        let out = render("hello world");
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn h1_styled() {
        let out = render("# Title");
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn fenced_code_wraps_in_borders() {
        let out = render("```rust\nfn main() {}\n```");
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn bullet_renders() {
        let out = render("- item one");
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn inline_code_splits_spans() {
        let line = render_inline("call `foo()` now");
        assert!(line.spans.len() >= 3);
    }

    #[test]
    fn bold_inline() {
        let line = render_inline("**hi** there");
        assert!(line.spans.len() >= 2);
    }
}
