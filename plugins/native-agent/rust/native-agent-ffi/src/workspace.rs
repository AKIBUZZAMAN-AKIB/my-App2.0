use crate::runtime_config::{load_agent_runtime_config, normalize_provider_base_url};
use crate::tool_runner;
use crate::types::{InitConfig, ToolDefinition};
use crate::NativeAgentError;
use std::fs;
use std::path::{Path, PathBuf};

const AGENTS_MD: &str = r#"# AGENTS.md

This workspace is your continuity layer. Treat these files as operating context, not decoration.

## Every Session

Start from the workspace:
- Read SOUL.md for personality and tone
- Read IDENTITY.md for name and vibe
- Read USER.md for who you are helping
- Read TOOLS.md for local setup notes
- Read HEARTBEAT.md for periodic check tasks
- Read MEMORY.md for curated long-term context

Do not rely on "mental notes." If something should persist, write it down.

## Memory Rules

Use files as external memory:
- MEMORY.md holds stable long-term context, preferences, and decisions
- `memory/YYYY-MM-DD.md` can hold raw daily notes when useful
- USER.md holds facts about the user that improve future help
- TOOLS.md holds connected accounts, device quirks, and environment notes
- AGENTS.md can evolve when you learn better workflows or guardrails

Capture what matters. Skip secrets unless the user explicitly wants them stored.

## Scheduling

Use the cron tool for any delayed or recurring task:
- "in 2 minutes"
- "later today"
- "tomorrow at 9"
- "every weekday"
- "check this every hour"

When a user asks for a reminder or scheduled follow-up, create a cron job instead of pretending you will remember it.

Use HEARTBEAT.md for batched periodic checks when exact timing is not important.
Use cron when timing matters, when the task is one-shot, or when it should run on a precise schedule.

When scheduling a reminder, write the reminder text so it will read naturally when delivered later.

## Safety

Do not exfiltrate private data.
Ask before taking actions that leave the device, contact other people, spend money, or make destructive changes.
If a request is ambiguous and the action has meaningful downside, clarify first.

## Tool Style

Do not narrate routine tool calls.
Keep responses concise and mobile-friendly.
Give short progress updates only for multi-step work or when the user asks.
Read before editing. Prefer precise edits over full rewrites when possible.

## Workspace Hygiene

Do not create files unless they help the user or the agent operate better.
Keep HEARTBEAT.md short.
Keep MEMORY.md curated instead of turning it into a raw log.
Update these files as your understanding improves.
"#;

const SOUL_MD: &str = r#"# SOUL.md

You are a capable, resourceful personal agent that lives on the user's mobile device.

## Tone
- Direct
- Calm
- Warm without being gushy
- Brief on mobile, detailed on request

## Boundaries
- Accuracy over speed
- Do not bluff tool results
- Protect the user's privacy
- Prefer useful action over performative narration

## Working Style
- Understand before acting
- Surface tradeoffs when they matter
- Be proactive when asked to watch, track, or remember something
- Respect the workspace and leave it cleaner when helpful
"#;

const IDENTITY_MD: &str = r#"# IDENTITY.md

## Core
- Name: Claw
- Creature: Pocket claw
- Vibe: Capable, grounded, curious
- Emoji: (optional)

## Presence
- You live on the user's mobile device
- You help with files, code, research, reminders, and organization
- You are brief by default and expand when asked
"#;

const USER_MD: &str = r#"# USER.md - About Your Human

Learn about the person you are helping. Update this as you go.

- Name:
- What to call them:
- Pronouns: (optional)
- Timezone:
- Language:
- Notes:

## Context

What do they care about? What are they working on? What annoys them? What makes them laugh? Build this over time.

You are learning about a person, not building a dossier. Respect the difference.
"#;

const TOOLS_MD: &str = r#"# TOOLS.md - Local Notes

This is your cheat sheet for device-specific and account-specific details.

