//! The numbers the model is shown, computed in one place.
//!
//! Every surface that talks about "room left" — the checklist, `ctx` results, the
//! assembly record, the safety net, overflow retries — asks this module. If two
//! places computed the budget differently, the model would be told it has room it
//! does not have, and the next request would fail at the provider.
//!
//! The formula is the engine's existing one (see
//! `agent_loop::effective_context_token_budget`), extended with the two blocks the
//! tree adds:
//!
//! ```text
//! window      = min(model window, configured cap)                 (caller resolves)
//! locked      = sys/core + sys/memory + essentials + tool schemas
//!             + the in-flight tool group + the newest user prompt
//! selectable  = window − reserve_out − headroom − locked
//! used_sel    = Σ tokens of in/note/temp nodes + checklist + resume block
//! free        = selectable − used_sel
//! compact_at  = selectable × threshold_percent / 100
//! ```
//!
//! `headroom` is `CONTEXT_WINDOW_HEADROOM_TOKENS` (2,048) plus the provider's
//! per-request overhead, as the engine already does. It is an input here so the
//! two call sites cannot drift apart.

/// Headroom the engine keeps free on every request (`agent_loop.rs`: 2,048).
pub const DEFAULT_HEADROOM_TOKENS: u64 = 2_048;

/// Below this much selectable room the window cannot hold a useful request: the
/// engine sends the locked set plus the newest user prompt only and says so
/// (`context.tree_starved`), instead of letting the provider reject the call.
pub const MIN_SELECTABLE_TOKENS: usize = 1_024;

/// Default warning thresholds, as percentages of the compaction point.
pub const WARN_SOFT_PERCENT: u64 = 85;
pub const WARN_HARD_PERCENT: u64 = 100;
pub const FORCE_PERCENT: u64 = 115;

/// Inputs to the computation. All token counts are in the active model's tokens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BudgetInput {
    /// The model's usable window, after the catalog/learned/user cap (never 0).
    pub window: u64,
    /// Output tokens reserved for this call (`max_tokens`).
    pub reserve_out: u32,
    /// Framing headroom kept free.
    pub headroom: u64,
    /// Tokens the model cannot remove: locked prompt parts, essentials, tool
    /// schemas, the in-flight tool group and the newest user prompt.
    pub locked: usize,
    /// Floor below which the window is treated as starved.
    pub min_selectable: usize,
}

impl BudgetInput {
    /// The engine's defaults for one call.
    pub fn new(window: u64, reserve_out: u32, locked: usize) -> Self {
        BudgetInput { window, reserve_out, headroom: DEFAULT_HEADROOM_TOKENS, locked, min_selectable: MIN_SELECTABLE_TOKENS }
    }
}

/// The result: what the model is shown, and what the engine enforces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Budget {
    pub window: u64,
    pub reserve_out: u32,
    pub headroom: u64,
    pub locked: usize,
    /// Room for everything the model can steer. Never negative.
    pub selectable: usize,
    /// Tokens currently selected (`in`/`note`/`temp` + checklist + resume),
    /// clamped to `selectable` for display.
    pub used_sel: usize,
    /// The same total *before* the clamp: what the selection really asks for.
    /// The eviction ladder must start from this number. Starting from the
    /// clamped `used_sel` made a selection twice the window look like one that
    /// just fits, so the policy evicted far too little (and `force` could
    /// never trigger when it sat at `selectable`).
    pub demand: usize,
    /// `selectable − used_sel`, never negative.
    pub free: usize,
    /// Where the automatic compaction point sits, in selected tokens.
    pub compact_at: usize,
    pub warn_soft: usize,
    pub warn_hard: usize,
    pub force: usize,
    /// True when `selectable < min_selectable`: only the locked set is sent.
    pub starved: bool,
}

