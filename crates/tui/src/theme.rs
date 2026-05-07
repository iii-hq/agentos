use ratatui::style::{Color, Modifier, Style};

pub const PAPER: Color = Color::Rgb(0xf2, 0xed, 0xe1);
pub const INK: Color = Color::Rgb(0x0c, 0x0b, 0x0a);
pub const MUTED: Color = Color::Rgb(0x6b, 0x66, 0x60);
pub const EMBER: Color = Color::Rgb(0xd9, 0x6e, 0x2e);
#[allow(dead_code)]
pub const RULE: Color = Color::Rgb(0xc8, 0xc1, 0xb4);
pub const OK: Color = Color::Rgb(0x4f, 0x8a, 0x5a);
pub const WARN: Color = Color::Rgb(0xc7, 0x8c, 0x32);
pub const ERR: Color = Color::Rgb(0xb6, 0x3a, 0x2f);

pub fn eyebrow() -> Style {
    Style::default().fg(MUTED).add_modifier(Modifier::DIM)
}

pub fn title() -> Style {
    Style::default().fg(INK).add_modifier(Modifier::BOLD)
}

pub fn accent() -> Style {
    Style::default().fg(EMBER).add_modifier(Modifier::BOLD)
}

pub fn dim() -> Style {
    Style::default().fg(MUTED)
}

pub fn ok() -> Style {
    Style::default().fg(OK)
}

pub fn warn() -> Style {
    Style::default().fg(WARN)
}

pub fn err() -> Style {
    Style::default().fg(ERR)
}
