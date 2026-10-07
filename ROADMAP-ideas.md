# Pascal 3D Editor — improvement & development roadmap

Where the product is now: solid parametric core (rooms, walls, openings, roofs, stairs), an agent surface with real design intelligence (facing, clearance, `review_layout`, schedules, takeoff), provider-auth vision tools, and a local+hosted split that mostly works. Below is everything worth building next, grouped by theme. Rough effort tags: S (days), M (1–2 Devin sessions), L (a week+).

---

## 1. AI design intelligence — the biggest differentiator

Already shipped: `facing`, `orient_item`, `review_layout`, `furnish_room`, `walkthrough_to_room`, provider auth, `generate_schedule`, `materials_takeoff`.

- **Text → apartment/house brief → full model** (M–L). "2-bed flat, 85 m², open kitchen, south balcony" → shell + rooms + openings + furniture + review + schedule in one shot. Exists partially as `create_house_from_brief`; deepen into a proper brief language (adjacency requirements, orientation, room sizes) and iterate with `generate_variants`.
- **Layout solver / constraint programming** (L). `furnish_room` is heuristic; a real solver (circulation graph, clearance polygons, adjacency weights, door/window daylight) would place furniture provably well. Feeds `review_layout` with numeric scores, not just violations.
- **`improve_layout` auto-fix** (M). `review_layout` reports; a companion op applies the top fixes itself (rotate the chair, pull the sofa off the radiator, open the walkway). Each fix is an edit with a diff report.
- **Room-type-specific furniture rules** (M). Bathroom/kitchen/office/bedroom fixture templates per region (EN/HU norms are a natural fit for ARCHLine-style depth): work triangle for kitchens, min distances WC↔basin↔shower, ergonomic desk↔window orientation.
- **Daylight & views analysis** (M). Compute window area per room vs floor area (min 1/10 rules), view cones from seating, shading from neighbors. Read-only audit tool + furnish scoring input.
- **Generative variants that actually differ** (M). `generate_variants` exists; make variants *diverse by design intent* (compact / open / family / accessible) and auto-review each, returning the best + diffs.
- **Style/material palettes** (S–M). `apply_style` — swap finishes/materials by name (Scandinavian, Japandi, industrial) across zones using the materialPreset fields.
- **Cost / furnishing budget estimate** (S). Takeoff already exists; add per-item price metadata + a `cost_estimate` read (region-aware presets).
- **Acoustics/thermal heuristics** (M). Hard surfaces ratio, window U-values on wall materials — ARCHLine-adjacent audit outputs.
- **Agent "design memory"** (M). Store user preferences (style, budget, constraints) in the project; `furnish_room`/`generate_variants` read them by default.
- **Multi-frame walkthrough improvements** (M). Frame-to-frame consistency (dedupe items seen twice, camera-pose ordering), confidence per detected item, and a "confirm before building" mode emitting a preview JSON the user edits before scene write.
- **Floor-plan vectorization** (L). `analyze_floorplan_image` returns geometry descriptions; a real vectorizer (wall centerlines, opening symbols, scale bar detection) gets far more accurate than pure VLM output. Could combine VLM labels + classic CV (line detection) — the image-blaster repo does some of this.
- **Sketch → model** (M). Hand sketch photo → same editable-room pipeline (different prompt + tolerance).
- **Point-cloud depth** (L). If a phone supports LiDAR, ingest actual depth to skip estimation — ties into Capture below.

## 2. Modeling depth — toward ARCHLine-class authoring

- **Parametric windows/doors library** (M). Styles beyond the default: sliders, casements, skylights, French doors, pocket doors, storefront systems; lintel/sill/trim params.
- **Curtain wall / storefront systems** (M). Grid-based façade tool — mullions/transoms as parametric profiles on a wall face.
- **Kitchen cabinetry generator** (L). Run-of-cabinets along a wall: base/wall/tall units, appliance slots, countertop + backsplash; emits real items (not one mesh) so schedules count them.
- **Bathroom fitting runs** (M). Wet-wall logic, drain positions, tile surface assignments.
- **Structural openings/beams/columns polish** (S–M). `add_column`/`add_beam` exist — add profiles (I-beam, hollow section, wood lumber), joins, and schedule rows for them.
- **MEP lite** (L). Even a pass-through for sockets/switches/HVAC diffusers per room (electrical plan layer + schedule) gets you into real drafting territory; pipe/duct runs later.
- **Terrain & site** (L). Terrain mesh, grading, driveways, retaining walls, garden structures; `create_roof` already handles roofs — a site model is the missing ARCHLine pillar.
- **Multi-story stair/elevator cores** (M). `fit_stair` is strong; add shaft generation that punches slabs + railings across levels automatically.
- **Attic / sloped-ceiling rooms** (M). Zones under roof planes get clipped heights — affects schedules' "usable area".
- **Wall layers & composites** (M). Layered wall assemblies (load-bearing core + insulation + finishes) with per-layer thickness/material — drives real takeoff volumes and sections.
- **Ceiling design** (M). Suspended ceilings, coffers, bulkheads; ceiling plan view in the 2D editor.
- **Custom profile extrusions** (M). Baseboards, crown moldings, handrail profiles swept along paths.
- **Openings with irregular shapes** (M). Arches, round windows, gothic tops — parametric arch in the opening schema.
- **Slab-edge profiles & cantilevers** (S–M).
- **Bay windows / oriels** (M). Compound wall+slab+roof micro-build — ARCHLine's signature gimmick.
- **Railing/fence on ramps & terrain** (S). Spline runs exist; bind slope to stair/terrain height.
- **Exploded/phase construction** (M). Build phases (existing / demo / new) with per-phase visibility + hatch patterns — real renovation docs need this.
- **Underground levels** (S). Basement semantics in level ordering (below-grade, drainage).

