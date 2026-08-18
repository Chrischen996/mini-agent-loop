# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-15

### Added

- Workspace skill discovery (`skills/`, `.grok/skills/`, `.claude/skills/`, plus user-level skill dirs) and `MINI_AGENT_SKILLS` activation for CLI, TUI, and Web
- Progressive official-skill loading: catalog metadata first, full `SKILL.md` plus scripts/references only after activation
- TUI `/skill` command and session skill APIs
- Model catalog entries for `xai/grok-4.6`, `google/gemini-3.6-flash`, and `google/gemini-3.7-flash` (plus matching `google-vertex` Flash ids)
- Core agent loop implementation with OpenAI-compatible API support
- Tool system with argument validation and error handling
- Multi-provider model support (OpenAI, DeepSeek, Gemini, Anthropic, etc.)
- Claude-style Hermes response format parsing
- Streaming support with delta-based output
- Context compaction for long conversations
- Image and vision analysis support
- Document attachment handling (PDF, DOCX)
- MCP (Model Context Protocol) tool integration
- Permission mode system (plan/auto/manual/bypass)
- Subagent tool with nested execution support
- Web access tools (search, fetch, source check)
- Git workflow tools (status, diff, branch isolation)
- TUI with Ink.js for terminal interface
- HTTP server with NDJSON streaming
- DeepWiki integration for semantic documentation
- Model selection with fuzzy search
- Relay support for key rotation and load balancing
- Retry strategy with exponential backoff

### Changed

- Migrated from legacy Pi tools to custom implementations
- Unified response contract with typed errors
- Improved error messages and debugging output

### Fixed

- Context overflow handling with automatic compaction
- Tool argument parsing edge cases
- Stream timeout detection