impl Budget {
    /// Compute the budget. `threshold_percent` is the chat's compaction policy
    /// (`CompactionPolicy.threshold_percent`, clamped by the engine to 10..=100).
    pub fn compute(input: BudgetInput, used_sel: usize, threshold_percent: u64) -> Budget {
        let reserved = (input.reserve_out as u64).saturating_add(input.headroom);
        let selectable_u64 = input.window.saturating_sub(reserved).saturating_sub(input.locked as u64);
        let selectable = selectable_u64.min(usize::MAX as u64) as usize;
        let starved = selectable < input.min_selectable;
        let demand = used_sel;
        let used_sel = used_sel.min(selectable);
        let free = selectable.saturating_sub(used_sel);
        let pct = threshold_percent.clamp(10, 100) as usize;
        let compact_at = (selectable / 100).saturating_mul(pct);
        // Warnings are relative to the compaction point but can never point past
        // the window itself: a "100%" that is larger than what fits is a lie.
        let clamp = |percent: u64| -> usize {
            let v = ((compact_at as u64).saturating_mul(percent) / 100) as usize;
            v.min(selectable)
        };
        Budget {
            window: input.window,
            reserve_out: input.reserve_out,
            headroom: input.headroom,
            locked: input.locked,
            selectable,
            used_sel,
            demand,
            free,
            compact_at,
            warn_soft: clamp(WARN_SOFT_PERCENT),
            warn_hard: clamp(WARN_HARD_PERCENT),
            force: clamp(FORCE_PERCENT),
            starved,
        }
    }

    /// Would `extra` more tokens still fit?
    pub fn fits(&self, extra: usize) -> bool {
        extra <= self.free
    }

    /// How far over the compaction point the selection is (0 when under).
    pub fn over_compact_at(&self) -> usize {
        self.demand.saturating_sub(self.compact_at)
    }

    /// The same selection against a scaled window, for a provider-overflow retry
    /// (`OVERFLOW_FACTORS = [0.60, 0.35]`). The tree itself is not modified: the
    /// scaled result is per call, so the model's choices survive the retry.
    pub fn scaled(&self, factor: f64, min_selectable: usize) -> Budget {
        let f = factor.clamp(0.05, 1.0);
        let selectable = ((self.selectable as f64) * f).floor() as usize;
        let used_sel = self.used_sel.min(selectable);
        let compact_ratio = if self.selectable > 0 { self.compact_at as f64 / self.selectable as f64 } else { 0.0 };
        let compact_at = ((selectable as f64) * compact_ratio).floor() as usize;
        let clamp = |percent: u64| -> usize {
            (((compact_at as u64).saturating_mul(percent)) / 100) as usize
        };
        Budget {
            selectable,
            used_sel,
            free: selectable.saturating_sub(used_sel),
            compact_at,
            warn_soft: clamp(WARN_SOFT_PERCENT).min(selectable),
            warn_hard: clamp(WARN_HARD_PERCENT).min(selectable),
            force: clamp(FORCE_PERCENT).min(selectable),
            starved: selectable < min_selectable,
            ..*self
        }
    }

    /// What the model is told, in one line (the checklist header).
    pub fn headline(&self, model: &str) -> String {
        format!(
            "model {} · window {} · output reserve {} · used {} / {} ({}%) · compact at {} ({}%)",
            if model.is_empty() { "unknown" } else { model },
            group(self.window as usize),
            group(self.reserve_out as usize),
            group(self.used_sel),
            group(self.selectable),
            percent(self.used_sel, self.selectable),
            group(self.compact_at),
            percent(self.compact_at, self.selectable),
        )
    }
}

fn percent(part: usize, whole: usize) -> usize {
    if whole == 0 { 0 } else { (part.saturating_mul(100)) / whole }
}