## 3. Documentation & drawing output — where ARCHLine earns its keep

`generate_schedule`/`materials_takeoff` are step 1. The rest of the drafting suite:

- **Tagged dimensions tool** (M). Click/two-point dimension lines that persist in the model (witness lines, chains, running dims); currently missing entirely — floor-plan annotation is thin.
- **Room stamps & labels** (S–M). `zone` carries name/type/area — render them in plan view + schedules; done partially.
- **Section views** (L). Cut a section plane → generate an elevation drawing (projected walls, openings, heights) — biggest drafting gap; ARCHLine users live in sections.
- **Elevation views** (M). Same machinery, exterior faces; auto-elevation of every façade.
- **Detail callouts** (M). Clip a region at 1:5/1:10 with its own annotation.
- **Titleblock + sheet layout** (L). Paper space: sheets with frames, scales, title blocks (ISO/A-series), multi-view placement → print-ready PDF.
- **Export DWG/DXF** (L). 2D linework export is the gateway to every pro workflow; start DXF (simpler), then DWG via ODA/licensed lib or a conversion service.
- **Export PDF directly** (M). Sheet → PDF without a printer driver.
- **SVG plan export** (S). Cheap win — floor plan as clean SVG for web/docs.
- **BIM attributes / IFC export** (M). ifc-converter imports IFC — export back so the model round-trips to Revit/ArchiCAD; schedules gain IFC property sets.
- **Space/inventory schedule export to CSV/XLSX** (S). `generate_schedule` → CSV/Excel file.
- **Photoreal render presets** (M). Material/lighting preset + headless render path (three.js already; add environment HDR + tone mapping presets, or wire a render service).
- **Walkthrough animation export** (M). Camera path tool → rendered fly-through video.
- **Sun/shadow study** (S–M). Geolocation + date/time → shadow cast on terrain; report per-window sun hours.
- **Energy-pass approximation** (L). U-values + areas + orientation → rough heating/cooling estimate (ARCHLine has eco modules).

## 4. Capture, scanning & reality-to-model

- **Pascal Capture parity in-repo** (L). The iOS app scans live; a desktop/browser version (WebXR? phone upload + photogrammetry pass) would close the loop without a native app.
- **Video → multi-room model** (L). `walkthrough_to_room` builds one room; chain frames across doors to assemble a whole floor (room-graph stitching by doorway correspondences).
- **Two-photo room corners** (S). Quick mode: two corner shots → single room with inferred depth — low-effort, high-coverage input.
- **LiDAR/ARKit mesh import** (M). Accept USDZ/OBJ room scans → fit walls/openings/items to the mesh (mesh → parametric, not mesh → mesh).
- **Progress confidence UI** (S). Show per-item confidence in the editor so users fix what the vision pass guessed.
- **Calibration by known reference** (S). One dimensioned object in frame (door = 2.04 m) sets scale; currently assumed.
- **Point-cloud to BIM tools** (L). Long-haul: import LAS/E57 → auto wall/slab extraction (the photogrammetry end-state).

## 5. Agent surface & tool quality

