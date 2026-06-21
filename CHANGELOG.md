# Changelog

## 0.20.0

A UI release: the live web UI now visualizes the entire forecast structure the engine already computes — not just the synthesized report afterward — plus an adversarial UI-quality sweep across the dashboard, run view, settings, and ledger. No engine or forecasting-math changes; the numbers are identical, the difference is what you can see while a run computes.

### The forecast UI now shows what the engine computes
- **Sub-forecast decomposition is visible live.** When an open-ended question fans out into several sub-forecasts, the run view renders the framing brief, the matched domain, and every sub-forecast with its own headline, distribution, panel spread, and pending state. Previously only the first sub-forecast was shown, as if it were the whole answer — the rest were already streaming, the UI just collapsed them.
- **The grounded scenario simulation has a UI.** A new "Scenario analysis" panel renders the driver tornado (share of outcome variance η²), the ranked scenarios with their conditional outcomes, the coherence verdict against the panel (a high divergence gets the system's one alarm treatment), and whether the simulation blended into the headline or stayed a cross-check — for single and decomposed questions alike. It was computed and streamed all along; the reducer was discarding it.
- **The full derivation chain renders identically** on the live headline and the ledger — `GMO → extremized (k) → ⚓ market (w, volume) → recalibrated → updated → sim (w)` — alongside the per-tail interval dilation (`×lo/up`) with its pre-dilation raw band, the inverted-framing coherence-probe panelist drawn as a hollow ring, panelist medians on the range strip, and the matched sportsbook line on each sports facet (winner / total / margin).
- **Domain packs read with their friendly labels** ("Macro / economy", "Sports", "General") everywhere, instead of raw ids on the run views and labels only in the composer.

### UI quality + correctness sweep
- **Live steering and Stop surface failures** instead of silently swallowing them; the typed note survives a failed send so it can be retried.
- **Settings test results stay honest** — a shown ✓/✕ clears the moment you edit the inputs it described.
- **Forecast manual-resolve requires an explicit click** (it was firing an irreversible resolution on a dropdown change), and resolution actions read as buttons distinct from the read-only status tag.
- **Render fixes**: non-finite chart points no longer emit broken polylines, flat sparklines stay visible, and the scoring metrics (Brier, pinball, interval score, P(never), panel split) all carry inline explanations.
- **Design-system consistency**: color emoji replaced with monochrome glyphs, off-scale type snapped to documented tokens (the headline number and wordmark now own a `2xl` token), reused micro-headings, and a theme toggle that announces its target without a hydration flash.

## 0.19.0

An accuracy-hardening pass: a multi-expert audit of the forecasting math drove fixes across four layers — deterministic correctness bugs that mis-stated numbers, train/serve skews in the learning flywheel, calibration expressiveness, and cold-start. No breaking changes; every new method reduces to prior behavior in its no-op limit, and sports/binary behavior is unchanged where it should be.

### Deterministic correctness (these moved real numbers)
- **Options-implied probability is now computed to the forecast's TARGET date, not the option's expiry** — interpolating implied vol across the bracketing expiries in total-variance space. An off-cycle date previously used the wrong horizon (a double-digit-pp error on `N(d2)`).
- **The Monte-Carlo trend driver samples a true Student-t** with the OLS fit's own `sePred`/`df` instead of treating the t-band as a Gaussian one — correct heavy tails for a small-n fit (the old path was both center-too-wide and tail-too-thin).
- **SEC fundamentals no longer mix 10-K annual and 10-Q quarterly periods on one axis** (a 4× sawtooth that wrecked the trend); one consistent frequency is kept.
- **Reference-class base rates are Beta-Binomial (Jeffreys) smoothed** — 5/5 reads as ~92%, never a reckless 100% that one later miss would punish — and carry a credible interval.
- **Equity/crypto price trends fit in log space** (multiplicative, lognormal predictive) and **"inflation" projects the CPI YoY rate**, not the ever-rising index level.
- **open-meteo windows that span today** fetch both the ERA5 archive and the forecast and merge them, instead of silently dropping the forecast horizon.

### Stronger trend models
- **Random-walk-with-drift is the default projector** (it beats a linear OLS extrapolation out-of-sample on most price/rate series), with a damped-trend option; `swarm backtest` now includes a walk-forward **projector gate** that proves which projector generalizes best on your accumulated series.

### Flywheel train/serve consistency
- **The extremization-`k` learner now optimizes the estimator that's actually served** — overlap-scaled and method-weighted — instead of the raw one, and **out-of-fold backtest folds are time-respecting** (forward-chaining by resolution time), so a learner can't be flattered by future outcomes.
- **Multiple-choice questions get their own learned exponent (`kMc`) and their own recalibration** (mc previously got neither), each gated in `swarm backtest`.
- **Per-domain calibration uses partial pooling** — a thin in-domain fit shrinks toward the global pool by its own usable sample size, instead of a hard switch that regressed right at the threshold (and never toward the cold default).

### Calibration expressiveness + missing methods
- **Asymmetric (per-tail) interval calibration** widens the lower and upper tails by their own learned factors — lopsided miscoverage is fixed on the side that needs it.
- **Student-t copula** option for the scenario simulation (per-pack `ν`; finance uses ν=6) adds the joint tail dependence a Gaussian copula lacks — correlated shocks co-occur; ν=∞ recovers the Gaussian exactly.
- **Shin de-vig** for sportsbook moneylines corrects the favorite-longshot bias the proportional method leaves in.
- **Options drivers use the real-world drift** (`r + ERP`) for the engine's forecast while the `options_implied` tool still reports the market's risk-neutral price.
- **Sequential update on a re-forecast**: a superseding forecast blends toward the prior published posterior in log-odds instead of re-litigating the base rate from scratch.
- **Beta calibration** (Kull 2017) is offered as a backtest-gated alternative to logistic recalibration.

### Cold-start + proving accuracy
- **`swarm refclass seed`** imports a bundled, provenance-documented corpus of counted historical base rates (construction overruns, business survival, recession frequency, incumbency) so the outside-view drivers are live on day one; the engine's own resolutions refine and eventually dominate them. `swarm refclass list` shows the current classes.
- **Supersession chains are de-duplicated** in reference-class counts (a re-forecast of the same event counts once), and a sub-question's own reference class is queried when it carries one.
- **`swarm calibration` shows an outside-view discipline check** — whether the panel's deviations from its committed base-rate prior actually pay off.

### Quality hardening (full-codebase sweep)
A second adversarial sweep (7 dimensions × verify-each-finding) over the whole tool — correctness, the learning flywheel, efficiency, CLI/UX, and the web UI — fixed every confirmed issue:
- **`swarm backtest` is dramatically faster and now grades the model that actually ships.** The binary/mc backtests hoist each out-of-fold fit once per entry instead of refitting (and re-scoring) from scratch on every strategy — an O(n²·gridsize) replay becomes O(n). Each fold is also fit with the entry's **own domain**, so the regression gate measures the per-domain partial-pooled estimator the live path serves, not the global pool.
- **A binary re-forecast (`--supersedes`) no longer loses its sequential update when the simulation has earned weight** — the post-supersede headline is recorded in the component chain, so the sim blends on top of it; numeric/mc sim-weight fits now learn from previously-blended entries via a non-circular pre-sim snapshot, matching the binary path.
- **Finance questions phrased "beneath / less than / greater than / at least / at most" now extract their strike** (strike + direction from ONE boundary-anchored regex match, so they can't drift or match a keyword inside another word), restoring options grounding and exact resolution; the resolver never settles from a post-deadline close; the IV term structure holds vol flat outside the listed expiries instead of silently re-scaling it.
- **A "close BELOW $X" binary now gets a correctly-oriented grounded simulation.** The scenario combiner's `threshold` op gained an optional `dir:"lt"` (fire below; default still "gt"), and the finance options/trend drivers emit in the question's own polarity — previously a below-strike question's bottom-up P(YES) was the inverse of how it resolves.
- **The multiple-choice exponent can be pinned independently** of the binary one (`extremizeKMc` override).
- **Web UI:** date/numeric run cards render `~2026-01-14` / a rounded value (not a raw epoch-day or a long float); a due numeric/date/mc forecast can be **manually resolved with its real value** (not just voided), end-to-end through the hub; keyboard Enter on a card's delete button deletes instead of navigating away; the "due" list ticks on its own; icon-only buttons carry accessible labels.
- **Internal:** one shared logistic-recalibration kernel (binary + mc), one interval-dilation kernel (symmetric delegates to asymmetric), one tunable-precedence helper for the four learned knobs, and hoisted Monte-Carlo allocations. `npm test` now rebuilds first so it can never test stale output.

## 0.18.0

General-purpose forecasting via **domain packs**: the engine generalizes everything the sports path does — intent detection, engine-owned decomposition, per-quantity priors, data-grounded modeling, and exact auto-resolution — into a registry of domains (finance, macro, elections, construction, business, sports). Each domain learns its own calibration, and any setup can be saved as a reusable, freezable model. No breaking changes; an unmatched question takes the same generic panel+research path as before, and sports behavior is byte-identical (it became pack #1).

### Domain packs
- **A registered domain owns the forecast for its kind of question.** `detectDomain` runs cheap deterministic matchers first (a wrong domain is worse than the generic path); only when all abstain does one cheap LLM classifier run, and only over packs that opt in. Sports stays deterministic-only, so a sports question takes the identical path it always did. A pack can also decompose (the `planSportsGame` analogue), build a data-grounded Monte Carlo driver catalog, and auto-resolve from authoritative data.
- **Finance/markets** — a "will TICKER close above X by DATE" or "what price" question builds a bottom-up model from the option market's own risk-neutral probability (Black-Scholes), an OLS price trend, and a VIX volatility regime, and resolves *exactly* from the closing price.
- **Macro/economy** — grounds numeric questions in a real FRED series (OLS trend) and resolves "direct" rate series (unemployment, fed funds, 10y, mortgage) from the official print.
- **Construction/projects** — decomposes a delivery question into milestone sub-forecasts (permits, funding, phase completion, schedule slip) that the simulation composes into a schedule-risk model, plus a counted reference-class overrun rate once comparable projects resolve.
- **Elections** and **business** route for per-domain calibration and the right UI knobs, leaning on the market anchor and the new structured tools.

### Per-domain learning + reference classes
- **The calibration flywheel is now per-domain.** Every learned parameter (extremization k, market/sports anchor weights, recalibration, interval dilation, simulation weight, method weights) fits on the domain's own resolved history with a two-level backoff — per-domain fit → global fit → default — so a domain tunes itself exactly where it has earned the data and is identical to before everywhere else (old ledger rows carry no domain, so a thin domain transparently uses the global pool that still contains them). `swarm calibration` and the UI now show a per-domain track record.
- **A reference-class store** (`~/.agentswarm/refstore/`) accumulates resolved outcomes by domain + class so a pack can read a *counted* base rate instead of an LLM guess, and caches fetched series so a run doesn't re-fetch (with stale-on-failure fallback and size-bounded compaction).

### Deep data (free/keyless-first)
- **New structured feeds, no key required for the high-value ones.** `time_series` gains **SEC EDGAR XBRL fundamentals** (`secfacts`, e.g. `AAPL:Revenues`), **USAspending** federal contract obligations, **EIA** energy, and **BLS** employment/wages; a new **`data_feed`** tool returns SEC filing lists and company profiles. FRED accepts plain-word aliases (`unemployment`, `cpi`, `fedfunds`, `10y`, `lumber`, `steel`, `cement`, `vix`…), and Yahoo futures symbols (`CL=F`, `LBS=F`, `HG=F`) are documented for keyless commodity spot. The optional free BLS/EIA keys are set via `swarm config set blsApiKey / eiaApiKey`.

### Saved, reusable, freezable models
- **Save a forecast setup and reuse it.** A saved model bundles a domain + tunables; a **frozen** model also captures the current learned fit (recalibration, weights, dilation) verbatim, so a run is reproducible and shareable, while a **live** model re-learns from the ledger each run. Pick one from the composer's model dropdown or manage them in Settings; each model accrues its own track record in the ledger (`/forecasts?model=<id>`).

### UX: progressive disclosure + intent
- **The composer shows almost nothing by default** — the question box, an auto-detected domain chip (overridable), and a saved-model dropdown. Everything else (resolution date, panel size, and only the tunables relevant to the detected domain) lives behind an Options disclosure. Per-run forecast tunables are now fully reproducible (promoted into the run's options, with the precedence: an explicit pin > a frozen model > the ledger-learned value > the configured default), so a run is self-describing and a resumed run keeps its domain, learning, and data-grounded drivers.

### Performance
- **The series cache no longer re-reads the whole file per call** (memoized by the file's size+mtime, invalidated on any write) and **compacts** itself when it crosses a size threshold (collapsing superseded snapshots to one record per series). The ledger is read once per run instead of once per binary sub-forecast, and a domain's independent data feeds are fetched concurrently rather than sequentially.

## 0.17.0

Market-anchored sports forecasting and a forecasting-accuracy hardening pass. The headline addition: a head-to-head game is now decomposed by the engine into the facets a sharp betting line actually prices — who wins, the combined total, and the margin — each anchored to that line and resolved from the official box score. No breaking changes; everything is gated on a matched line and the free Odds API key.

### Sports: anchor to the line, resolve from the box score
- **A game mission decomposes into three resolvable, market-benchmarked facets.** Give `swarm forecast` a head-to-head matchup ("Lakers vs Celtics on 2026-06-20") and the engine — not the LLM emitting the right shape — builds **winner** (mc over the two teams, plus "Draw" for 3-way soccer books), **combined total** (numeric), and **favorite margin** (numeric, signed). An exact final score isn't a single resolvable quantity, so it's never forecast; these three are. `--single` collapses to the winner headline.
- **The line is the anchor, not a suggestion.** A sharp closing line is the single most accurate public predictor of a game, so the engine **centers** the total/margin quantiles on the book's median total/spread (mapped to quantiles through a per-sport game-to-game σ — NBA total ≈ ±11, margin ≈ ±12) and the win probability on the **de-vigged moneyline** (median across bookmakers; 3-way books de-vig all three outcomes together). The panel only moves the result off the line where it has a concrete, line-relevant edge. The line is already calibrated, so it's blended in at full residual weight without dilation; the pre-blend quantiles are stored (`blendedQ`) so a future weight refit is never circular.
- **Conservative classification — the target is never silently rewritten.** `classifySportsMission` only fires on a clean winner/combined-total/margin question. Single-team totals, player props, half/quarter lines, and binary cover/over-under/win-by-N bets all fall through to the normal planner.
- **Resolution is ground truth, not a web agent.** A sports facet resolves straight from The Odds API `/scores` box score (winner = more points, total = the sum, margin = favorite − underdog), matched on the stored event id so a team-pair that plays twice in the window can't settle the wrong game. It returns null until the game is `completed`, holds a recent game open if the API responded-but-not-final, and only falls back to a research agent once the game is past the 3-day `/scores` window — never settling from a live, in-progress score.
- **Did we beat the line?** `swarm calibration` gains a "sports vs the market" verdict: winner Brier vs the moneyline's Brier, total/margin pinball vs predicting the line itself, and **CLV** (did our median lead the line's open→close move). `swarm sports close` captures the closing line for open games near tip-off (run it on a short cron) — the CLV baseline; it signs the closing spread relative to the original favorite so the value stays correct even if the favorite flips by tip-off.
- **New `sports_odds` tool** for forecasters: de-vigged moneyline, spread, and total for one upcoming game (always pass the league + date to disambiguate same-name teams and a team-pair that plays more than once). Game discovery uses the **free** `/sports` + `/events` endpoints and buys odds for only the matched event (cost = 3), with a 6h/5min cache.
- **New config `forecastSportsMarketWeight`** (default 0.75, range 0–1, CLI + Settings UI) — a sharper anchor than the generic `forecastMarketWeight` because a closing line earns more pull. Re-fit out-of-fold from the resolved record once 20+ sports facets resolve (numeric facets, by pinball).

### Forecasting-accuracy hardening
- **Non-finite values can no longer poison the flywheel.** Every calibration fit path (recalibration, method weights, market-weight and extremization-k search, per-method Brier) now rejects `NaN`/`±∞` probabilities instead of laundering them to 0.5 and scoring them — a single bad ballot used to corrupt fitted parameters silently. A dedicated `clampMarketProb` ([0.005, 0.995]) keeps a genuine market extreme from being squashed by the panel clamp.
- **`chooseExtremizeK` boundary argmin**: the golden-section search now compares its midpoint against the bracket endpoints and the coarse-scan best, guaranteeing it never returns a worse-than-boundary k.
- **`verdictsAgree` band-relative tolerance**: a pure 1%-relative numeric tolerance collapses to ~0 near zero, so two correct resolvers of a small margin or net-change would "disagree" and bounce to manual settlement — starving calibration of exactly the zero-centered quantities. The tolerance now adds a floor scaled to the forecast's own p10–p90 width.
- **Market fabrication guards**: `devigProbs` returns inputs untouched on a single live outcome (nothing to de-vig), and the sportsbook/Polymarket parsers only publish a probability when ≥2 outcomes are actually priced — no inventing a number from a one-sided book.
- **Market anchor freshness gate**: a candidate market that already closed (a stale price) or whose close date is far from the question's resolution window (a different horizon) is rejected before the same-question LLM check — a wrong anchor is worse than none.
- **OLS prediction bands**: `time_series project_to` returns null below 3 points (a 2-point "fit" has no residual), inflates σ for autocorrelated residuals via an AR(1) correction (n≥4), and clamps the band to the series' natural support (non-negative for counts/pageviews, ≤100 for percentages).
- **Simulation soundness**: the mc combiner root is required to be `argmax` (option-index selection); `weighted_sum` no longer divides by Σ|w| for a **mixed-sign** combination (a difference / net change is a genuine linear combination — normalizing compressed it toward 0 and biased zero-centered intervals narrow); option probabilities use **add-one (Laplace) smoothing** (the principled multinomial estimator, summing to 1 without a renormalization step) instead of a flat floor; a log-space marginal that would `log()`→`NaN` falls back to its median; and the tornado's correlation ratio η² groups by **distinct value** for low-cardinality drivers, so a rare-but-decisive binary flip is no longer swallowed by the majority bin and reported as zero importance.
- **Simulation independence**: the verified market anchor is no longer added as a Monte Carlo driver — it's already blended into the top-down headline the simulation cross-checks, so including it would bias the bottom-up/top-down divergence toward agreement and double-count the market once the sim earns weight.
- **Portability**: a fetched page declaring `windows-1252` (and the latin1/iso-8859-1/ascii labels the WHATWG standard folds into it) now decodes deterministically rather than through the platform's ICU tables, which a small-icu Node lacks — so a page's smart quotes and dashes decode identically on every Node build.

### Tests
- Unit suite grows to 306 (a new `sports.test.js`: line→quantiles mapping, de-vig across 2- and 3-way books, mission classification, box-score resolution, the "vs the market" calibration stats; plus the hardening assertions — non-finite guards, mc canonicalization, `clampMarketProb`, the `verdictsAgree` floor, mixed-sign `weighted_sum`, Laplace smoothing, the `argmax`-root guard, tornado distinct-value binning, OLS null/autocorrelation). CI (Node 20 + 22) is green.

## 0.16.1

A correctness fix for question sharpening: a "when will X happen" mission could be silently reframed into a different question (e.g. "which party will be responsible for X?") — forecasting *who* instead of *when*. The quantity being forecast is now preserved.

### Preserve the quantity being asked
- **The bug**: on a small planner model, "the US government shut down Fable 5 access — when will it be restored?" came back sharpened as the multiple-choice "Which party will be primarily responsible for restoring access?" The sharpener changed *what* was forecast (timing → attribution), not just the wording. The prompts said "keep the intent, sharpen don't replace it" but never forbade swapping the measured quantity, and nothing checked the result.
- **Prompt fix**: both the single-question sharpener and the open-ended decomposer now carry a hard rule with a worked example — match the question word to the kind ("when" → `date` timing, "who/which" → `mc`, "how much" → `numeric`, "will/whether" → `binary`) and **never** substitute one for another.
- **Deterministic guard** (`isTimingMission`): a timing mission ("when will…", "by when…", "how long/soon until…") that comes back with no timing-typed forecast is rejected and re-planned with a targeted correction — on both the decompose and single-sharpen paths — and the last-resort mechanical fallback now emits a `date` forecast (it hard-coded `binary` before). High-precision detection ignores "when" used as a conjunction ("what happens when the Fed cuts?"). So a "when" question can no longer become a "which/who" or "will-it" one, regardless of the model.

## 0.16.0

Grounded scenario simulation: a forward Monte Carlo that turns a decomposed forecast's sub-forecasts into correlated drivers, ranks the scenarios, and cross-checks the headline — earning weight only on the resolved ledger. No breaking changes; the headline never moves until the ledger proves the simulation helps.

### What it does
- **`swarm forecast … --simulate`** (automatic on decomposed questions) runs a new engine-owned stage after aggregation. It treats each grounded signal — a sub-forecast's aggregated distribution, the verified market price, and (only as a single-question fallback) panel base rates — as a random variable whose marginal is *already computed*. The model proposes the **structure only**; the engine does the math.
- **The model never supplies a number.** It returns a closed JSON combiner tree (`and`/`or`/`threshold`/`sum`/`weighted_sum`/`max`/`min`/`argmax`/`conditional_table`) over driver *handles* plus pairwise correlations. A **grounding gate** (`validateSimStructure`) drops any driver or combiner leaf that points outside the engine-built catalog and rejects the whole simulation below two grounded drivers — so a bare probability cannot be smuggled in.
- **Ranked scenarios + a driver tornado** fall out of one sample: worlds are clustered by their driver-fired pattern (the modal world is "the winning scenario"), and first-order sensitivity is the **correlation ratio η²** over quantile bins (exact for binary drivers, nonlinear-aware for continuous). A bottom-up/top-down **coherence check** flags when the simulation diverges from the panel. The report renders a "Scenario analysis" section with both charts.
- **Earns the headline like every other layer.** The blend weight defaults to **zero** — a pure cross-check — and is fitted on the resolved ledger (per kind: log score for binary/mc, pinball for numeric/date) only once **30** resolved simulated forecasts exist, capped at **0.30** so the simulation never dominates the panel. `swarm backtest` stratifies sim-on vs sim-off.

### Math & correctness
- **Gaussian copula** over the driver marginals: an LLM-proposed correlation matrix is clamped, repaired to positive-definite by diagonal loading when inconsistent, Cholesky-factored once, and applied to Box-Muller normals. Marginals are inverted from each driver's existing piecewise-linear quantile function (`normInv` + single-quantile CDF inversion), in log space for right-skewed positives.
- **Sign consistency across mixed driver kinds**: every marginal maps high latent *z* → high value, so a binary driver fires on high *z* (not low) like a numeric value rises with *z*. A positive specified correlation between a binary and a numeric driver now realizes as positive co-movement, as the prompt promises — not its negation. (Regression-tested through the copula.)
- **Multiple-choice is modeled by a random-utility `argmax`** (the top-scoring option wins each world), and out-of-range draws are clamped into the option set so none is silently dropped against a fixed denominator.
- **Coherence scales by the panel's own spread** (p10–p90 width), not |p50|, so a zero-centered quantity (anomalies, net change, margins) no longer reads as infinitely divergent.

### Durability
- The base ledger record is still written **inline** before the simulation's model call (crash-safe), and the simulation appends an **`updated` patch** that `loadLedger` merges — a crash mid-simulation leaves a clean, sim-less forecast rather than nothing. The post-sim aggregate is journaled (`forecast.simulated`) and restored by the state reducer, with a stage-level idempotence guard so a resumed run never starts a second simulation.

## 0.15.0

Calibrated interval forecasts, a fix for the spurious multiple-choice "Other", and charts that render in the app. No breaking changes.

### Multiple-choice correctness
- **The "Other" inflation bug**: `normalizeOptionProbs` rescaled per-value (`if (n > 1) n /= 100`), so an option a panelist submitted as the integer `1` (meaning 1%) survived as `1.0` and, after renormalizing against its already-scaled neighbours, ballooned to ~50% — every mc forecast with such a value was corrupted (a two-team game showed a 30% "Other"). Normalization is now **scale-invariant**: values are divided by the sum of the listed options, so `{90,9,1}`, `{0.9,0.09,0.01}`, and `{60,30,10}` all map to the same distribution.
- **No more spurious "Other" on closed sets**: the sharpener/planner now add a catch-all option only when the named candidates genuinely leave outcomes uncovered. A head-to-head ("which team wins, A vs B?") lists only the named options and routes a not-played game to a void clause in the resolution criteria, instead of inventing an "Other" that can't happen.
- **`aggregateMc` hardening**: near-uniform "I don't know" panels are dropped (they only drag the aggregate toward uniform), and per-option outliers are winsorized once the panel is large enough — so a single mis-scaled ballot can't dominate an option.

### Calibrated numeric & date intervals
- **Robust linear opinion pool**: numeric/date panels now combine as a mixture of the forecasters' predictive CDFs, so genuine disagreement about location widens the interval instead of being averaged into false confidence (the old per-quantile median hid it). Winsorized and recentered on the robust median, so one wild panelist still cannot drag the center.
- **Interval dilation — the calibration loop intervals never had**: LLM predictive intervals are reliably too narrow. A conservative dilation widens the band out of the box (×1.15), and once ≥25 numeric/date forecasts resolve the factor is **re-learned from your own p10–p90 coverage** by pinball minimization (regularized toward identity), the numeric analogue of the binary recalibration layer. The pre-dilation quantiles are stored so the fit is never circular.
- **`swarm backtest` now replays interval forecasts**: a dedicated numeric/date table scores Vincentization vs the linear-opinion-pool vs default/learned dilation by pinball, interval score, and coverage — same out-of-fold + bootstrap-CI discipline as the binary path, and labelled when learned still equals the default.

### Market double-counting
- Forecasters consult `market_odds` (the market-anchored lens is told to), so the panel already reflects the market — then the engine blended the same market in again. The mechanical blend now adds only the **residual** weight (`max(0, w − 1/n)`), applied consistently live and in the re-learned weight, so a market the panel consulted is no longer counted twice. The market-anchored lens is asked to cite its market URL.

### Free-form question input
- The web composer no longer reads as if a resolution date is required: the date field is labelled optional and the placeholder says the horizon is inferred when blank. When the engine infers the date, the forecast headline tags it "· inferred" so you can sanity-check it.

### Charts render in the app
- `` ```chart `` blocks (line/bar/donut/stat) now render as charts **in the web UI's in-app report and task views**, not just the exported `.html`. Previously the in-app markdown renderer showed the raw `{"type":"stat",…}` JSON as a code block. A new dependency-free `ChartBlock` mirrors the server-side renderer (`src/charts.ts`); a malformed spec degrades to a quiet contained block, never a raw dump.

## 0.14.0

Open-ended forecasting: ask broad predictive questions, not just yes/no ones.

### Question decomposition
- **`swarm forecast "what will happen with X?"`** now fans an open-ended question out into a small set (up to 6) of concrete, independently-resolvable **sub-forecasts** — each with its own forecaster panel, mechanical aggregate, ledger row, market anchor, coherence probe, and calibration — then synthesizes one narrative answer that ties them together. A clean single question ("Will the Fed cut by 2026-09-01?") still resolves to exactly one forecast, unchanged.
- The engine plans the forecast first (model call → `{brief, questions[]}`), validates each sub-question through the same sharpening rules, assigns stable ids (`sf1…sfN`), and **clamps horizons** (operator `--by` wins; missing/past/absurd model dates fall back to today+90d / cap at ~5y). Best-effort and non-blocking: decomposition → single-question sharpening → mechanical binary fallback.
- **Echoes its interpretation**: the plan (brief + each sub-forecast, kind, and date) is journaled (`forecast.plan`) and printed, so a detached run shows exactly what it decided to forecast. Re-run with `--by`, `--panel`, or `--single` to steer.
- **`--single`** forces one forecast (skip decomposition). Per-sub-forecast panels auto-scale (≤4 each when decomposed) to keep the task count in budget; a shared research wave serves all sub-forecasts.
- Each sub-forecast is an independent ledger entry sharing a `setId` + `brief`, so `swarm resolve` scores them on their own dates and `swarm forecasts` groups them. Resolution and the calibration flywheel are unchanged — they were already per-entry.

### Settings surfaced in the web UI
- The Settings page now exposes every forecast knob: **market anchor weight**, **decompose open questions** (toggle), and **max sub-forecasts**, alongside the existing panel size / extremization k / coherence probe. Added the **Odds API key** field (de-vigged sportsbook consensus) and, under Swarm defaults, **verify attempts** and the **tool-result character cap**.
- `forecastMarketWeight` and `oddsApiKey` were settable but hidden — now visible, readable, and clearable like the other keys. New config keys `forecastDecompose` (default on) and `forecastMaxSubQuestions` (default 6), plus `maxToolResultChars`, are now in `SETTABLE_KEYS` (CLI `swarm config set` + UI).

## 0.13.0

A correctness, calibration-quality, and data-coverage release. No breaking changes; new tools and time-series sources are additive and keyless.

### Correctness fixes
- **Bootstrap CI off-by-one**: backtest confidence intervals used the wrong percentile indices (25/975 of 1000 instead of 24/974). Fixed to `round(b·α)−1`.
- **Market-weight grid never reached w=1.0**: `chooseMarketWeight` stopped at 0.9, so the system could never learn to fully defer to a consistently-right market. The grid now includes 1.0.
- **`fetch_url` double-truncation**: pages were truncated to 60K and then middle-cut *again* to the 20K tool-result cap, silently dropping the middle of every long document. Now a single truncation to `maxToolResultChars`, whose default is raised 20K → 50K.
- **Synthesizer could not recover clipped reports**: task reports are excerpted to 1600 chars in the synth prompt, but the synthesizer had no `read_report` tool — the rest was unreachable. It now has `read_report`, clipped excerpts are marked, and the prompt directs it to pull full text before writing dependent sections.
- **Dead `"primary"` source class revived**: `classifySource` never returned `"primary"`, so its +5 ranking bonus was unreachable. Authoritative publishers (WHO, IMF, World Bank, OECD, europa.eu, clinicaltrials.gov, SEC, …) now classify as primary, and non-US government TLDs (`.gov.uk`, `.gov.au`, `.gc.ca`, `.go.jp`, `.gouv.fr`) as government.

### Forecasting math
- **Golden-section adaptive k**: the extremization constant is now found by a coarse bracketing scan + golden-section refinement over [1, 6], replacing a 13-point grid that capped at 4.0 and could miss the optimum by 0.125.
- **Recalibration can deflate severe overconfidence**: the logistic fit's slope range widened to `a ∈ [0.1, 2.0]`, `b ∈ [−2, 2]` — the old 0.5 slope floor made strong LLM overconfidence uncorrectable.
- **Extremized `pNever`**: date-question never-mass now gets the same overlap-scaled extremized GMO as a binary panel (it *is* a binary forecast), instead of a raw GMO.
- **Real OLS prediction intervals**: `time_series project_to` now reports `t(n−2)·σ·√(1 + 1/n + (x−x̄)²/Sxx)` — a band that widens with extrapolation distance — instead of a flat ±1.28σ residual band that ignored parameter uncertainty.
- **Manifold play-money discount**: mana volume is discounted 50× to a real-money-equivalent before the liquidity floor and anchor weight, so a 10K-mana market no longer anchors like a $10K Polymarket book. The discounted volume is stored, so the learned weight refits consistently.
- **Median small-panel quantiles**: numeric panels below 10 forecasters aggregate each quantile by median (the old 10% trim removed nothing at real panel sizes and let one outlier drag the center); 10+ still trims.
- **Blended evidence overlap**: pairwise source overlap is now `0.7·Jaccard(URLs) + 0.3·Jaccard(domains)` — exact-URL matching alone under-detected shared sourcing and left k too high.
- **Separate MC calibration bins**: multiple-choice option probabilities no longer contaminate the binary reliability bins shown to future panels; the CLI renders both.

### Research orchestration
- **Faithfulness check in default mode**: the synthesis-vs-task-reports check now also runs under `verification: "normal"` for runs of ≥5 tasks (was strict-only).
- **Map-reduce synthesis for large runs**: at ≥40 tasks the synthesizer reads parallel cheap-model digests of role-grouped tasks instead of a middle-truncated 300K-char blob; full text stays one `read_report` away.
- **Research contradiction pass**: the conductor doctrine now prescribes a cross-task reviewer before synthesis — contradictions between scouts, single-source claims, stale data, irreconcilable numbers.
- **Strict verification fails closed**: a verdict that passes twice with zero tool-gathered evidence now fails the task back to the worker instead of being accepted with a warning.
- **Sources reach the bibliography**: URLs posted via `note(url=…)` now merge into the task's sources at report intake, the per-task source cap is raised 40 → 80, and a researcher that reports with no sources is flagged in the journal.
- **Re-forecasts respect panel size**: trigger-driven re-forecasts use the configured `forecastPanelSize` (capped at 5) instead of a hardcoded 3.

### New keyless data sources
- **`academic_search`** adds Semantic Scholar (with citation counts) and, for biomedical queries, PubMed — alongside arXiv and Crossref. Deep `web_search` sweeps the same engines.
- **`web_search` with `freshness`** also queries GDELT's DOC 2.0 article index — direct, mostly paywall-light news links — where scraped-engine date filters run thin.
- **`market_odds`** adds PredictIt (keyless real-money US politics; per-contract hits for multi-contract markets). It informs panels but is not used as a mechanical anchor (no published volume).
- **`time_series`** adds a `wikipageviews` source: daily Wikipedia pageviews as a public-attention leading indicator (clearly labeled attention, not probability).
- **`wiki_summary(title)`**: a new tool returning the Wikipedia REST summary for fast entity grounding without a scrape round-trip.
- **Wayback recovery**: `fetch_url` recovers the closest Internet Archive snapshot when a source returns an HTTP error, clearly labeled as archived.
- **Run-scoped fetch/search cache**: identical `fetch_url`/`web_search` calls across agents in a run coalesce into one network call (failures evicted so they retry) — a large win for wide swarms.

## 0.12.0

### Tournament mode: ledger velocity
- `swarm tournament [--count 10] [--close-within 14] [--source all] [--dry-run] [--auto]`: imports open binary questions that close within days from Manifold, Polymarket, and Kalshi (keyless; Metaculus when keyed), and batch-forecasts them with small cheap panels. The point is the calibration flywheel: every learned parameter (adaptive k, market weight, method weights, recalibration) feeds on resolved forecasts, and market questions resolve in days — with the platform publishing the ground truth. Idempotent (already-imported questions are skipped), round-robin balanced across platforms, `--auto` chains `swarm resolve` for cron.
- Tournament questions arrive pre-sharpened: the run bypasses the sharpener (`presetQuestion`) and the ledger records the provenance — platform, market id, URL, and the market's own price at import (`marketProbAtCreate`), the benchmark the swarm is later scored against. Tournament runs follow a compact doctrine (exactly two research scouts, no verification, no teams — fast, cheap, calibrated beats exhaustive) under a 4M default token budget (~$0.17/question on DeepSeek pricing, validated live).
- Platform-API resolution: a tournament forecast resolves by asking the source market what happened (Manifold resolution, Kalshi settlement, Polymarket settled prices, Metaculus resolution — annulments map to void) — ground truth for free, with the resolution mini-agent as fallback. Kalshi's API drift to `*_dollars` string fields is handled (this also silently broke `market_odds` Kalshi prices; fixed), and its auto-generated parlay markets are filtered out.

### Mechanical market anchoring
- The engine now anchors binary aggregates to a verified matching market price: `market_odds` at aggregation time, a term-overlap bar plus a cheap-model same-question check (a wrong anchor is worse than none), then a log-odds blend AFTER extremization — the market is already an aggregate, extremizing it like a panelist would double-count. Weight = `forecastMarketWeight` (default 0.4, 0 disables) × a liquidity factor (full weight at ~$100K volume), re-fit from the resolved ledger once 20+ anchored forecasts have resolved.
- Tournament runs skip anchoring entirely: anchoring a question imported from a market back to market prices would make the "did the panel beat the market" signal circular.
- The full aggregation chain is recorded in `aggregate.components` (panel GMO → extremized → market blend → recalibrated) — every layer re-fittable later, shown in the report, the run banner, and the ledger UI.

### Learning from the ledger
- **Method weights**: each forecasting lens's resolved Brier record tilts the weighted GMO (softmax on Brier vs the cross-method mean, shrunk toward equal weight by sample size; a method needs 5+ resolutions to deviate from weight 1). Weights are persisted per panelist in the ledger.
- **Two-parameter recalibration**: `logit(p′) = a·logit(p) + b` fitted on the resolved record by grid search minimizing log loss, regularized toward identity (γ = 2/n), applied as the final layer once 40+ binary forecasts have resolved. The intercept b corrects systematic YES-lean (LLM acquiescence) that no symmetric exponent can. Fitting always reads each entry's pre-recalibration components — never circular.
- **Panel diversity is enforced, not requested**: forecaster spawns carry `METHOD: <label>`; a batch with duplicate labels is rejected before id allocation with corrective feedback (red-team revision tasks may reuse their original label). The canonical menu adds **decomposition** (split the question into the conditional chain, estimate each link, multiply — the analytical gate demands at least two visible sub-probabilities) and **skeptic**. Submitted labels are canonicalized at intake — a revision that comes back as "trend (revised)" lands on "trend", so it replaces its original instead of double-counting the lens (observed live; the engine normalizes instead of hoping).

### New question kinds
- **Multiple-choice** (`kind: "mc"`, 2–8 options): panelists submit per-option probabilities (normalized at intake with a floor on unmentioned options), aggregated per option by weighted GMO → extremize → renormalize. Scored with multiclass Brier + log score; each option also feeds the reliability bins as a (probability, hit) pair. Resolution accepts `option`; the operator override accepts the option text.
- **Date** (`kind: "date"`): "when will X happen" — quantiles submitted as ISO dates, aggregated in epoch-days, plus a `p_never` mass (GMO across the panel) for "not by the horizon". Scored with pinball loss on the realized date and log score on the never-mass.

### Numeric upgrade
- Up to 7 quantiles (p5–p95; the p10/p50/p90 spine still required, crossings repaired by sorting), optional quantiles aggregate only when the whole panel provided them. Heavily right-skewed positive panels (median p90/p10 > 10) aggregate in log space automatically.
- **Pinball (quantile) loss** joins interval score at resolution — the proper score for quantile forecasts, approaching CRPS as quantiles densify.

### Resolution hardening + live triggers
- Medium-confidence machine resolutions get a second independent resolver; disagreement (outcomes differ, numeric values >1% apart, dates >1 day apart) surfaces for the operator instead of poisoning the calibration record, with both verdicts in the audit file.
- `swarm forecasts watch --reforecast`: a fired update trigger re-runs the SAME question with a fresh small panel; the new ledger record `supersedes` the stale one. Both ends of the chain still resolve and score — that history is exactly what shows whether updating helped — but watching follows the newest link.

### Data sources for every domain
- `time_series` gains **openmeteo** (daily weather for any coordinate; past dates use the ERA5 archive, turning weather base rates into counted frequencies — keyless), **nws** (official US hourly point forecasts — keyless), and **gdelttone** (media sentiment, labeled as sentiment-not-probability).
- **`options_implied`**: risk-neutral P(ticker > strike at date) from Yahoo's option chain via Black-Scholes N(d2) with the market's own implied vol — the financial gold standard for price-threshold questions (cookie+crumb session handling for Yahoo's gated v7 endpoint).
- **`wiki_tables`**: zero-dep extraction of Wikipedia data tables as TSV — the durable keyless home of election polling averages and base-rate lists.
- **The Odds API** (optional `oddsApiKey`, free tier): sportsbook h2h consensus joins `market_odds`, de-vigged (margin stripped, probabilities renormalized) and averaged across bookmakers.

### Backtest: prove it
- `swarm backtest`: replays every resolved binary forecast under each aggregation strategy — published headline, unextremized GMO, default k, adaptive k, + market anchor, + recalibration — with learned parameters fitted **out-of-fold** (10-fold by time order) so a strategy can't grade its own homework. Mean Brier with seeded-bootstrap 95% CIs, log loss, and the headline external benchmark: swarm vs the market's price at import on tournament entries. Deterministic, no tokens — the regression gate for every aggregation change.

### UI
- Forecasts page: aggregation-chain line per entry, tournament provenance badges (platform + market price at import, linked), a "vs market" stat card (swarm Brier vs market-at-import Brier), supersede-chain markers, mc option bars, date quantiles with the never-mass, pinball scores, and JSONL/CSV ledger export.
- Run banner: mc option bars, date ranges rendered as dates, P(never by horizon), and the aggregation chain under the question.

### Tests
- Unit suite grows to 214 (tournament mappers and platform resolutions, blend/liquidity/learned-weight math, method weights, recalibration fits, mc/date aggregation and scoring, pinball/log-space, de-vig, N(d2), wiki-table extraction, backtest determinism, method-label canonicalization); e2e grows a tournament-import phase (23 total): preset-question bypass, ledger origin, platform-resolution fallback. Validated live end-to-end: a real Polymarket question imported, forecast by a 3-panel + probe, and recorded with full provenance.

## 0.11.0

### Forecast mode: calibrated probabilities, end to end
- New run mode: `swarm forecast "<question>" [--by YYYY-MM-DD] [--panel N]` (or the mode toggle in the UI composer). The question is sharpened into a resolvable claim — neutral wording, explicit criteria, resolution date; an operator `--by` always wins — then research waves gather counted base rates and live data before an independent panel of 3–11 forecasters (default 5) works distinct methods: outside view, inside view, trend, market-anchored.
- Panel independence is mechanical, not requested: blanked blackboard, peer forecasts withheld from dependency digests, `read_report` blocked between panelists.
- Aggregation is deterministic TypeScript, never an LLM: median + extremized geometric-mean-of-odds headline (k=2.5 default; single-panelist runs pass through unextremized), 10%-trimmed-mean quantiles for numeric questions. Probabilities clamp to [1%, 99%].
- A red-team task attacks the panel's reasoning and panelists get a revision pass before synthesis. The final report and the run UI lead with the ensemble headline, the full panel spread, and each panelist's method.

### Anti-headline-bias mechanics (engine-owned, not prompt hopes)
- **Base-rate prior commitment**: every binary forecaster must state the probability its reference classes alone imply before weighing current evidence. Reports, the UI, and the ledger record "prior X% → final Y%", and the red team attacks deltas justified only by headlines.
- **Mechanical analytical gate**: forecasts with no prior, no named reference class, or no numbers in the rationale are rejected and retried with specific feedback. Wind-down-safe — at the attempt cap or budget exhaustion the forecast is accepted with a journaled warning instead of discarded.
- **Inverted-framing coherence probe** (`forecastCoherenceProbe`, default on): after the panel, the engine itself runs one cheap agent on the inverted question ("estimate P(NO), argue NO first"), flips the answer, and folds it into the panel as method `inverted-framing`. Atomically journaled — crash-safe and idempotent across resume.
- **Evidence-overlap-scaled extremization**: pairwise source overlap across the panel (canonical URLs) shrinks k toward 1, so a panel that read the same wire story isn't amplified as if it were five independent minds. Overlap is journaled, persisted to the ledger, shown in the report, and flagged in the UI above 50%.
- **Deterministic OLS trend projection**: `time_series` gains `project_to` — slope per day, projection at the resolution date, and an 80% residual band, computed by the engine. GDELT output now states that news volume measures attention, not probability.
- **Engine-injected time window**: every forecaster prompt includes "today is X; N days remain" with hazard-rate discipline, computed at spawn time.
- Doctrine: research scouts separate established facts from commentary, dedupe wire-republished stories, and produce counted base rates ("X of N — list the N"); the sharpener strips loaded framing from the question.

### Calibration flywheel
- Persistent ledger at `~/.agentswarm/forecasts/ledger.jsonl`: question, panel (with priors and methods), ensemble, evidence overlap, update triggers.
- `swarm resolve` runs bounded-parallel mini-agents against each due forecast's resolution criteria, writes an audit JSON per resolution, and scores Brier + log for binary, interval coverage for numeric. Unclear or low-confidence resolutions skip with an operator hint; `swarm resolve set <id> <outcome>` overrides manually.
- `swarm calibration` and a new **Forecasts** page in the web UI: ledger table with resolve buttons, stat cards, a reliability diagram, and per-method track records.
- The calibration block (overconfidence diagnosis, best/worst method) is injected into every future panel once 10 forecasts have resolved; with 30, the extremization constant is re-fit from your own history.
- `swarm forecasts watch` re-checks each open forecast's update triggers.

### Data sources
- `market_odds`: Manifold, Polymarket, Kalshi keyless — closed and resolved markets filtered out; Metaculus joins when a free API token is configured (`metaculusApiKey` — their API now requires one).
- `time_series`: FRED (free `fredApiKey`), World Bank, Yahoo Finance (replaces Stooq, which is behind a proof-of-work bot wall; query1→query2 host fallback with an honest throttle error), GDELT attention counts.
- Web search gains a freshness filter (DuckDuckGo `df=`, Bing `filters=`).

### Fixes
- Resuming a run that crashed between aggregation and the final report no longer appends a duplicate ledger record (the aggregate is restored from the journal).
- Research mode is byte-identical to 0.10.0 — every forecast behavior is gated on the run mode.

### Tests
- e2e grows a forecast phase (22 total): gate rejection and retry, the probe flip, overlap-scaled aggregation with every expected number re-derived from the shipped math, ledger persistence, resolution scoring. Unit suite grows to 168 tests (aggregation, scoring, ledger, calibration, OLS, overlap, gate).

## 0.10.0

### 256-agent swarms, honestly capped everywhere
- Parallel-agent ceiling raised to **256** and made consistent across every entry point: the config range, the settings UI, the mission launch form, and the hub's per-run option sanitizer (which was silently clamping UI-launched runs to 32 regardless of config).
- **Fixed a run-hanging bug**: `--workers abc` (or any non-numeric `--workers/--steps/--tasks/--budget`) coerced to NaN, which made the scheduler's `active < maxWorkers` check permanently false — the run started but no task ever ran. Numeric flags are now validated against the config ranges: garbage errors out immediately, out-of-range values clamp.
- Team sub-swarms: default size ceiling raised 16→32 (half the parent's cap), and an explicitly requested `team_max_workers` is now clamped to the parent run's `maxWorkers`. Both worker and budget clamps journal a visible warning with requested → granted numbers instead of adjusting silently.

### Orchestration hardening
- **Per-task wall-clock timeout** (`taskTimeoutMs` config, default 20 min, range 1 min–24 h): a hung shell command or stalled fetch now fails that attempt cleanly — journaled, retryable through the normal retry pipeline — instead of stalling the run until the operator cancels. Timeouts abort only the attempt; run cancellation is tracked separately and never confused with one.
- **Synthesis budget reserve**: scheduling and retries now stop while ~3% of the token cap (30K–120K) is still unspent, so the final report is composed inside the budget instead of blowing past it. The budget-reached log line states the reserve.
- **Synthesis retries**: a failed synthesizer call is retried once before falling back to the lossy task-summary report, and an empty report triggers one explicit re-ask.
- AIMD call gate can now floor at 1 concurrent call (was 2 — providers with a strict limit of 1 caused permanent 429 storms), and 429 `Retry-After` cooldowns are honored up to 5 minutes (was 60 s).

### Claims made true
- `academic_search` can now actually return 40 results: arXiv and Crossref per-source caps raised 15→20 each (the tool advertised "max 40" but could never exceed 30).
- SETTINGS_UI_GUIDE numeric limits section corrected (it misstated all four defaults).

## 0.9.0

### context.dev: fixed scrape endpoint + new search engine
- **Fixed a dead scrape endpoint**: fetch_url/scrape was POSTing `api.context.dev/v1/web/scrape` (does not exist, HTTP 403) and silently falling back to direct fetch — context.dev showed zero usage. Now uses the real `GET /v1/web/scrape/markdown`.
- Crawl request corrected: camelCase `maxPages` (capped at 500) and `urlRegex` (the API ignores `max_pages`/`include_paths`). `include_paths` globs (`/docs/*`) translate to proper wildcards.
- **context.dev Web Search** joins the search fan-out when a key is set (`POST /v1/web/search`, relevance-ranked, 1 credit/result). Deep mode uses the API's server-side `queryFanout` — one billed call per search, not one per expanded phrasing. New `searchBackend: "contextdev"` pinned mode with free-engine fallback on outage.
- Scrape/TinyFish fallbacks now log a visible warning instead of failing silently.

### True live source tracking
- Tool results journal a structured `urls[]` harvested from the FULL result text (the 200-char display summary holds 1-2 URLs; a search result names dozens). The run header, dashboard cards, CLI status line, and per-task badges all count real distinct sources, live.
- Server-side rollup: `RunSummary.sourceCount` (canonical-URL deduped, team sub-swarms included).
- Per-task live `⌕ n sources` badges on running cards; TaskDetail gained a Sources section with clickable cited links.

### Verification: artifact path normalization
- **Fixed false "claimed artifact(s) do not exist" failures**: agents narrate the same file as `artifacts/x.md`, `workspace/x.md`, `./x.md`, or an absolute path; the mechanical verifier now canonicalizes all forms to the registered name (with a tolerant existence check as a second layer). Previously this failed real work and burned retries.
- Workspace-only deliverables that pass verification are copied into the run's artifacts folder so operator links work.
- Directories no longer satisfy the artifact existence check (files only).

### Styled artifacts & charts
- `save_artifact` with a `.html` name renders MARKDOWN content through the house document shell — agents never hand-write HTML/CSS; every artifact matches the product style (typography, hairline tables, dark mode, self-contained, no scripts).
- New ` ```chart ` fenced blocks render dependency-free inline SVG: `line` (multi-series with gaps), `bar` (grouped), `donut`, and `stat` metric cards with deltas. Monochrome, currentColor-based; malformed specs render a visible error block.
- Final report HTML restyled: 720px measure, mono uppercase meta strip, hairline tables, understated links.

### UI polish
- **Artifacts tab** on the run page: deliverables grouped by folder, final report pinned first.
- Activity feed decluttered: ok results fold into their call rows, duplicate note/report rows removed, task identity shown once per burst, `[exit 0]` prefixes stripped.
- Typography uniformity: one label style and one `HH:MM` clock across Activity/Conductor/Blackboard; note keys render as sans titles; conductor feed matches the rest of the rail.
- Header now shows true `⌕ sources` and `↧ artifacts` separately (sources was previously the artifact count, mislabeled).

## 0.8.0

### Exhaustive research: 10x source depth
- Search count defaults raised: `web_search` default 8→15 (max 25→50), `academic_search` 8→15 (max 20→40). Agents can now pull far more results per call.
- Query expansion doubled: `expandQueries` generates up to 6 complementary phrasings (original, keyword core, guide angle, quoted phrase, recency variants) instead of 3. Questions also get precision and freshness variants.
- Deep-mode page fetching: increased from 12→25 pages per deep search. More pages = more quotable passages extracted and ranked.
- Per-engine result cap: raised 15→25 results per search engine, multiplied across query variants and engines.
- Researcher role hint: made prescriptive — minimum 8 sources per task, 3-4 separate searches with different angles required. Explicit source reporting in `report(..., sources=[...])`.
- **Result**: Each researcher task now pulls 15-25 sources instead of 2, making swarms truly exhaustive.

### Context.dev priority & reliability
- Backend priority reordered: context.dev now wins auto-selection (was: firecrawl→context.dev→deepcrawl; now: context.dev→firecrawl→deepcrawl). Cost-effective and fast by default.
- Robust response parsing: handles multiple context.dev API response shapes (flat `{markdown}`, nested `{results[0]}`, alternative `{data}`). Crawl endpoint also handles `pages` and `data` field names.
- Crawl filtering: skips empty pages, handles `content`/`text` fallbacks, filters by URL presence. More resilient to API variations.
- Added CONTEXT_DEV_SETUP.md: complete setup guide, diagnostics, troubleshooting, API details, testing endpoints.

### API key management via web UI
- All API keys now configurable in Settings (no env vars needed, though supported):
  - Web search: TinyFish key
  - Crawl integrations: Firecrawl, context.dev, deepcrawl keys + base URLs
  - Sandbox: E2B, Modal, Vercel keys
  - Model provider: per-provider keys
- Settings persist to `~/.agentswarm/config.json` and reload on next start.
- One-click "Clear" buttons to remove saved keys without editing JSON.
- Test endpoints for each backend: "Test search engines", "Test crawl backend", etc.
- Updated UI description to show new context.dev priority in auto mode.
- Added SETTINGS_UI_GUIDE.md: comprehensive guide to configuring all options.

## 0.7.0

Clean sync release: comprehensive integration of all v0.6.0 features (cited research, academic search, PDF extraction, search cooldowns, freshness ranking, conductor ledger re-seeding, cascade diagnostics, mechanical verification, verifier dependency context, strict evidence mode, context windows config, grep_files + atomic multi-edit, plan tab, blackboard search filters, budget sparkline, localhost CORS, symlink-safe writes, atomic memory, plus 15 review-hardening fixes). Fully tested: 116 unit tests, 21 e2e phases. Production ready.

## 0.6.0

### Cited research & academic search
- Sources pipeline: workers' `note(url=...)` and `fetch_url`/`crawl_site` discoveries flow to the final report as deduplicated, numbered citations `[1]` with a full bibliography. Supports inline attribution so readers know which source backs which claim.
- Keyless academic search: `academic_search` tool queries arXiv (preprints) and Crossref (published works) directly — no API key needed, powered by OpenSearch protocols.
- PDF text extraction: `fetch_url` now extracts plain text from PDFs (zero runtime deps; uses zlib only) and flags paywall shells so agents know when they hit a wall.

### Search & research quality
- Engine rate-limit cooldowns: when a search endpoint returns 429, the engine skips it for a configurable window instead of failing the whole search; the conductor re-plans without that engine.
- Query reformulation: if a search returns zero results, the query reformulates to keywords automatically, widening recall without noise. Visible in the activity log.
- Freshness ranking: search results are scored by publication date, so recent content bubbles up; agents writing about 2025 news get current sources.

### Conductor long-horizon memory
- Mission ledger re-seeding on resume: the conductor is seeded with settled tasks, key decisions, and the current phase so it resumes without losing context — no need to replay the whole history.
- Cascade failure diagnostics: when a task fails, dependent tasks are blocked and receive the root cause (not just "dependency did not complete"). Failed tasks surface their last failing tool call as diagnostics.
- Interim progress snapshots: every 25 settled tasks, the plan and partial findings are saved to `artifacts/` — multi-day runs always have a recent checkpoint.

### Verification & quality
- Mechanical format pre-check: before any LLM verifier runs, claimed JSON/CSV/HTML artifacts are validated for structure (not just existence). Speeds up feedback cycles.
- Verifier dependency context: verifiers receive copies of all upstream reports so they can judge a deliverable in context, not in isolation.
- Structured verification issues: failed verifications now carry problem/evidence/fix fields so retries are precise. Strict mode demands tool-gathered evidence (a pass statement alone is insufficient) and adds a completeness critic before synthesis.

### Agent tools & config
- `grep_files` tool: structured content search with path:line:text output, portable across all sandboxes (host/Docker/E2B/Modal/Vercel).
- `replace_in_file` atomic batches: edit multiple locations in one file atomically — all edits apply or none do.
- Context windows config: `contextWindows` maps models to their actual context limits; the engine respects each model's window and compacts accordingly.
- Blackboard search now supports `kind` filters to find decisions, findings, or context without noise; results include source URLs.

### Plan & settings
- Plan tab in the UI: SideRail now shows the living `mission-plan.md` (read-only); the conductor can update it from `swarm note <id> "update the plan: ..."`.
- Budget sparkline: run page displays at-a-glance token budget remaining.
- Settings diagnostics: `/api/crawl/test` and `/api/search/test` endpoints test your configured backends; Settings page now has test buttons for crawl/search/embedding.
- Config management: `swarm config unset <key>` removes a setting; Settings UI includes affordances to clear keys and test backend connectivity.

### Hardening
- Localhost-only CORS: the hub API only accepts requests from localhost origins (`http://localhost:*`); external browsers cannot trigger runs or exfiltrate results.
- Symlink-safe write confinement: safe mode now blocks symlink escapes to parent directories, preventing agents from writing through symlinks that point outside the workdir.
- Atomic runId-keyed memory: cross-run memory entries are keyed by runId and update in place; interim snapshots preserve partial state without losing atomicity.
- Bounded remote sandbox transfers: remote runs pull artifacts with size caps and timeouts; local caches are pruned automatically.

## 0.5.0

### Task-fit deliverables (not just markdown)
- Every run now writes `artifacts/final-report.html` next to `final-report.md`: a styled, self-contained document (inline CSS, light/dark aware, real tables and code blocks, no scripts) rendered by a built-in dependency-free markdown renderer — failure and fallback reports included. `swarm report <id> --open` opens the HTML.
- Deliverables ship in the format the mission actually needs: the conductor now specs output formats per task (runnable code, `.csv`/`.json` data, self-contained `.html` documents), workers and the writer role are steered the same way, and the synthesizer gained `save_artifact` so it can capture structured findings (rankings, comparisons, datasets) as data files before submitting.

### Native search & crawl stack
- Multi-engine web search built in: DuckDuckGo (two endpoints) + Bing + TinyFish (when keyed) queried in parallel, quality-ranked, and deduped by canonical URL — one engine failing or bot-challenged never blanks results. Deep mode widens the query into complementary phrasings, fetches the top pages, and returns quotable passages with publication dates. Ranking/passage algorithms live in `src/searchcore.ts`; the external `searchkit` CLI dependency is gone.
- Crawl/scrape backends: Firecrawl, context.dev, and custom deepcrawl endpoints (`crawlBackend`, auto-resolved from configured keys). Workers get a `crawl_site` tool that ingests whole documentation sites into local markdown, and `fetch_url` upgrades to a real-browser scrape when a backend is configured. New keys are settable via config/UI/env and masked from agent shell environments.
- `maxToolResultChars` default raised 12k → 20k.

### UI
- Run page redesign: continuous process-spine activity feed, compact one-line rows for settled tasks, tool errors summarized to calm one-liners, and workspace-relative paths throughout.
- Settings page covers the new search/crawl backends with masked key status from the hub's public config.
- Planet Kosmos display font for the wordmark and page headings.

## 0.4.0

### UI polish
- Everything a model writes now renders as rich text: task objectives, reports, verifier feedback, conductor commentary, blackboard notes, agent output, and the mission summary all go through one markdown renderer with a standardized type scale (compact 13px prose for rails/drawers, full prose for reports).
- Blackboard notes show their kind (decision / open-question / handoff / claim) — decisions get the solid badge.
- Task cards and the task drawer surface the new run semantics: sub-swarm (⌬) and model-tier markers, key facts / open questions / files touched handoff sections, and the latest checkpoint on in-flight tasks.
- The web UI partitions hierarchical-team events correctly: a team's hundred sub-tasks never pollute the root board, while its cost and tool activity still roll up.

### Extra-large swarms (100-agent scale)
- Global AIMD call limiter (`maxConcurrentCalls`, default 16): bounds concurrent streams per provider endpoint, halves on 429 (respecting Retry-After), recovers additively; conductor calls jump the queue. `limiter.state` events surface adjustments.
- Conductor settle debouncing: settles batch for ~2s of quiet (or an active-worker-scaled cap) before waking the conductor; reports past 12 per update become one-liners with `read_report` available to the conductor.
- Task-table and ledger digesting: settled waves collapse to one line each on big runs; failures stay itemized forever. `maxWorkers` clamp raised to 128; `maxTasks` default to 200.
- Hierarchical teams: `spawn_tasks` accepts `team:true` — the task runs as a sub-swarm with its own conductor (shared sandbox, blackboard, and budget; child events journaled with `teamId`) and reports one consolidated result. One nesting level.
- Model tiering: spawn specs take `model:"cheap"|"strong"`; config `cheapModel`/`strongModel`. Verifiers use the strong tier.
- Delta quieting under load: streaming chatter thins above 24 active agents and mutes thinking streams above 48; hub SSE supports `?quiet=1`.
- Advisory file claims (`note(kind:"claim", key:<path>)`) with write-tool warnings on contested paths.

### Long-horizon
- Living plan document: conductor `update_plan` tool maintains `artifacts/mission-plan.md`, pinned into every update and restored on resume.
- Periodic progress snapshots: every 25 settled tasks a cheap-tier interim report lands in `artifacts/progress-report-<n>.md` without blocking scheduling.
- Cross-run memory: real-directory runs record mission/outcome/decisions to `~/.agentswarm/memory/`; the next run in the same workspace starts with that context.

### Long-horizon durability
- Task checkpoints: workers journal progress summaries at every context compaction and via a new `checkpoint` tool; resumed runs restart in-flight tasks warm with their last checkpoint instead of from scratch.
- Journal hardening: append failures are tracked and degrade the run loudly instead of being silently swallowed; SIGTERM/SIGINT flushes the journal and records `interrupted` synchronously.
- Conductor circuit breaker: repeated conductor call failures back off and end the run with a clear reason instead of looping forever.
- Sandbox teardown is bounded by a timeout so crashed containers can't hang shutdown.
- Stale-run detection adapts to recent model-call latency instead of a fixed 20s window.

### Context & memory
- Blackboard notes gain categories (finding / decision / open-question / handoff); decisions are never trimmed out of the conductor digest; new `search_notes` worker tool.
- Dependency reports are inlined as capped excerpts with a `read_report` tool for full text on demand.
- Structured handoffs: reports can carry `key_facts`, `open_questions`, and `files_touched`.
- Conductor milestones: new `set_phase` tool plus a mission ledger that survives history trimming and resume.

### Thoroughness
- Blind verification: the verifier judges the deliverables without the worker's reasoning or blackboard.
- Mechanical pre-verification: claimed artifacts must exist and be non-empty before any LLM verifier runs.
- `verifyMaxAttempts` is configurable; strict mode adds an end-of-run completeness pass and a synthesis consistency check.
- Verifying tasks no longer hold a worker slot.

### Quality infrastructure
- GitHub Actions CI (Node 20 + 22): typecheck, unit tests, mock-server e2e.
- New unit test suite (`node --test test/unit/`) for the state reducer and journal.
- Budget warnings at 50/80/95% spend.

## 0.3.0

- Multi-provider support, sandbox runtimes (host/Docker/E2B/Modal/Vercel), web UI, resume, verification, budget enforcement.
