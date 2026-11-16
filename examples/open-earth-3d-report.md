# Quality gate: Mira190/open-earth-3d @ 0fa4803

**❌ Fail**: 2 findings block the gate (1 P0, 1 P1). Full review of the repository.

| Question | Answer | P0 | P1 |
| --- | --- | --- | --- |
| 1. Is every requirement and design decision proven by a test? | No rule with an ID was found. 159 sentences in the documents read like rules (must, should, never, always) and have not been judged: give the ones that matter an ID, or run with a model and `ai.scope: all`. | 0 | 0 |
| 2. Is each thing tested at the right level? | 1 placement finding. Cases: unit 4 · component 0 · integration 59 · e2e 338. | 0 | 0 |
| 3. Does CI enforce the checks on pull requests? | **0 of 2** checks enforced: Tests ❌ · Lint ❌. | 1 | 1 |

## Fix first: P0 and P1

| # | Priority | Blocks | Finding | Evidence | Fix |
| --- | --- | --- | --- | --- | --- |
| 1 | P0 | **yes** | **Tests: not run on pull requests** | Tests run (`tools/check.sh`, `.github/workflows/checks.yml`), but not on pull requests: a failure is found after the merge. _(code)_ | Add `pull_request` to the workflow's triggers. |
| 2 | P1 | **yes** | **Lint: not run in CI** | No CI step runs lint. _(code)_ | Add a pull-request step that runs lint and fails the build. |

## 1. Proof: is every rule proven by a test?

| Document | Rules | Critical | Proven | Hole in the proof | No test | Unverified | Reword |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `docs/ADDING_A_CITY.md` | 3 | 0 | 0 | 0 | 3 | 0 | 0 |
| `docs/ARCHITECTURE.md` | 7 | 0 | 0 | 0 | 4 | 3 | 0 |
| `docs/BUILDINGS.md` | 4 | 0 | 0 | 0 | 2 | 2 | 0 |
| `docs/CHECKS.md` | 2 | 0 | 0 | 0 | 1 | 1 | 0 |
| `docs/ENGINES.md` | 2 | 0 | 0 | 0 | 2 | 0 | 0 |
| `docs/FILMS.md` | 2 | 0 | 0 | 0 | 0 | 2 | 0 |
| `docs/FISHING.md` | 5 | 0 | 0 | 0 | 4 | 1 | 0 |
| `docs/GAME.md` | 53 | 0 | 0 | 0 | 27 | 26 | 0 |
| `docs/HERO.md` | 10 | 0 | 0 | 0 | 8 | 2 | 0 |
| `docs/HOMEPAGE.md` | 2 | 0 | 0 | 0 | 0 | 2 | 0 |
| `docs/LOOK.md` | 8 | 0 | 0 | 0 | 6 | 2 | 0 |
| `docs/NIGHT.md` | 2 | 0 | 0 | 0 | 1 | 1 | 0 |
| `docs/OBSERVABILITY.md` | 2 | 0 | 0 | 0 | 1 | 1 | 0 |
| `docs/OVERTURE.md` | 2 | 0 | 0 | 0 | 1 | 1 | 0 |
| `docs/PERFORMANCE.md` | 19 | 0 | 0 | 0 | 13 | 6 | 0 |
| `docs/POSTCARDS.md` | 1 | 0 | 0 | 0 | 1 | 0 | 0 |
| `docs/TITLE.md` | 3 | 0 | 0 | 0 | 1 | 2 | 0 |
| `docs/WEATHER.md` | 3 | 0 | 0 | 0 | 2 | 1 | 0 |
| `docs/cities/amsterdam.md` | 1 | 0 | 0 | 0 | 1 | 0 | 0 |
| `docs/cities/fushimi-inari.md` | 1 | 0 | 0 | 0 | 1 | 0 | 0 |
| `docs/cities/jinbocho.md` | 1 | 0 | 0 | 0 | 1 | 0 | 0 |
| `docs/cities/kyoto-maps.md` | 1 | 0 | 0 | 0 | 1 | 0 | 0 |
| `docs/cities/kyoto-sights.md` | 3 | 0 | 0 | 0 | 2 | 1 | 0 |
| `docs/cities/kyoto.md` | 1 | 0 | 0 | 0 | 1 | 0 | 0 |
| `docs/cities/lake-pukaki.md` | 2 | 0 | 0 | 0 | 2 | 0 | 0 |

