//! Agent-managed context tree (engine feature `contextTree`).
//!
//! The model's window is finite; this module gives the model a **view** of what
//! is in or around it, and a **selection** it can steer, while three things stay
//! outside its reach:
//!
//! * the **law** — `sys/core` (the locked rules prompt) and the memory rules are
//!   always in the request and cannot be unloaded;
//! * the **truth** — `turn_archive`, `tool_results` and the immutable policy
//!   turn-range summaries are never written by a context action; an action only
//!   changes *what is sent*;
//! * the **evidence** — every node points at the row it came from, so anything
//!   taken out of the window is retrievable again (see `recall_turns`).
//!
//! This file tree is staged:
//!
//! * [`model`]  — node ids, kinds, states, the transition table, value score
//! * [`budget`] — the single source of truth for every number the model sees
//! * [`tools`]  — the `ctx` tool definition and its size guard
//!
//! Nothing here mutates storage yet: the store, indexer and assembler arrive in
//! later stages (see `docs/context-tree/IMPLEMENTATION_PLAN.md` in the branch
//! that introduced this module). Keeping the pure parts first means the numbers
//! and the state machine are testable without a database or a provider.

pub mod assemble;
pub mod budget;
pub mod catalog;
pub mod dispatch;
pub mod gc;
pub mod model;
pub mod ops;
pub mod reading;
pub mod render;
#[cfg(test)]
mod scenarios;
pub mod select;
pub mod settings;
pub mod store;
pub mod tools;
pub mod wiring;