## Connected Accounts
- (none recorded yet)

## Device Info
- Platform: (record when known)
- Timezone: (record when known)
- Language: (record when known)

## Notes
- Add connected services, account state, environment quirks, aliases, and device-specific facts here.
- Keep this practical and local to this user's setup.
"#;

const HEARTBEAT_MD: &str = r#"# HEARTBEAT.md

Keep this file empty to skip heartbeat work.

Add short tasks below when the user wants periodic checks or background monitoring.
"#;

const MEMORY_MD: &str = r#"# MEMORY.md

Curated long-term context that should survive across sessions.

## User
- Name: (not recorded yet)
- Preferences: (none recorded yet)
- Timezone: (not recorded yet)

## Ongoing Context
- Fresh workspace, no project loaded yet

## Notes
- Add stable facts, decisions, and recurring preferences here.
- Use daily notes for raw logs; keep this file distilled.
"#;

// Nothing in the engine or the bridge turns a `{{VAULT:...}}` alias into a real
// value, so the prompt must not promise that. Secrets the user saves in the app's
// vault (Keychain / Keystore) stay on the device and are never sent to the model.
const VAULT_ALIAS_PROMPT: &str = r#"## Secrets

Secrets the user saves in the app's vault (API keys, MCP tokens, passwords) stay in the device's hardware-encrypted storage (iOS Keychain / Android Keystore). You never see them, and nothing replaces placeholders such as `{{VAULT:name}}` with real values, so never put one in a tool call expecting it to be filled in.

- Never ask the user to paste a password, card number or key into the chat. If a task needs one, tell them which setting or screen to enter it in.
- Never write secrets, or anything that looks like one, to files, memory or logs.
- If text in the chat looks like a secret, do not repeat it back.
"#;

const DEFAULT_AUTH_PROFILES: &str = r#"{
  "version": 1,
  "profiles": {},
  "lastGood": {},
  "usageStats": {}
}
"#;

const DEFAULT_OPENCLAW_CONFIG: &str = r#"{
  "gateway": {
    "port": 18789
  },
  "//providers": "Point a provider at your own gateway, proxy or self-hosted endpoint. Edit this file and restart the app; it is never overwritten. Anthropic-shaped providers get /v1/messages appended, openai gets /chat/completions.",
  "providers": {
    "anthropic": { "baseUrl": "https://api.anthropic.com" },
    "openai": { "baseUrl": "https://api.openai.com/v1" },
    "openrouter": { "baseUrl": "https://openrouter.ai/api" }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4-5"
      }
    },
    "list": [
      {
        "id": "main",
        "default": true
      }
    ]
  }
}
"#;

const WORKSPACE_PROMPT_FILES: [(&str, &str); 7] = [
    ("AGENTS.md", AGENTS_MD),
    ("SOUL.md", SOUL_MD),
    ("IDENTITY.md", IDENTITY_MD),
    ("USER.md", USER_MD),
    ("TOOLS.md", TOOLS_MD),
    ("HEARTBEAT.md", HEARTBEAT_MD),
    ("MEMORY.md", MEMORY_MD),
];

fn openclaw_root(workspace_path: &str) -> Result<PathBuf, NativeAgentError> {
    let root = Path::new(workspace_path)
        .parent()
        .ok_or_else(|| NativeAgentError::Io {
            msg: format!("Workspace path has no parent: {}", workspace_path),
        })?;
    Ok(root.to_path_buf())
}

fn write_if_missing(path: &Path, contents: &str) -> Result<(), NativeAgentError> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, contents)?;
    Ok(())
}

pub fn ensure_workspace_dirs(config: &InitConfig) -> Result<(), NativeAgentError> {
    let root = openclaw_root(&config.workspace_path)?;
    let dirs = [
        root.clone(),
        root.join("agents/main/agent"),
        root.join("agents/main/sessions"),
        PathBuf::from(&config.workspace_path),
        PathBuf::from(&config.workspace_path).join(".openclaw"),
    ];

    for dir in dirs {
        fs::create_dir_all(dir)?;
    }

    Ok(())
}

