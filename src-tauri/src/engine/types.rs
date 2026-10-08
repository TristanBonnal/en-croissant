use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Deserialize, Serialize, Debug, Clone, Type, PartialEq, Eq)]
pub struct EngineOption {
    pub name: String,
    pub value: String,
}

#[derive(Deserialize, Serialize, Debug, Clone, Type, PartialEq, Eq)]
#[serde(tag = "t", content = "c")]
pub enum GoMode {
    PlayersTime(PlayersTime),
    Depth(u32),
    Time(u32),
    Nodes(u32),
    Infinite,
}

impl GoMode {
    pub fn to_uci_string(&self) -> String {
        match self {
            GoMode::Depth(d) => format!("go depth {}", d),
            GoMode::Time(t) => format!("go movetime {}", t),
            GoMode::Nodes(n) => format!("go nodes {}", n),
            GoMode::PlayersTime(pt) => {
                format!(
                    "go wtime {} btime {} winc {} binc {}",
                    pt.white, pt.black, pt.winc, pt.binc
                )
            }
            GoMode::Infinite => "go infinite".to_string(),
        }
    }
}

/// `go` command, restricted to `search_moves` (UCI) when there are some.
pub fn go_command(mode: &GoMode, search_moves: &[String]) -> String {
    let cmd = mode.to_uci_string();
    if search_moves.is_empty() {
        cmd
    } else {
        format!("{} searchmoves {}", cmd, search_moves.join(" "))
    }
}

#[derive(Deserialize, Serialize, Debug, Clone, Type, PartialEq, Eq)]
pub struct PlayersTime {
    pub white: u32,
    pub black: u32,
    pub winc: u32,
    pub binc: u32,
}

impl PlayersTime {
    pub fn new(white: u32, black: u32, winc: u32, binc: u32) -> Self {
        Self {
            white,
            black,
            winc,
            binc,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn go_command_without_search_moves() {
        assert_eq!(go_command(&GoMode::Depth(18), &[]), "go depth 18");
    }

    #[test]
    fn go_command_restricted_to_search_moves() {
        assert_eq!(
            go_command(
                &GoMode::Depth(20),
                &["e2e4".to_string(), "d2d4".to_string()]
            ),
            "go depth 20 searchmoves e2e4 d2d4"
        );
    }
}
