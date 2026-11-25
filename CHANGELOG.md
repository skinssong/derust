# Changelog

All notable changes to Derust are recorded here.

## [0.10.0] — 2026-11-25

Derust now explains a project as well as a file, in one panel. This release adds
the crate-level project view, unifies the two webviews, and starts the AI work
when a view opens.

### Added

- **Project view.** A crate-level opening line, a flow diagram of one normal run
  (stages, decisions, labelled branches and loops), and a suggested reading
  order for that run. Flow stages name the module that does the work and open it
  in the editor when clicked.
- **One Derust panel.** Project and File are modes of a single webview, with a
  `Project / File` switch in the header. Switching keeps the header position and
  restores each view's scroll.
- **Automatic analysis.** The project view draws the flow and plans the reading
  order together, then writes the opening line from the flow. The file view
  starts Read & Analyze, running the module reading and the full analysis in
  parallel. Cached results are reused.
- **Provider setup inside VS Code.** The first AI request asks for the base URL,
  model and API key. The new **Derust: Configure Provider** command reopens the
  prompt.
- **Code-only project identity.** The opening line and the project facts are
  derived from comment-free source and the generated flow, never from comments.
  The prompt was tuned against five real crates (fd, miniserve, anyhow,
  cargo-watch, joshuto) so it stays project-agnostic.
- **`derust.autoAnalyze`** (default on) controls automatic Read & Analyze for a
  file view.

### Changed

- **Read & Analyze** no longer waits for a button: it starts when the file view
  opens, with the module reading and Spotlights/Ownership in parallel. The
  button forces a fresh run.
- **Analyze Architecture** opens the project view and starts the flow and
  reading order; the pane buttons redraw or replan on demand.
- The project view follows the VS Code theme, and the header keeps its position
  and width across Project/File switches.
- The opening line is written from the flow's stages and transitions.
- Provider settings are configured in VS Code settings plus SecretStorage.
- Rebranded and republished as **Derust**, with a new icon, repository metadata
  and refreshed README screenshots.


### Fixed

- Flow, reading and opening-line responses that came back as prose, truncated
  JSON or no JSON are repaired and retried, with finish-reason and response
  diagnostics in Output → Derust.
- The opening line repaints when a flow arrives; the flow and reading panes show
  their drawing/planning state immediately.
- Duplicate flow or reading runs are prevented, provider setup is shared by
  concurrent requests, and cache writes use unique temporary files.
- The file view replays its analysis, reading, status and lens when switching
  back from the project view.
- The **File** tab is disabled until a file is available, and becomes enabled as
  Rust editors open.
- Provider requests report empty or truncated responses clearly instead of
  failing silently.
- Auto analysis also starts when the file view opens from a cached analysis, not
  only when it is built from source.

### Internal

- Architecture, flow and reading caches are versioned. The VSIX no longer bundles
  Cytoscape.js or elkjs; the earlier architecture-map prototype is not part of
  this release. Design research, upstream snapshots and showcase data stay out of
  the public package.
- Tests cover the architecture model, comment blanking, flow and reading parsing,
  the opening-line prompt input, and panel markup (68 tests).