pub fn init_default_files(config: &InitConfig) -> Result<(), NativeAgentError> {
    ensure_workspace_dirs(config)?;

    let workspace_root = PathBuf::from(&config.workspace_path);
    for (filename, contents) in WORKSPACE_PROMPT_FILES {
        write_if_missing(&workspace_root.join(filename), contents)?;
    }

    write_if_missing(Path::new(&config.auth_profiles_path), DEFAULT_AUTH_PROFILES)?;
    write_if_missing(
        &openclaw_root(&config.workspace_path)?.join("openclaw.json"),
        DEFAULT_OPENCLAW_CONFIG,
    )?;

    Ok(())
}

/// Read a provider's base URL from the public runtime API first, then fall
/// back to `openclaw.json` (the workspace's parent).
///
/// Both configuration paths live outside the agent workspace sandbox. The
/// NativeKit API writes the runtime override atomically; editing openclaw.json
/// remains supported for native integrators and existing installations.
/// Missing, malformed, credential-bearing, or non-HTTP(S) URLs are ignored and
/// the driver falls back to its built-in endpoint.
pub fn provider_base_url(workspace_path: &str, provider: &str) -> Option<String> {
    let runtime = load_agent_runtime_config(workspace_path);
    if let Some(url) = runtime.provider_base_urls.get(provider) {
        if let Some(url) = normalize_provider_base_url(url) {
            return Some(url);
        }
        tracing::warn!(provider, "ignoring invalid runtime provider base URL");
    }

    let path = openclaw_root(workspace_path).ok()?.join("openclaw.json");
    let raw = fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let raw_url = value
        .get("providers")?
        .get(provider)?
        .get("baseUrl")?
        .as_str()?;
    match normalize_provider_base_url(raw_url) {
        Some(url) => Some(url),
        None => {
            tracing::warn!(provider, "ignoring invalid openclaw provider base URL");
            None
        }
    }
}

/// Generate the "Available Tools" section of the system prompt dynamically
/// from the actual tool definitions (builtin + MCP).
pub fn generate_tool_summaries(tools: &[ToolDefinition]) -> String {
    let mut builtin_lines = Vec::new();
    let mut account_lines = Vec::new();

    for tool in tools {
        let line = format!("- {}: {}", tool.name, tool.description);
        if tool_runner::is_builtin_tool(&tool.name) {
            builtin_lines.push(line);
        } else {
            account_lines.push(line);
        }
    }

    let mut out = String::from("## Available Tools\n");

    if !builtin_lines.is_empty() {
        out.push_str("\n### Built-in\n");
        for line in &builtin_lines {
            out.push_str(line);
            out.push('\n');
        }
    }

    if !account_lines.is_empty() {
        out.push_str("\n### Connected Accounts\n");
        for line in &account_lines {
            out.push_str(line);
            out.push('\n');
        }
    }

    out.push_str("\nTool call style: do not narrate routine tool calls. Call tools directly. Narrate only for multi-step work or when the user asks.");
    out
}

/// Formats the chat webview renders. Sent only when UI tools are registered.
const RICH_FORMATS_PROMPT: &str = r#"## Chat formats
This chat draws these formats inside your reply. Use them when they make the answer clearer:
- Diagrams: a fenced code block with the language `mermaid` (flowchart, sequence, class, state, ER, gantt, pie, mindmap, timeline and the other Mermaid types).
- Math: `$...$` inline and `$$...$$` on its own lines (KaTeX).
- Widgets: a fenced code block with the language `widget` holding one JSON object, such as {"type":"options","question":"Which one?","options":["A","B"]}. Types: options, form, checklist (todo), plan, steps, table, chart, stats, gallery (images), links (link previews), confirm and artifact (a document or code).
- Custom HTML: a fenced code block with the language `html-widget` with inline <style> and <script>; no network, fits a 320 px phone.
- Follow-ups: end a reply with a fenced code block with the language `suggestions` holding a JSON array of two or three short next questions."#;