- **Tool-call streaming/progress** (M). Long ops (walkthrough, variants, schedules on big models) should stream progress via MCP progress notifications.
- **Undo/redo tools for agents** (S). `undo`, `redo`, `history` — agents currently can't recover from a bad edit without `load_scene` gymnastics.
- **Batch semantic ops** (M). `apply_patch` is low-level; a `batch` wrapper taking several semantic tools in one call (atomic) would cut round-trips hard.
- **Scene diffs** (M). `diff_scene(a, b)` → human-readable change list; agents need it before reporting "what I did".
- **find_nodes by spatial query** (S–M). "items within 1 m of the sofa", "what's inside room X's footprint" — postgis-lite for the scene.
- **Screenshot/render tools** (S–M). `render_view`, `render_plan` → image an agent can check visually or attach to a report. Closes the loop on "did it look right".
- **Simulation hooks** (L). Walk-through collision test, agent pathfinding through the model (does a person fit from door to bed?).
- **Recipe/design library ops** (M). `add_object` covers geometry; add `save_design`/`load_design`/`list_designs` so agents build a reusable procedural catalog (the parametric-object economy).
- **Tool docs right in the output** (S). Every tool returns `next_tools` hints for the obvious follow-ups (after `create_room` → suggest `add_door`, `furnish_room`).
- **Playbooks for common jobs** (M). Named workflows: `renovate_room`, `furnish_empty`, `document_level` — versioned JSON pipelines the MCP server executes.
- **MCP client presets** (S). `pascal mcp setup` covers codex/claude — add Cursor/Windsurf/Gemini CLI config emitters.
- **Structured-output tools** (S). JSON-schema output on every read tool (some already have outputSchema — finish the set so agents can rely on it).

## 6. Providers & AI plumbing

- **More providers** (S each). Azure OpenAI, OpenRouter (unlocks dozens of models behind one key), Ollama/local models (private/offline — big selling point), AWS Bedrock, Anthropic Bedrock/Vertex aliases.
- **Per-task provider/model selection** (S). `PASCAL_VISION_PROVIDER`/`--provider` on a tool call; schedules on cheap model, vision on strong model.
- **Provider health/billing status** (S). `list_ai_providers` already reports expiry — add `pascal ai test <provider>` doing a 1-token ping so users can verify a key before work.
- **Streaming vision answers** (M). SSE stream → progressive tool output.
- **Cost-aware model routing** (M). Cheap model for text, vision model only for images — already single-call; routing table per tool in auth.json config.
- **BYO endpoint (OpenAI-compatible)** (S). `pascal ai login custom --base-url http://localhost:11434` — same as Ollama but generic; covers vLLM/LM Studio/llama.cpp automatically.
- **Auth refresh CLI-side** (S). `pascal ai refresh` — proactively renew oauth tokens before an agent run.
- **Secret redaction in logs** (S). Audit that tokens never land in `editor.log`/`~/.pascal/logs`.
- **Account-bound usage** (M). Hosted Pascal could resell/attach usage metering so agents bill to project owner's plan.

## 7. Editor & UX polish