/// `1234567` → `1,234,567`, so a 128k window reads like a number, not a blur.
fn group(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selectable_never_goes_negative() {
        // Tools + system larger than the window: the classic 8k-with-100-tools case.
        let b = Budget::compute(BudgetInput::new(8_192, 4_096, 9_000), 0, 70);
        assert_eq!(b.selectable, 0);
        assert!(b.starved);
        assert_eq!(b.free, 0);
        assert_eq!(b.compact_at, 0);
    }

    #[test]
    fn the_formula_matches_the_engine() {
        // window 128_000, reserve 8_000, headroom 2_048, locked 12_000
        let b = Budget::compute(BudgetInput::new(128_000, 8_000, 12_000), 30_000, 70);
        assert_eq!(b.selectable, 128_000 - 8_000 - 2_048 - 12_000);
        assert_eq!(b.free, b.selectable - 30_000);
        assert_eq!(b.compact_at, (b.selectable / 100) * 70);
        assert!(!b.starved);
    }

    #[test]
    fn a_tiny_window_is_starved_not_broken() {
        let b = Budget::compute(BudgetInput::new(4_096, 1_024, 2_048), 0, 70);
        assert!(b.starved, "4096 − 1024 − 2048 − 2048 leaves nothing");
        assert_eq!(b.selectable, 0);
        let ok = Budget::compute(BudgetInput::new(8_192, 1_024, 2_048), 0, 70);
        assert!(!ok.starved);
        assert_eq!(ok.selectable, 8_192 - 1_024 - 2_048 - 2_048);
    }

    #[test]
    fn warnings_are_relative_and_never_past_the_window() {
        let b = Budget::compute(BudgetInput::new(1_000, 100, 0), 0, 100);
        // selectable = 1_000 − 100 − 2_048 → 0 (headroom dominates)
        assert_eq!(b.selectable, 0);
        assert_eq!(b.warn_soft, 0);
        let b = Budget::compute(BudgetInput { headroom: 0, ..BudgetInput::new(10_000, 0, 0) }, 0, 100);
        assert_eq!(b.compact_at, 10_000);
        assert_eq!(b.warn_soft, 8_500);
        assert_eq!(b.warn_hard, 10_000);
        assert_eq!(b.force, 10_000, "115% is clamped to what actually fits");
    }

    #[test]
    fn used_is_clamped_and_free_never_lies() {
        let b = Budget::compute(BudgetInput::new(20_000, 0, 0), 999_999, 70);
        assert_eq!(b.used_sel, b.selectable);
        assert_eq!(b.free, 0);
        assert!(!b.fits(1));
    }

    #[test]
    fn overflow_scaling_keeps_the_compaction_ratio() {
        let b = Budget::compute(BudgetInput::new(128_000, 8_000, 12_000), 40_000, 70);
        let s60 = b.scaled(0.60, MIN_SELECTABLE_TOKENS);
        assert_eq!(s60.selectable, ((b.selectable as f64) * 0.60).floor() as usize);
        assert_eq!(s60.used_sel, 40_000.min(s60.selectable));
        // The ratio compact_at/selectable is preserved (70%).
        assert!((s60.compact_at as f64 / s60.selectable as f64 - 0.70).abs() < 0.01);
        let s35 = b.scaled(0.35, MIN_SELECTABLE_TOKENS);
        assert!(s35.selectable < s60.selectable);
    }

    #[test]
    fn headline_reads_like_a_sentence() {
        let b = Budget::compute(BudgetInput::new(128_000, 8_000, 12_000), 61_240, 70);
        let line = b.headline("gpt-x");
        assert!(line.starts_with("model gpt-x · window 128,000"), "{line}");
        assert!(line.contains("output reserve 8,000"), "{line}");
        // 61,240 / 105,952 = 57%, and 74,130 / 105,952 = 69%
        assert!(line.contains("(57%)"), "{line}");
        assert!(line.contains("compact at 74,130 (69%)"), "{line}");
        assert!(!line.contains("{}"));
    }

    /// Deterministic pseudo-random sweep: the invariants hold for every shape of
    /// window, not just the examples above (no extra dependency, no flakiness).
    #[test]
    fn invariants_hold_over_a_deterministic_sweep() {
        let mut seed: u64 = 0x5DEECE66D;
        let mut next = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) as u64
        };
        for _ in 0..2_000 {
            let window = 512 + next() % 400_000;
            let reserve = (next() % 16_384) as u32;
            let headroom = next() % 4_096;
            let locked = (next() % 40_000) as usize;
            let used = (next() % 60_000) as usize;
            let pct = next() % 121;
            let b = Budget::compute(BudgetInput { window, reserve_out: reserve, headroom, locked, min_selectable: MIN_SELECTABLE_TOKENS }, used, pct);
            assert!(b.selectable <= window as usize);
            assert!(b.used_sel <= b.selectable);
            assert!(b.free <= b.selectable);
            assert_eq!(b.free, b.selectable - b.used_sel);
            assert!(b.compact_at <= b.selectable);
            assert!(b.warn_soft <= b.warn_hard);
            assert!(b.warn_hard <= b.force);
            assert!(b.force <= b.selectable);
            assert_eq!(b.starved, b.selectable < MIN_SELECTABLE_TOKENS);
        }
    }
}