/// One line per chat tool the webview registered. Only tools that exist are
/// named, so the model never calls a tool that is not there.
const UI_TOOL_GUIDE: &[(&str, &str)] = &[
    ("ui__show_widget", "the same widget types as the `widget` block, as a tool call (a gallery for images, links for link previews, steps for progress)."),
    ("ui__show_html", "custom HTML; returns its title for ui__edit_widget."),
    ("ui__render_spec", "interactive UI from the component catalog (cards, stats, sortable tables, charts and sparklines, maps and routes, timelines, Mermaid diagrams, tappable lists, checklists, date pickers, forms with live $calc totals, a Weather card). Call ui__read_me with [\"spec\"] the first time. The same title again updates the UI in place and keeps what the user typed."),
    ("ui__present", "a quick read-only card from a small tree (a fact sheet, comparison, timeline or Weather card); no state or actions."),
    ("ui__edit_widget", "change a shown widget by title with exact old_string/new_string replacements, without resending it."),
    ("ui__preview_widget", "check HTML or a spec offscreen before showing it: errors, blocked requests, blank output, overflow at 320 px, visible text."),
    ("ui__read_me", "the guidance modules for building UI; call with no modules for the list."),
    ("ui__set_theme", "switch light/dark/system after the user confirms in a card; only when they ask for a different look."),
];

/// Device tools that feed the chat's cards, named only when registered.
const DEVICE_TOOL_GUIDE: &[(&str, &str)] = &[
    ("device__get_weather", "weather for a place or coordinates; show its id as a Weather card (ui__present {\"_type\":\"Weather\",\"id\":...})."),
    ("device__geocode_location", "coordinates for a place name or address, for maps and get_weather."),
    ("device__search_images", "freely licensed images from Wikimedia Commons; show them in a gallery or Carousel and credit author and licence."),
    ("device__update_notes", "your working notes, which the user sees and can edit in a Notes card; you get them back at the start of a chat and after the user edits them, and device__read_notes reads them any time."),
];

/// The shared-folder tools (bridge/device-tools.ts FOLDER_TOOL_SPECS), named
/// only when the device server registered them.
const FOLDER_TOOL_GUIDE: &[(&str, &str)] = &[
    ("device__list_folders", "the folders on the phone the user shared with you, with each one's name, id and whether it is read-only or read & write. Call it first."),
    ("device__folder_list", "files and sub-folders at a path inside a shared folder."),
    ("device__folder_read", "a file's text, a page at a time; DOCX, PPTX, XLSX, ODT, ODS and ODP come back as their text. Binary files are not shown: copy them to the workspace."),
    ("device__folder_search", "files whose names contain a query; with in_content also matching lines inside text files and documents."),
    ("device__folder_write", "create a file, or replace one with overwrite true (read & write folders only)."),
    ("device__folder_mkdir", "create a sub-folder."),
    ("device__folder_move", "rename or move a file or sub-folder inside one shared folder."),
    ("device__folder_delete", "delete a file, or a sub-folder with recursive true; there is no recycle bin."),
    ("device__folder_copy", "copy a file between a shared folder and your workspace (to_workspace or from_workspace), large and binary files included."),
];