- **2D floor-plan editing parity** (L). The plan view should match the 3D editor stroke-for-stroke (draw walls, place items, dimension) — biggest product-visible gap vs professional tools.
- **Snap-aware measurement handles** (S). Distance readouts between selection bounds live in 3D.
- **Alignment/distribute tools** (S). Align items to wall, distribute seats evenly along a table.
- **Multi-select transforms** (S). Rotate/move groups; array copy (linear/radial).
- **Section/elevation camera modes** (M). Locked ortho cameras for doc output.
- **Presentation modes** (S). White-mode, sketch lines, realistic toggle for screenshots.
- **Better catalog browser** (M). Categories, search, preview thumbnails from GLB, favorites, per-room filters.
- **Keyboard/mouse pro shortcuts** (S). CAD-style command line (type `wall`, `offset`, `trim`), ortho/polar locks.
- **Mobile/tablet viewer** (L). Read-only AR view of the model on site.
- **Annotation/comments on nodes** (M). Pin a note on a wall/item — doubles as client-review workflow.
- **Version compare UI** (M). Visual diff of two checkpoints.
- **Material editor** (M). Custom colors/textures on materialPresets per element.
- **Import 3D assets** (M). GLB/GLTF upload → catalog item with measured dims + auto front detection.
- **Catalog packs** (M). Themed packs (IKEA-style sets, office, healthcare) as plugin bundles.
- **Accessibility pass** (M). Full keyboard navigation, focus states, reduced-motion — required for pro/EU sales.
- **Localization** (M). i18n scaffolding (the user's Hungarian ARCHLine reference hints at EU market).

## 8. Collaboration & data

- **Real-time multi-user editing** (L). Presence + CRDT on the scene graph — currently single-author drafts.
- **Comments/mentions with resolve** (M). Review workflow end-to-end.
- **Project sharing/permissions** (M). Roles on projects (viewer/commenter/editor).
- **Version tags & branches** (M). Named milestones, branch a design alternative.
- **Offline-first sync** (L). Local SQLite ↔ hosted sync with conflict resolution — the connector is the seed.
- **Audit log** (S). Who/what/when on edits — enterprise requirement.
- **Org asset libraries** (M). Shared catalogs across projects in an org.
- **SSO/SCIM** (L). For the hosted side, enterprise logins.
- **Webhook events** (M). Scene saved/version created/design reviewed → webhooks for CI and dashboards.
- **Public/embed viewer** (M). Iframe-able read-only view with a share link — viral distribution.

## 9. Performance & scale

- **Scene-graph incremental saves** (M). Diff-based checkpoint writes — large models save slowly today.
- **Level-of-detail pipeline** (L). Auto-decimated GLBs for the catalog, distance LOD for furniture-heavy scenes.
- **WebGPU renderer path** (L). Three.js WebGPU for big scenes (10× draw throughput target).
- **Worker offload** (M). Geometry/boolean kernels to workers — UI stays at 60 fps during slab/roof reconciliation.
- **Virtualized lists/panels** (S). Hundreds of items → list virtualization in editor panels.
- **DB indexes + migrations** (S). Profile pascal.db on 10k-node projects; index `children`, `projectId`, `updatedAt`.
- **Streaming catalog** (M). Lazy-load GLBs by viewport relevance instead of eager download.
- **Memory ceiling in tests** (S). Golden/corpus tests on huge fixtures are the slowest part — split perf suites from correctness suites.
- **Faster cold start** (M). Snapshot the MCP server's tools list; lazy-import heavy modules (three, sqlite).
- **Headless render farm hooks** (M). Server-side rendering for reports/previews.

## 10. Reliability, testing & developer experience

- **Kill the `?perf` flake** (S). The viewer perf probe fails on clean main — fix or quarantine; it's masking real failures.
- **CI: GitHub Actions running `bun run ci`** (S). Currently no GHA — even a single job caching bun deps would catch regressions before merge.
- **Visual regression harness** (M). Screenshot-diff on a corpus scene for viewer/editor changes.
- **Fuzz the scene loader** (M). Random/corrupt node JSON must never wedge `load_scene` (E-003 is sacred).
- **MCP conformance suite** (M). A golden client driving every tool end-to-end on a fixture project.
- **Contract tests for provider adapters** (S). Recorded-replay HTTP fixtures so provider API drift fails a test, not a user.
- **Deterministic builds** (S). Pin `bun.lock` check (already) + reproducible runtime digest verification.
- **Docs from source** (M). Generate the agent-guide/tool docs from the zod schemas so they can't drift.
- **Plugin dev kit** (M). `pascal plugin create` scaffold + hot-reload + a sample node/def for third parties.
- **Telemetry (opt-in)** (S). Tool-call latency + error rates locally — helps prioritize the roadmap above with real usage data.
- **Windows/macOS test matrix** (M). Shells/path assumptions live in the CLI (loopback, auth file) — needs matrix CI.
- **Release automation** (M). `pascal release` — version bump, changelog, npm publish dry-run.

## 11. Interop — meet users where their files are

- **DWG/DXF import** (L). Existing building plans → walls/zones; start DXF via a maintained lib, DWG later.
- **IFC export + better IFC import mapping** (M). Cover more entity types (IfcFurnishingElement, IfcRoof, IfcStair) so models survive round-trips.
- **SketchUp/3DS/Revit-family bridges** (L). Probably via converter service rather than in-repo parsers.
- **CSV spreadsheet sync** (S). Two-way: edit room/item rows in Excel → apply back via `apply_patch` preview.
- **PDF floor-plan import** (M). Vector PDF plans are cleaner than photos — parse linework, scale by dimension text.
- **GeoJSON/site context** (M). Import parcel/terrain context for site planning.
- **glTF/USDZ exchange** (S). Export the whole scene as glTF for other tools; currently only node-level export.
- **VR/AR preview export** (M). WebXR session or USDZ for iOS QuickLook (ties to mobile viewer).
- **Raster underlay** (S). Reference image scaled under the plan for trace-over drawing.

## 12. What I'd do first (priority pick)

If the goal is "ARCHLine but agent-first", the sequence that compounds fastest:

1. **DWG/DXF export + CSV schedules** — opens the pro-drafting door; cheap.
2. **Section/elevation generation** — the single biggest drafting gap; builds on existing projection code.
3. **`improve_layout` + solver-scored variants** — turns review into action; unique vs every competitor.
4. **PDF plan import** — highest-accuracy reality-to-model input, easier than photos.
5. **Tool batching + undo/redo + progress** — makes every agent run faster and safer.
6. **GitHub Actions CI + kill the ?perf flake** — everything else builds on a green gate.
7. **Kitchen cabinetry generator** — the room type professionals judge parametric tools by.
8. **Ollama/OpenAI-compatible endpoint** — unlocks offline/local models for privacy buyers.
9. **Real-time collab (CRDT)** — the product-defining bet; do it after 1–8 stabilize the model.