…and 8 more documents (all of them are in `findings.json`).

<details><summary>All 159 rules, critical first</summary>

| Rule | Critical | Status | Evidence |
| --- | --- | --- | --- |
| **D-00D7D5** Things that would not help: finer computation, better terra… (`docs/cities/sydney.md:1042`) |  | ❌ no test | no test names it or shares its words |
| **D-037A95** A ride drives like a car (cars.js path, chauffeur): its rou… (`docs/GAME.md:1567`) |  | ❌ no test | no test names it or shares its words |
| **D-05863D** It dollies in along the bearing the title camera is already… (`docs/GAME.md:435`) |  | ❌ no test | no test names it or shares its words |
| **D-07E9B3** The walls are landmark meshes (torii_hit_*) in a material t… (`docs/cities/fushimi-inari.md:57`) |  | ❌ no test | no test names it or shares its words |
| **D-0D9793** A cloud keyed to its sky holds its look through the tone cu… (`docs/LOOK.md:118`) |  | ❌ no test | no test names it or shares its words |
| **D-133062** A car of the traffic doesn't go into a junction whose way a… (`docs/GAME.md:1628`) |  | ❌ no test | no test names it or shares its words |
| **D-13F084** Twilight is gradients of violet, magenta and deep gold that… (`docs/LOOK.md:64`) |  | ❌ no test | no test names it or shares its words |
| **D-18021E** The shops on Yasukuni-dori face north, so the sun never fad… (`docs/cities/jinbocho.md:19`) |  | ❌ no test | no test names it or shares its words |
| **D-18E10E** On Sydney's quay it took the reflection's second draw from… (`docs/PERFORMANCE.md:679`) |  | ❌ no test | no test names it or shares its words |
| **D-19B84D** The mirror leaves out what is too small to read in a wind-b… (`docs/cities/lake-pukaki.md:320`) |  | ❌ no test | no test names it or shares its words |
| **D-1A948C** Legend: [src] is a figure taken from the cited page. [?] is… (`docs/cities/kyoto-sights.md:7`) |  | ❌ no test | no test names it or shares its words |
| **D-1B0CC2** SwiftShader's times barely move, as they should not: a CPU… (`docs/PERFORMANCE.md:1006`) |  | ❌ no test | no test names it or shares its words |
| **D-1FBBD6** Materials drawn by the shader, not textures: granite flags,… (`docs/cities/sydney.md:706`) |  | ❌ no test | no test names it or shares its words |
| **D-1FD7AE** A stop where the camera stood inside a building's footprint… (`docs/PERFORMANCE.md:220`) |  | ❌ no test | no test names it or shares its words |
| **D-22214D** We use the NSW bare-earth DEM (`docs/cities/sydney.md:447`) |  | ❌ no test | no test names it or shares its words |
| **D-24754F** The flare, which the game never drove, now follows the sun;… (`docs/LOOK.md:150`) |  | ❌ no test | no test names it or shares its words |
| **D-250B47** The atlas is the size it was, the drawn paving replaces a s… (`docs/HERO.md:340`) |  | ❌ no test | no test names it or shares its words |
| **D-2A9C9F** The old 14 April–31 August protection never overlapped dayl… (`docs/cities/sydney.md:1010`) |  | ❌ no test | no test names it or shares its words |
| **D-2C970E** The fish is on the end of the line with its head toward you… (`docs/FISHING.md:65`) |  | ❌ no test | no test names it or shares its words |
| **D-2F9177** The step also moves the crowd, so two frames of it cannot b… (`docs/PERFORMANCE.md:226`) |  | ❌ no test | no test names it or shares its words |
| **D-31F40A** About 80,000 triangles, never in the traffic, so it has no… (`docs/GAME.md:3000`) |  | ❌ no test | no test names it or shares its words |
| **D-33362A** Water at sea level sits under the sea; a lake in the hills… (`docs/ARCHITECTURE.md:557`) |  | ❌ no test | no test names it or shares its words |
| **D-3E0213** Shaders read the same state as uniforms, OEWeather.U: uOeWe… (`docs/WEATHER.md:65`) |  | ❌ no test | no test names it or shares its words |
| **D-404D71** The check presses Play with tools/start_play.js, which wait… (`docs/GAME.md:3417`) |  | ❌ no test | no test names it or shares its words |
| **D-418007** A parametric landmark is never overwritten: PLATEAU records… (`docs/cities/kyoto.md:41`) |  | ❌ no test | no test names it or shares its words |
| **D-46803E** It fails if a beginner cannot land the easiest fish nine ti… (`docs/FISHING.md:167`) |  | ❌ no test | no test names it or shares its words |
| **D-4771CE** Piers and decks: piers are 2.2 m decks, or level with the q… (`docs/GAME.md:1102`) |  | ❌ no test | no test names it or shares its words |
| **D-47C723** By distance: chords, rings, girders and arches are always d… (`docs/HERO.md:928`) |  | ❌ no test | no test names it or shares its words |
| **D-4D878B** At least the Hondo's inner sanctuary, with its hanging lant… (`docs/cities/kyoto-sights.md:243`) |  | ❌ no test | no test names it or shares its words |
| **D-4E6F9F** A screen lights the crowd, the cars, the asphalt and the fa… (`docs/LOOK.md:253`) |  | ❌ no test | no test names it or shares its words |
| **D-533021** The words are spoken by speechSynthesis where the browser h… (`docs/GAME.md:1080`) |  | ❌ no test | no test names it or shares its words |
| **D-543181** Now a metre against a one-way street costs 25, and a banned… (`docs/GAME.md:1680`) |  | ❌ no test | no test names it or shares its words |
| **D-60541E** Level: 79,000 triangles and 4.5 MB; fine model (the rail's… (`docs/HERO.md:494`) |  | ❌ no test | no test names it or shares its words |
| **D-637EBC** Clean and of one tone: no patches, stains or wear ("The bar… (`docs/HERO.md:247`) |  | ❌ no test | no test names it or shares its words |
| **D-63BD88** The telemetry's crash events (a page that died while on scr… (`docs/PERFORMANCE.md:1113`) |  | ❌ no test | no test names it or shares its words |
| **D-643421** A car moves across to the lane its movement needs from 150… (`docs/GAME.md:1969`) |  | ❌ no test | no test names it or shares its words |
| **D-6CEDC6** With 40 walkers on one footway, pairs walked through each o… (`docs/GAME.md:1425`) |  | ❌ no test | no test names it or shares its words |
| **D-6D9A6B** A crowd is never background: it is where someone is missing… (`docs/OVERTURE.md:31`) |  | ❌ no test | no test names it or shares its words |
| **D-728AF7** Imagery must be an XYZ tile service whose licence allows re… (`docs/ADDING_A_CITY.md:26`) |  | ❌ no test | no test names it or shares its words |
| **D-72FDFA** For a phone: the overhead line, the canopies' brackets and… (`docs/cities/tokyo.md:233`) |  | ❌ no test | no test names it or shares its words |
| **D-739B77** Surface: a polar grid that follows the camera, each cascade… (`docs/ARCHITECTURE.md:628`) |  | ❌ no test | no test names it or shares its words |
| **D-7467FA** Until issue 57 the edge was extruded: each point past the f… (`docs/ARCHITECTURE.md:512`) |  | ❌ no test | no test names it or shares its words |
| **D-75F6A8** That is the trade: the cost of finding a break moved from e… (`docs/CHECKS.md:61`) |  | ❌ no test | no test names it or shares its words |
| **D-75FA81** Each building is drawn a tiny share of its distance nearer… (`docs/BUILDINGS.md:207`) |  | ❌ no test | no test names it or shares its words |
| **D-765D17** The start also needs room to walk away, and a few steps cle… (`docs/GAME.md:1098`) |  | ❌ no test | no test names it or shares its words |
| **D-77F718** The dead-page report follows Sentry's and Firebase Crashlyt… (`docs/OBSERVABILITY.md:285`) |  | ❌ no test | no test names it or shares its words |
| **D-7BEFC9** So for Unreal and Source this project re-implements from th… (`docs/ENGINES.md:17`) |  | ❌ no test | no test names it or shares its words |
| **D-7EC8BE** Table 1 is a hard rule: a permit must not be granted for bu… (`docs/cities/melbourne.md:170`) |  | ❌ no test | no test names it or shares its words |
| **D-7F7A10** A ride and the traffic see each other along their ways and… (`docs/GAME.md:1532`) |  | ❌ no test | no test names it or shares its words |
| **D-851952** A roof may not leave less than 2.4 m of wall (`docs/BUILDINGS.md:172`) |  | ❌ no test | no test names it or shares its words |
| **D-8AC16D** Terrain must be bare earth (`docs/ADDING_A_CITY.md:22`) |  | ❌ no test | no test names it or shares its words |
| **D-8EF927** After: 38 MB of canvases (the minimap's base, 17, is the la… (`docs/PERFORMANCE.md:1261`) |  | ❌ no test | no test names it or shares its words |
| **D-8FF9B0** You never step aside for them, so a walker with you on its… (`docs/GAME.md:1428`) |  | ❌ no test | no test names it or shares its words |
| **D-91CFA2** A strip's slab stops at the lowest point of its surface in… (`docs/GAME.md:933`) |  | ❌ no test | no test names it or shares its words |
| **D-92CA0D** Build landmarks from published dimensions, and place them w… (`docs/ADDING_A_CITY.md:220`) |  | ❌ no test | no test names it or shares its words |
| **D-941706** Not charged, by decision: Tokyo's water buses (no operator… (`docs/GAME.md:734`) |  | ❌ no test | no test names it or shares its words |
| **D-9546EF** Its fine model (scramble_fine.glb: the shop doors' stiles,… (`docs/HERO.md:271`) |  | ❌ no test | no test names it or shares its words |
| **D-961511** The driver is the ride's (game.js driverStep: the way round… (`docs/GAME.md:1543`) |  | ❌ no test | no test names it or shares its words |
| **D-9AB0A5** A map is a district of Kyoto, never a city of its own: the… (`docs/cities/kyoto-maps.md:9`) |  | ❌ no test | no test names it or shares its words |
| **D-9CBFDF** But the camera is always 30 to 37 degrees short of the term… (`docs/TITLE.md:41`) |  | ❌ no test | no test names it or shares its words |
| **D-9F5396** Other games this borrows a thought from, without their look… (`docs/POSTCARDS.md:36`) |  | ❌ no test | no test names it or shares its words |
| **D-A0008C** Each bank is the ground on its own side just outside the wa… (`docs/ARCHITECTURE.md:271`) |  | ❌ no test | no test names it or shares its words |
| **D-A13C86** From a street the street wall hides most of the city, and t… (`docs/PERFORMANCE.md:140`) |  | ❌ no test | no test names it or shares its words |
| **D-A47656** The film of issue #93 shows Kabukicho and the plaza at nigh… (`docs/cities/shinjuku.md:308`) |  | ❌ no test | no test names it or shares its words |
| **D-A5FD5B** High floors: a travel point with a height ([x, y, z]) lands… (`docs/GAME.md:2625`) |  | ❌ no test | no test names it or shares its words |
| **D-B02328** Measured against the old 2 m grid: 120 walks into walls at… (`docs/GAME.md:1371`) |  | ❌ no test | no test names it or shares its words |
| **D-B3D5D3** Each day of the year is wet or dry by a hash of its date, s… (`docs/WEATHER.md:82`) |  | ❌ no test | no test names it or shares its words |
| **D-B3FC99** Banners (a rank, a level, a job) wait while a station's arr… (`docs/GAME.md:802`) |  | ❌ no test | no test names it or shares its words |
| **D-B437E7** Someone who knows Shibuya should recognise every facade fro… (`docs/cities/shibuya.md:316`) |  | ❌ no test | no test names it or shares its words |
| **D-B53D7D** Marunouchi's level is the one landmark, so it is built as t… (`docs/HERO.md:744`) |  | ❌ no test | no test names it or shares its words |
| **D-B54D56** An overcast after dark is lit from below, by the twilight i… (`docs/NIGHT.md:193`) |  | ❌ no test | no test names it or shares its words |
| **D-B561EA** The ferries' sidelights swap ends when they reverse, so red… (`docs/GAME.md:3044`) |  | ❌ no test | no test names it or shares its words |
| **D-BE1C60** What is small is fetched only near and never on the low tie… (`docs/HERO.md:507`) |  | ❌ no test | no test names it or shares its words |
| **D-C08EC4** A step taken back because it would have gone deeper into an… (`docs/GAME.md:1501`) |  | ❌ no test | no test names it or shares its words |
| **D-C6F0E6** They steer the detail only: the colour is always the imager… (`docs/cities/lake-pukaki.md:92`) |  | ❌ no test | no test names it or shares its words |
| **D-C819B4** So a short model is not always wrong (`docs/cities/sydney.md:507`) |  | ❌ no test | no test names it or shares its words |
| **D-C84E56** While the car coming for you is out of your sight (more tha… (`docs/GAME.md:277`) |  | ❌ no test | no test names it or shares its words |
| **D-C85CFF** A species may be closed at any size: blue cod may not be ta… (`docs/FISHING.md:211`) |  | ❌ no test | no test names it or shares its words |
| **D-D0151E** The trains (web/game/trains.js): Waratah sets, eight double… (`docs/cities/sydney.md:375`) |  | ❌ no test | no test names it or shares its words |
| **D-D1758D** If it does not, the governor's ordinary way down takes the… (`docs/PERFORMANCE.md:1566`) |  | ❌ no test | no test names it or shares its words |
| **D-D1861D** It mounts a kerb of 25 cm at most (cars.js CAR_STEP): a pla… (`docs/GAME.md:160`) |  | ❌ no test | no test names it or shares its words |
| **D-D19A88** The pack format decodes a landmark's vertex lists as typed… (`docs/PERFORMANCE.md:1447`) |  | ❌ no test | no test names it or shares its words |
| **D-D280F8** A deck never goes below the ground, and moves at most 3 m (… (`docs/GAME.md:1233`) |  | ❌ no test | no test names it or shares its words |
| **D-D4F52A** The world-space maths (positions kilometres from the origin… (`docs/PERFORMANCE.md:776`) |  | ❌ no test | no test names it or shares its words |
| **D-D54B48** They should load only when a feature needs them. three-mesh… (`docs/ENGINES.md:36`) |  | ❌ no test | no test names it or shares its words |
| **D-D8144A** Scores always use the uncorrected open-data height, so the… (`docs/cities/sydney.md:519`) |  | ❌ no test | no test names it or shares its words |
| **D-D990CD** The rule: cut what a player cannot see (GPU memory nobody s… (`docs/PERFORMANCE.md:3`) |  | ❌ no test | no test names it or shares its words |
| **D-E1E888** It is spoken by the browser's own voices where it has them… (`docs/cities/tokyo.md:351`) |  | ❌ no test | no test names it or shares its words |
| **D-E538AB** Colour: the river is turbid with suspended clay, so it is b… (`docs/cities/melbourne.md:162`) |  | ❌ no test | no test names it or shares its words |
| **D-E87A16** For the 3DBAG, a tier as small as 6 m² is kept when it stan… (`docs/cities/amsterdam.md:107`) |  | ❌ no test | no test names it or shares its words |
| **D-E903C1** They are kept dim (0.022), so the boards read warm, never w… (`docs/cities/queenstown.md:113`) |  | ❌ no test | no test names it or shares its words |
| **D-EF3897** A thunderstorm by day has its own key on top of the preset:… (`docs/LOOK.md:146`) |  | ❌ no test | no test names it or shares its words |
| **D-EF51EB** The world now asks the terrain, with no GPU at all (world.j… (`docs/PERFORMANCE.md:537`) |  | ❌ no test | no test names it or shares its words |
| **D-F1CAE8** The Tombori River Cruise is split into two short routes so… (`docs/cities/osaka.md:401`) |  | ❌ no test | no test names it or shares its words |
| **D-F50E9E** Every third step it looks beside itself and 1.5 m ahead for… (`docs/GAME.md:2819`) |  | ❌ no test | no test names it or shares its words |
| **D-F6E0AA** The panel is written only when a value changes: the bar is… (`docs/FISHING.md:145`) |  | ❌ no test | no test names it or shares its words |
| **D-F70B38** Its finest geometry (lattice bars, the eaves' round tiles,… (`docs/HERO.md:153`) |  | ❌ no test | no test names it or shares its words |
| **D-FC3710** For it to be conservative for a whole 64 m viewer cell, the… (`docs/PERFORMANCE.md:151`) |  | ❌ no test | no test names it or shares its words |
| **D-FC52BA** Each city counts your days in it; the count never resets (`docs/GAME.md:609`) |  | ❌ no test | no test names it or shares its words |
| **D-FDCC2D** The whole city on the big map (region in web/game/game.js):… (`docs/GAME.md:2488`) |  | ❌ no test | no test names it or shares its words |

…and 59 more rules (all of them are in `findings.json`).

</details>

159 sentences without an ID were not judged (no model, or outside this run's budget): they are in the table above and produce no finding. Give a sentence an ID to make it a rule for certain.

## 2. Placement: is each thing tested at the right level?

| Level | What a test at this level needs | Files | Cases | Files a pull request runs |
| --- | --- | --- | --- | --- |
| unit | one process, nothing real around it | 4 | 4 | 0 of 4 |
| component | one rendered component or module slice | 0 | 0 | 0 of 0 |
| integration | a real database, HTTP, queue or process | 2 | 59 | 0 of 2 |
| e2e | the whole system, driven from outside | 13 | 338 | 0 of 13 |

| # | Priority | Blocks | Finding | Evidence | Fix |
| --- | --- | --- | --- | --- | --- |
| 3 | P2 | no (below the gate) | **The test suite is top-heavy** | 397 integration and end-to-end cases against 4 unit and component cases: the suite is top-heavy. _(code)_ | For each slow test, ask what it would lose as a unit test; move what loses nothing. |

## 3. CI: are the checks enforced on pull requests?

| Check | State | Where | Note |
| --- | --- | --- | --- |
| Tests | ❌ not on pull requests | `.github/workflows/checks.yml:49` (plan), `.github/workflows/checks.yml:91` (shard), `.github/workflows/checks.yml:126` (report) | `tools/check.sh` |
| Lint | ❌ missing |  |  |
| Type check | ➖ not set up |  |  |
| Formal models | — not applicable |  |  |
| Format | ➖ not set up |  |  |
| Coverage | ➖ not set up |  |  |
| Dependency scan | ➖ not set up |  |  |
| Secret scan | ➖ not set up |  | GitHub secret scanning is a repository setting this run cannot see |
| Static security analysis | ➖ not set up |  |  |

- Branch protection (which checks are required to merge) is a repository setting this run does not read.

## Run

- Files: 3500 listed, 33 vendored or generated and skipped; read: 33 rule documents, 19 test files (401 cases), 2 CI files. Source files are not read, except the ones a change touches.
- Rules: 159 (0 with an ID in the source, 159 inferred from normative sentences) from `docs/GAME.md` (53), `docs/ADDING_A_CITY.md` (3), `docs/ARCHITECTURE.md` (7), `docs/BUILDINGS.md` (4), `docs/CHECKS.md` (2), `docs/ENGINES.md` (2) and 27 more.
- Model: none (switched off (ai.provider: none)). Only code-decided findings can block; 0 rules that need a judgment are listed as unverified.
- Read by code, in full: 33 rule documents, 19 test files, 2 CI files. The model reads no file.
- Tests are read, not run. Evidence levels: _code_ is decided by parsing; _model, verified_ is a model answer whose citation code checked; _advice_ never blocks.
- Time: scan 19 ms · extract 1475 ms · formal 0 ms · ci-scripts 35 ms · index 69 ms · ci 13 ms · model 0 ms · link 116 ms · judge 0 ms · assess 1 ms · execute 0 ms · placement 1 ms.