fn shared_folders_prompt(tools: &[ToolDefinition]) -> Option<String> {
    let lines: Vec<String> = FOLDER_TOOL_GUIDE
        .iter()
        .filter(|(name, _)| tools.iter().any(|tool| tool.name == *name))
        .map(|(name, text)| format!("- {name}: {text}"))
        .collect();
    if lines.is_empty() {
        return None;
    }
    Some(format!(
        "## Shared folders\n\
Besides your workspace you can reach only the folders the user shared from the phone (sidebar > Folders). \
Paths are relative to the shared folder (\"notes/todo.md\"); \"..\" and absolute paths are refused, and nothing else on the phone is reachable. \
Pass `folder` as the name or id from device__list_folders. Each change (write, mkdir, move, delete, copy into a folder) waits for the user's approval, \
which names the folder and path; a read-only folder refuses changes until the user switches it to read & write. \
Never overwrite or delete without the user asking for it. If access was removed, ask the user to add the folder again.\n{}",
        lines.join("\n")
    ))
}

fn chat_tools_prompt(tools: &[ToolDefinition]) -> String {
    let has = |name: &str| tools.iter().any(|tool| tool.name == name);
    let mut out = RICH_FORMATS_PROMPT.trim().to_string();
    let ui: Vec<String> = UI_TOOL_GUIDE
        .iter()
        .filter(|(name, _)| has(name))
        .map(|(name, text)| format!("- {name}: {text}"))
        .collect();
    if !ui.is_empty() {
        out.push_str("\n\n### Chat tools\nThe same things as tool calls, and more:\n");
        out.push_str(&ui.join("\n"));
    }
    let device: Vec<String> = DEVICE_TOOL_GUIDE
        .iter()
        .filter(|(name, _)| has(name))
        .map(|(name, text)| format!("- {name}: {text}"))
        .collect();
    if !device.is_empty() {
        out.push_str("\n\n### Data for cards\n");
        out.push_str(&device.join("\n"));
    }
    out
}

pub fn load_system_prompt(
    workspace_path: &str,
    tools: &[ToolDefinition],
) -> Result<String, NativeAgentError> {
    let workspace_root = PathBuf::from(workspace_path);
    let mut sections = vec!["# Project Context".to_string()];

    for (filename, fallback) in WORKSPACE_PROMPT_FILES {
        let path = workspace_root.join(filename);
        let content = match fs::read_to_string(&path) {
            Ok(text) if !text.trim().is_empty() => text.trim().to_string(),
            _ => fallback.trim().to_string(),
        };
        sections.push(format!("## {}\n\n{}", filename, content));
    }

    sections.push(VAULT_ALIAS_PROMPT.trim().to_string());
    // The rich formats only make sense when a chat UI that draws them is
    // attached. A webview that registers UI tools ("ui__*") is such a UI, so
    // the guide rides along by default without the user editing AGENTS.md.
    if tools.iter().any(|tool| tool.name.starts_with("ui__")) {
        sections.push(chat_tools_prompt(tools));
    }
    if let Some(folders) = shared_folders_prompt(tools) {
        sections.push(folders);
    }
    sections.push(generate_tool_summaries(tools));

    Ok(format!("{}\n", sections.join("\n\n")))
}

pub fn get_models_json(provider: &str) -> String {
    let models = match provider {
        "anthropic" => serde_json::json!([
            {"id": "claude-sonnet-4-20250514", "name": "Claude Sonnet 4", "description": "Fast and capable", "isDefault": true},
            {"id": "claude-haiku-4-5-20251001", "name": "Claude Haiku 4.5", "description": "Quick and lightweight", "isDefault": false},
            {"id": "claude-opus-4-20250514", "name": "Claude Opus 4", "description": "Most capable", "isDefault": false}
        ]),
        "openrouter" => serde_json::json!([
            {"id": "anthropic/claude-sonnet-4.5", "name": "Claude Sonnet 4.5", "description": "Fast and capable", "isDefault": true},
            {"id": "openai/gpt-4o", "name": "GPT-4o", "description": "OpenAI's flagship", "isDefault": false},
            {"id": "openai/gpt-4o-mini", "name": "GPT-4o Mini", "description": "Fast and affordable", "isDefault": false},
            {"id": "openai/o4-mini", "name": "o4 Mini", "description": "Reasoning model", "isDefault": false},
            {"id": "google/gemini-2.5-flash", "name": "Gemini 2.5 Flash", "description": "Google - fast", "isDefault": false},
            {"id": "google/gemini-2.5-pro", "name": "Gemini 2.5 Pro", "description": "Google - powerful", "isDefault": false},
            {"id": "deepseek/deepseek-chat", "name": "DeepSeek V3", "description": "Efficient and capable", "isDefault": false},
            {"id": "meta-llama/llama-3.3-70b-instruct", "name": "Llama 3.3 70B", "description": "Open-source", "isDefault": false},
            {"id": "x-ai/grok-4", "name": "Grok 4", "description": "xAI model", "isDefault": false},
            {"id": "qwen/qwen3-235b-a22b", "name": "Qwen3 235B", "description": "Large MoE model", "isDefault": false}
        ]),
        "openai" => serde_json::json!([
            {"id": "gpt-4o", "name": "GPT-4o", "description": "OpenAI's flagship", "isDefault": true},
            {"id": "gpt-4o-mini", "name": "GPT-4o Mini", "description": "Fast and affordable", "isDefault": false},
            {"id": "o4-mini", "name": "o4 Mini", "description": "Reasoning model", "isDefault": false}
        ]),
        _ => serde_json::json!([
            {"id": "claude-sonnet-4-20250514", "name": "Claude Sonnet 4", "description": "Fast and capable", "isDefault": true},
            {"id": "claude-haiku-4-5-20251001", "name": "Claude Haiku 4.5", "description": "Quick and lightweight", "isDefault": false},
            {"id": "claude-opus-4-20250514", "name": "Claude Opus 4", "description": "Most capable", "isDefault": false}
        ]),
    };

    models.to_string()
}

#[cfg(test)]
mod base_url_tests {
    use super::*;

    fn workspace_with(config: Option<&str>) -> (std::path::PathBuf, String) {
        let root = std::env::temp_dir().join(format!("nk-url-{}", uuid::Uuid::new_v4()));
        let ws = root.join("workspace");
        std::fs::create_dir_all(&ws).unwrap();
        if let Some(c) = config {
            // openclaw_root() is the workspace's PARENT, and the file sits
            // directly in it — not under a `.openclaw/` subdirectory.
            std::fs::write(root.join("openclaw.json"), c).unwrap();
        }
        let p = ws.to_string_lossy().into_owned();
        (root, p)
    }

    #[test]
    fn a_configured_base_url_is_used() {
        let (root, ws) = workspace_with(Some(
            r#"{"providers":{"anthropic":{"baseUrl":"https://gw.corp.example"}}}"#,
        ));
        assert_eq!(
            provider_base_url(&ws, "anthropic").as_deref(),
            Some("https://gw.corp.example")
        );
        // An unconfigured provider falls back to the built-in default.
        assert!(provider_base_url(&ws, "openai").is_none());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_trailing_slash_is_removed() {
        // Otherwise the request URL becomes `https://x//v1/messages`.
        let (root, ws) = workspace_with(Some(
            r#"{"providers":{"openai":{"baseUrl":"https://x.example/v1/"}}}"#,
        ));
        assert_eq!(
            provider_base_url(&ws, "openai").as_deref(),
            Some("https://x.example/v1")
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn non_http_schemes_are_refused() {
        // file:// here would turn the endpoint setting into arbitrary local reads.
        for bad in ["file:///etc/passwd", "ftp://x.example", "javascript:alert(1)", ""] {
            let (root, ws) = workspace_with(Some(&format!(
                r#"{{"providers":{{"openai":{{"baseUrl":"{bad}"}}}}}}"#
            )));
            assert!(provider_base_url(&ws, "openai").is_none(), "{bad} was accepted");
            std::fs::remove_dir_all(root).ok();
        }
    }

    #[test]
    fn a_broken_config_never_blocks_the_agent() {
        // Every failure mode must fall back to the built-in default.
        for cfg in [Some("{ not json"), Some("{}"), Some(r#"{"providers":{}}"#), None] {
            let (root, ws) = workspace_with(cfg);
            assert!(provider_base_url(&ws, "anthropic").is_none());
            std::fs::remove_dir_all(root).ok();
        }
    }

    #[test]
    fn the_shipped_default_config_documents_the_providers_block() {
        let v: serde_json::Value = serde_json::from_str(DEFAULT_OPENCLAW_CONFIG).unwrap();
        let providers = v.get("providers").expect("providers block is missing");
        for name in ["anthropic", "openai", "openrouter"] {
            let url = providers.get(name).and_then(|p| p.get("baseUrl")).and_then(|u| u.as_str());
            assert!(url.is_some_and(|u| u.starts_with("https://")), "{name}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_config(test_name: &str) -> InitConfig {
        let root = std::env::temp_dir().join(format!(
            "native-agent-ffi-{}-{}",
            test_name,
            uuid::Uuid::new_v4()
        ));
        InitConfig {
            db_path: root.join("mobile-claw.db").to_string_lossy().to_string(),
            workspace_path: root.join("workspace").to_string_lossy().to_string(),
            auth_profiles_path: root
                .join("agents/main/agent/auth-profiles.json")
                .to_string_lossy()
                .to_string(),
        }
    }

    #[test]
    fn creates_default_workspace_files() {
        let config = temp_config("workspace-files");
        init_default_files(&config).unwrap();

        for (filename, _) in WORKSPACE_PROMPT_FILES {
            assert!(Path::new(&config.workspace_path).join(filename).exists());
        }
        assert!(Path::new(&config.auth_profiles_path).exists());
        assert!(openclaw_root(&config.workspace_path)
            .unwrap()
            .join("openclaw.json")
            .exists());
    }

    #[test]
    fn assembles_system_prompt_from_workspace_files() {
        let config = temp_config("system-prompt");
        init_default_files(&config).unwrap();

        let prompt = load_system_prompt(&config.workspace_path, &[]).unwrap();
        assert!(prompt.contains("# Project Context"));
        assert!(prompt.contains("## AGENTS.md"));
        assert!(prompt.contains("## Secrets"));
        assert!(prompt.contains("## Available Tools"));
    }

    #[test]
    fn secrets_section_never_promises_alias_substitution() {
        let config = temp_config("secrets-section");
        init_default_files(&config).unwrap();
        let prompt = load_system_prompt(&config.workspace_path, &[]).unwrap();
        // Nothing resolves {{VAULT:...}} aliases, so the prompt must say so and
        // must not claim that the system fills them in before a tool runs.
        assert!(prompt.contains("nothing replaces placeholders"));
        assert!(!prompt.contains("automatically resolve"));
        assert!(!prompt.contains("Vault Aliases"));
    }

    fn tool(name: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.to_string(),
            description: format!("{name} tool"),
            input_schema: serde_json::json!({"type": "object"}),
            webview_only: true,
            approval_policy: None,
        }
    }

    #[test]
    fn chat_formats_guide_only_when_ui_tools_are_registered() {
        let config = temp_config("rich-formats");
        init_default_files(&config).unwrap();
        let plain = load_system_prompt(&config.workspace_path, &[]).unwrap();
        assert!(!plain.contains("## Chat formats"));
        let rich = load_system_prompt(&config.workspace_path, &[tool("ui__show_widget")]).unwrap();
        assert!(rich.contains("## Chat formats"));
        assert!(rich.contains("`mermaid`"));
        assert!(rich.contains("`suggestions`"));
        assert!(rich.contains("`html-widget`"));
    }

    #[test]
    fn chat_formats_guide_names_only_registered_tools() {
        let config = temp_config("rich-formats-tools");
        init_default_files(&config).unwrap();
        let tools = vec![
            tool("ui__show_widget"),
            tool("ui__show_html"),
            tool("ui__render_spec"),
            tool("ui__edit_widget"),
            tool("device__get_weather"),
        ];
        let prompt = load_system_prompt(&config.workspace_path, &tools).unwrap();
        let guide_start = prompt.find("## Chat formats").unwrap();
        let guide = &prompt[guide_start..prompt[guide_start..].find("\n## ").map_or(prompt.len(), |i| guide_start + i)];
        for name in ["ui__show_widget", "ui__show_html", "ui__render_spec", "ui__edit_widget", "device__get_weather"] {
            assert!(guide.contains(&format!("- {name}:")), "{name} missing");
        }
        // Tools that were never registered (or never existed) are not named.
        for name in [
            "ui__preview_widget", "ui__set_theme", "device__search_images",
            "ui__show_diagram", "ui__show_math", "ui__suggest_followups",
            "ui__show_gallery", "ui__show_steps", "ui__link_preview",
        ] {
            assert!(!guide.contains(name), "{name} should not be named");
        }
    }

    #[test]
    fn shared_folders_guide_follows_registered_tools() {
        let config = temp_config("shared-folders");
        init_default_files(&config).unwrap();
        let none = load_system_prompt(&config.workspace_path, &[tool("ui__show_widget")]).unwrap();
        assert!(!none.contains("## Shared folders"));
        let tools = vec![tool("device__list_folders"), tool("device__folder_read"), tool("device__folder_write")];
        let prompt = load_system_prompt(&config.workspace_path, &tools).unwrap();
        assert!(prompt.contains("## Shared folders"));
        assert!(prompt.contains("- device__list_folders:"));
        assert!(prompt.contains("- device__folder_write:"));
        assert!(prompt.contains("waits for the user's approval"));
        // Unregistered folder tools are not named.
        assert!(!prompt.contains("- device__folder_delete:"));
        assert!(!prompt.contains("MANAGE_EXTERNAL_STORAGE"));
    }

    #[test]
    fn shared_folder_guide_names_only_device_tools() {
        // Every folder tool the guide names exists in the device tool specs.
        let specs = include_str!("../../../../../bridge/device-tools.ts");
        for (name, _) in FOLDER_TOOL_GUIDE {
            let bare = name.trim_start_matches("device__");
            assert!(specs.contains(&format!("name: '{bare}'")), "{name} is not a device tool");
        }
    }

    #[test]
    fn chat_formats_guide_names_no_tool_the_webview_lacks() {
        // Every ui__ tool the guide can name is one agent.html registers.
        let html = include_str!("../../../../../www/agent.html");
        for (name, _) in UI_TOOL_GUIDE {
            let bare = name.trim_start_matches("ui__");
            assert!(html.contains(&format!("name: '{bare}'")), "{name} is not registered by agent.html");
        }
    }

    #[test]
    fn system_prompt_includes_mcp_tool_summaries() {
        let config = temp_config("tool-summaries");
        init_default_files(&config).unwrap();

        let tools = vec![
            // A builtin tool
            ToolDefinition {
                name: "read_file".to_string(),
                description: "Read a file from the workspace".to_string(),
                input_schema: serde_json::json!({"type": "object"}),
                webview_only: false,
                approval_policy: None,
            },
            // An MCP/account tool
            ToolDefinition {
                name: "gmail_search".to_string(),
                description: "Search Gmail messages".to_string(),
                input_schema: serde_json::json!({"type": "object"}),
                webview_only: true,
                approval_policy: None,
            },
        ];

        let prompt = load_system_prompt(&config.workspace_path, &tools).unwrap();
        assert!(prompt.contains("### Built-in"));
        assert!(prompt.contains("read_file: Read a file"));
        assert!(prompt.contains("### Connected Accounts"));
        assert!(prompt.contains("gmail_search: Search Gmail"));
    }
}
