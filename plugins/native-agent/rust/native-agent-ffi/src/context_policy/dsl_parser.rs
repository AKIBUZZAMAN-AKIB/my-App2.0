//! The policy DSL: JSON with the keys of the TCPE design (`version`,
//! `defaults`, `policies`, `rules`, `exclusions`), and a small hand-written
//! condition language for the leaves of `if`.
//!
//! A condition is either a JSON object (`{"all": [...]}`, `{"any": [...]}`,
//! `{"not": ...}`) or a string such as `request.category == "device_action"`.
//! Strings are read by a tokenizer and a recursive-descent parser into the same
//! `Cond` tree. There is no function call, no file, network or shell access, no
//! `eval`: the only thing a condition can do is compare a named fact with a
//! literal. Depth, size and string length are bounded.
//!
//! This module only reads: it reports shape errors with their path. Whether a
//! field, operator, policy or exclusion is allowed is `dsl_validator`'s job.

use serde_json::Value;

/// Deepest nesting of `all` / `any` / `not` / parentheses.
pub const MAX_DEPTH: usize = 8;
/// Most leaf conditions in one rule.
pub const MAX_CONDITIONS: usize = 32;
/// Longest condition string and longest string literal.
pub const MAX_STRING: usize = 200;

/// A literal on the right of an operator.
#[derive(Debug, Clone, PartialEq)]
pub enum Lit {
    Str(String),
    Num(i64),
    Bool(bool),
    List(Vec<Lit>),
}

impl Lit {
    pub fn type_name(&self) -> &'static str {
        match self {
            Lit::Str(_) => "string",
            Lit::Num(_) => "number",
            Lit::Bool(_) => "boolean",
            Lit::List(_) => "list",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Eq,
    Ne,
    In,
    Contains,
    Lt,
    Le,
    Gt,
    Ge,
}

impl Op {
    pub fn as_str(&self) -> &'static str {
        match self {
            Op::Eq => "==",
            Op::Ne => "!=",
            Op::In => "in",
            Op::Contains => "contains",
            Op::Lt => "<",
            Op::Le => "<=",
            Op::Gt => ">",
            Op::Ge => ">=",
        }
    }
}

/// A parsed condition.
#[derive(Debug, Clone, PartialEq)]
pub enum Cond {
    All(Vec<Cond>),
    Any(Vec<Cond>),
    Not(Box<Cond>),
    Cmp { field: String, op: Op, value: Lit },
    Exists(String),
}

impl Cond {
    /// Every leaf (comparison or `exists`), in order.
    pub fn leaves(&self) -> Vec<&Cond> {
        match self {
            Cond::All(v) | Cond::Any(v) => v.iter().flat_map(|c| c.leaves()).collect(),
            Cond::Not(c) => c.leaves(),
            leaf => vec![leaf],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Defaults {
    pub policy: String,
    pub start: String,
    pub end: String,
    pub on_error: String,
    pub max_retries: i64,
    pub unknown_policy: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PolicyEntry {
    pub id: String,
    pub name: Option<String>,
    pub defaults: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Rule {
    pub id: String,
    pub enabled: bool,
    pub priority: i64,
    pub cond: Cond,
    pub policy: String,
    pub params: Option<Value>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Exclusions {
    pub categories: Vec<String>,
    pub groups: Vec<String>,
    pub turn_ids: Vec<String>,
    pub item_ids: Vec<String>,
}

impl Exclusions {
    pub fn is_empty(&self) -> bool {
        self.categories.is_empty()
            && self.groups.is_empty()
            && self.turn_ids.is_empty()
            && self.item_ids.is_empty()
    }
}

/// A whole rule file, read but not yet validated.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RuleSet {
    pub version: i64,
    pub defaults: Defaults,
    pub policies: Vec<PolicyEntry>,
    pub rules: Vec<Rule>,
    pub exclusions: Exclusions,
}

/// One problem, with where it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DslError {
    pub path: String,
    pub message: String,
}

impl DslError {
    pub fn new(path: impl Into<String>, message: impl Into<String>) -> DslError {
        DslError {
            path: path.into(),
            message: message.into(),
        }
    }

    pub fn to_json(&self) -> Value {
        serde_json::json!({ "path": self.path, "message": self.message })
    }
}

impl std::fmt::Display for DslError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.path, self.message)
    }
}

/// The built-in rule set: T7 only, no rules, no exclusions.
pub fn builtin_default() -> RuleSet {
    RuleSet {
        version: 1,
        defaults: Defaults {
            policy: "T7".into(),
            start: "first_tool_call".into(),
            end: "task_completed".into(),
            on_error: "retry_then_fallback".into(),
            max_retries: 2,
            unknown_policy: "T7".into(),
        },
        policies: Vec::new(),
        rules: Vec::new(),
        exclusions: Exclusions::default(),
    }
}

fn str_at(
    obj: &serde_json::Map<String, Value>,
    key: &str,
    path: &str,
    errors: &mut Vec<DslError>,
) -> Option<String> {
    match obj.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => {
            errors.push(DslError::new(format!("{path}.{key}"), "must be a string"));
            None
        }
    }
}

fn str_list(v: Option<&Value>, path: &str, errors: &mut Vec<DslError>) -> Vec<String> {
    match v {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => {
            let mut out = Vec::new();
            for (i, x) in a.iter().enumerate() {
                match x.as_str() {
                    Some(s) if s.chars().count() <= MAX_STRING => out.push(s.trim().to_string()),
                    Some(_) => errors.push(DslError::new(
                        format!("{path}[{i}]"),
                        format!("longer than {MAX_STRING} characters"),
                    )),
                    None => errors.push(DslError::new(format!("{path}[{i}]"), "must be a string")),
                }
            }
            out
        }
        Some(_) => {
            errors.push(DslError::new(path, "must be a list of strings"));
            Vec::new()
        }
    }
}

/// Read a rule file. Missing sections take the built-in defaults; every shape
/// error is returned at once.
pub fn parse(doc: &Value) -> Result<RuleSet, Vec<DslError>> {
    let mut errors = Vec::new();
    let Some(root) = doc.as_object() else {
        return Err(vec![DslError::new(
            "$",
            "the rule file must be a JSON object",
        )]);
    };
    let mut set = builtin_default();
    for key in root.keys() {
        if !matches!(
            key.as_str(),
            "version" | "defaults" | "policies" | "rules" | "exclusions"
        ) {
            errors.push(DslError::new(key.clone(), "unknown section"));
        }
    }
    match root.get("version") {
        Some(v) => match v.as_i64() {
            Some(n) => set.version = n,
            None => errors.push(DslError::new("version", "must be a number")),
        },
        None => errors.push(DslError::new("version", "is required")),
    }
    if let Some(d) = root.get("defaults") {
        match d.as_object() {
            Some(o) => {
                for key in o.keys() {
                    if !matches!(
                        key.as_str(),
                        "policy" | "start" | "end" | "on_error" | "max_retries" | "unknown_policy"
                    ) {
                        errors.push(DslError::new(format!("defaults.{key}"), "unknown key"));
                    }
                }
                if let Some(s) = str_at(o, "policy", "defaults", &mut errors) {
                    set.defaults.policy = s;
                }
                if let Some(s) = str_at(o, "start", "defaults", &mut errors) {
                    set.defaults.start = s;
                }
                if let Some(s) = str_at(o, "end", "defaults", &mut errors) {
                    set.defaults.end = s;
                }
                if let Some(s) = str_at(o, "on_error", "defaults", &mut errors) {
                    set.defaults.on_error = s;
                }
                if let Some(s) = str_at(o, "unknown_policy", "defaults", &mut errors) {
                    set.defaults.unknown_policy = s;
                }
                match o.get("max_retries") {
                    None | Some(Value::Null) => {}
                    Some(v) => match v.as_i64() {
                        Some(n) => set.defaults.max_retries = n,
                        None => errors.push(DslError::new(
                            "defaults.max_retries",
                            "must be a whole number",
                        )),
                    },
                }
            }
            None => errors.push(DslError::new("defaults", "must be an object")),
        }
    }
    match root.get("policies") {
        None | Some(Value::Null) => {}
        Some(Value::Array(a)) => {
            for (i, p) in a.iter().enumerate() {
                let path = format!("policies[{i}]");
                let Some(o) = p.as_object() else {
                    errors.push(DslError::new(path, "must be an object"));
                    continue;
                };
                let id = str_at(o, "id", &path, &mut errors);
                if id.is_none() {
                    errors.push(DslError::new(format!("{path}.id"), "is required"));
                }
                set.policies.push(PolicyEntry {
                    id: id.unwrap_or_default(),
                    name: str_at(o, "name", &path, &mut errors),
                    defaults: o.get("defaults").filter(|v| !v.is_null()).cloned(),
                });
            }
        }
        Some(_) => errors.push(DslError::new("policies", "must be a list")),
    }
    match root.get("rules") {
        None | Some(Value::Null) => {}
        Some(Value::Array(a)) => {
            for (i, r) in a.iter().enumerate() {
                if let Some(rule) = parse_rule(r, &format!("rules[{i}]"), &mut errors) {
                    set.rules.push(rule);
                }
            }
        }
        Some(_) => errors.push(DslError::new("rules", "must be a list")),
    }
    match root.get("exclusions") {
        None | Some(Value::Null) => {}
        Some(Value::Object(o)) => {
            for key in o.keys() {
                if key != "always_exclude" {
                    errors.push(DslError::new(format!("exclusions.{key}"), "unknown key"));
                }
            }
            match o.get("always_exclude") {
                None | Some(Value::Null) => {}
                Some(Value::Object(ae)) => {
                    for key in ae.keys() {
                        if !matches!(
                            key.as_str(),
                            "categories" | "groups" | "turn_ids" | "item_ids"
                        ) {
                            errors.push(DslError::new(
                                format!("exclusions.always_exclude.{key}"),
                                "unknown key",
                            ));
                        }
                    }
                    let p = "exclusions.always_exclude";
                    set.exclusions = Exclusions {
                        categories: str_list(
                            ae.get("categories"),
                            &format!("{p}.categories"),
                            &mut errors,
                        ),
                        groups: str_list(ae.get("groups"), &format!("{p}.groups"), &mut errors),
                        turn_ids: str_list(
                            ae.get("turn_ids"),
                            &format!("{p}.turn_ids"),
                            &mut errors,
                        ),
                        item_ids: str_list(
                            ae.get("item_ids"),
                            &format!("{p}.item_ids"),
                            &mut errors,
                        ),
                    };
                }
                Some(_) => errors.push(DslError::new(
                    "exclusions.always_exclude",
                    "must be an object",
                )),
            }
        }
        Some(_) => errors.push(DslError::new("exclusions", "must be an object")),
    }
    if errors.is_empty() {
        Ok(set)
    } else {
        Err(errors)
    }
}

fn parse_rule(r: &Value, path: &str, errors: &mut Vec<DslError>) -> Option<Rule> {
    let Some(o) = r.as_object() else {
        errors.push(DslError::new(path, "must be an object"));
        return None;
    };
    for key in o.keys() {
        if !matches!(
            key.as_str(),
            "id" | "enabled" | "priority" | "if" | "then" | "description"
        ) {
            errors.push(DslError::new(format!("{path}.{key}"), "unknown key"));
        }
    }
    let before = errors.len();
    let id = str_at(o, "id", path, errors);
    if id.is_none() {
        errors.push(DslError::new(format!("{path}.id"), "is required"));
    }
    let enabled = match o.get("enabled") {
        None | Some(Value::Null) => true,
        Some(Value::Bool(b)) => *b,
        Some(_) => {
            errors.push(DslError::new(
                format!("{path}.enabled"),
                "must be true or false",
            ));
            true
        }
    };
    let priority = match o.get("priority") {
        None | Some(Value::Null) => 0,
        Some(v) => match v.as_i64() {
            Some(n) => n,
            None => {
                errors.push(DslError::new(
                    format!("{path}.priority"),
                    "must be a whole number",
                ));
                0
            }
        },
    };
    let cond = match o.get("if") {
        None | Some(Value::Null) => {
            errors.push(DslError::new(format!("{path}.if"), "is required"));
            None
        }
        Some(c) => {
            let mut count = 0usize;
            match parse_cond(c, 1, &mut count, &format!("{path}.if")) {
                Ok(c) => Some(c),
                Err(e) => {
                    errors.push(e);
                    None
                }
            }
        }
    };
    let (policy, params) = match o.get("then") {
        Some(Value::Object(t)) => {
            for key in t.keys() {
                if !matches!(key.as_str(), "policy" | "params") {
                    errors.push(DslError::new(format!("{path}.then.{key}"), "unknown key"));
                }
            }
            let p = str_at(t, "policy", &format!("{path}.then"), errors);
            if p.is_none() {
                errors.push(DslError::new(format!("{path}.then.policy"), "is required"));
            }
            (
                p.unwrap_or_default(),
                t.get("params").filter(|v| !v.is_null()).cloned(),
            )
        }
        _ => {
            errors.push(DslError::new(
                format!("{path}.then"),
                "must be an object with a policy",
            ));
            (String::new(), None)
        }
    };
    let description = str_at(o, "description", path, errors);
    if errors.len() > before {
        return None;
    }
    Some(Rule {
        id: id?,
        enabled,
        priority,
        cond: cond?,
        policy,
        params,
        description,
    })
}

/// Read one condition (object or string).
pub fn parse_cond(
    v: &Value,
    depth: usize,
    count: &mut usize,
    path: &str,
) -> Result<Cond, DslError> {
    if depth > MAX_DEPTH {
        return Err(DslError::new(
            path,
            format!("nested deeper than {MAX_DEPTH}"),
        ));
    }
    match v {
        Value::String(s) => {
            if s.chars().count() > MAX_STRING {
                return Err(DslError::new(
                    path,
                    format!("condition longer than {MAX_STRING} characters"),
                ));
            }
            let toks = tokenize(s).map_err(|m| DslError::new(path, m))?;
            let mut p = Parser {
                toks,
                pos: 0,
                depth,
                count,
                path,
            };
            let c = p.expr()?;
            if p.pos != p.toks.len() {
                return Err(DslError::new(
                    path,
                    format!("unexpected {:?}", p.toks[p.pos].text()),
                ));
            }
            Ok(c)
        }
        Value::Object(o) => {
            if o.len() != 1 {
                return Err(DslError::new(
                    path,
                    "a condition object has exactly one key: all, any or not",
                ));
            }
            let (k, inner) = o.iter().next().expect("one key");
            match k.as_str() {
                "all" | "any" => {
                    let arr = inner
                        .as_array()
                        .ok_or_else(|| DslError::new(format!("{path}.{k}"), "must be a list"))?;
                    let mut out = Vec::new();
                    for (i, c) in arr.iter().enumerate() {
                        out.push(parse_cond(
                            c,
                            depth + 1,
                            count,
                            &format!("{path}.{k}[{i}]"),
                        )?);
                    }
                    Ok(if k == "all" {
                        Cond::All(out)
                    } else {
                        Cond::Any(out)
                    })
                }
                "not" => Ok(Cond::Not(Box::new(parse_cond(
                    inner,
                    depth + 1,
                    count,
                    &format!("{path}.not"),
                )?))),
                other => Err(DslError::new(
                    path,
                    format!("unknown condition key {other:?} (use all, any or not)"),
                )),
            }
        }
        Value::Bool(b) => {
            // A bare true/false: an empty all (true) or an empty any (false).
            Ok(if *b {
                Cond::All(Vec::new())
            } else {
                Cond::Any(Vec::new())
            })
        }
        _ => Err(DslError::new(path, "a condition is a string or an object")),
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Ident(String),
    Str(String),
    Num(i64),
    Sym(&'static str),
}

impl Tok {
    fn text(&self) -> String {
        match self {
            Tok::Ident(s) => s.clone(),
            Tok::Str(s) => format!("\"{s}\""),
            Tok::Num(n) => n.to_string(),
            Tok::Sym(s) => s.to_string(),
        }
    }
}

fn tokenize(s: &str) -> Result<Vec<Tok>, String> {
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    let mut out = Vec::new();
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        let two: String = chars[i..chars.len().min(i + 2)].iter().collect();
        let sym2 = ["==", "!=", "<=", ">=", "&&", "||"]
            .into_iter()
            .find(|t| *t == two);
        if let Some(t) = sym2 {
            out.push(Tok::Sym(t));
            i += 2;
            continue;
        }
        let sym1 = match c {
            '(' => Some("("),
            ')' => Some(")"),
            '[' => Some("["),
            ']' => Some("]"),
            ',' => Some(","),
            '<' => Some("<"),
            '>' => Some(">"),
            '!' => Some("!"),
            _ => None,
        };
        if let Some(t) = sym1 {
            out.push(Tok::Sym(t));
            i += 1;
            continue;
        }
        if c == '"' || c == '\'' {
            let quote = c;
            let mut j = i + 1;
            let mut buf = String::new();
            while j < chars.len() && chars[j] != quote {
                if chars[j] == '\\' && j + 1 < chars.len() {
                    j += 1;
                }
                buf.push(chars[j]);
                j += 1;
            }
            if j >= chars.len() {
                return Err("a string is not closed".into());
            }
            if buf.chars().count() > MAX_STRING {
                return Err(format!("a string longer than {MAX_STRING} characters"));
            }
            out.push(Tok::Str(buf));
            i = j + 1;
            continue;
        }
        if c.is_ascii_digit() || (c == '-' && i + 1 < chars.len() && chars[i + 1].is_ascii_digit())
        {
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_ascii_digit() {
                j += 1;
            }
            let text: String = chars[i..j].iter().collect();
            let n = text
                .parse::<i64>()
                .map_err(|_| format!("number {text} is out of range"))?;
            out.push(Tok::Num(n));
            i = j;
            continue;
        }
        if c.is_ascii_alphabetic() || c == '_' {
            let mut j = i + 1;
            while j < chars.len()
                && (chars[j].is_ascii_alphanumeric() || chars[j] == '_' || chars[j] == '.')
            {
                j += 1;
            }
            out.push(Tok::Ident(chars[i..j].iter().collect()));
            i = j;
            continue;
        }
        return Err(format!("unexpected character {c:?}"));
    }
    Ok(out)
}

struct Parser<'a> {
    toks: Vec<Tok>,
    pos: usize,
    depth: usize,
    count: &'a mut usize,
    path: &'a str,
}

impl Parser<'_> {
    fn err(&self, m: impl Into<String>) -> DslError {
        DslError::new(self.path, m)
    }
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.pos)
    }
    fn is_word(&self, w: &str) -> bool {
        matches!(self.peek(), Some(Tok::Ident(s)) if s == w)
    }
    fn is_sym(&self, w: &str) -> bool {
        matches!(self.peek(), Some(Tok::Sym(s)) if *s == w)
    }
    fn enter(&mut self) -> Result<(), DslError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(self.err(format!("nested deeper than {MAX_DEPTH}")));
        }
        Ok(())
    }
    fn expr(&mut self) -> Result<Cond, DslError> {
        let mut parts = vec![self.and()?];
        while self.is_sym("||") || self.is_word("or") {
            self.pos += 1;
            parts.push(self.and()?);
        }
        Ok(if parts.len() == 1 {
            parts.pop().expect("one")
        } else {
            Cond::Any(parts)
        })
    }
    fn and(&mut self) -> Result<Cond, DslError> {
        let mut parts = vec![self.unary()?];
        while self.is_sym("&&") || self.is_word("and") {
            self.pos += 1;
            parts.push(self.unary()?);
        }
        Ok(if parts.len() == 1 {
            parts.pop().expect("one")
        } else {
            Cond::All(parts)
        })
    }
    fn unary(&mut self) -> Result<Cond, DslError> {
        if self.is_sym("!") || self.is_word("not") {
            self.pos += 1;
            self.enter()?;
            let c = self.unary()?;
            self.depth -= 1;
            return Ok(Cond::Not(Box::new(c)));
        }
        if self.is_sym("(") {
            self.pos += 1;
            self.enter()?;
            let c = self.expr()?;
            self.depth -= 1;
            if !self.is_sym(")") {
                return Err(self.err("a parenthesis is not closed"));
            }
            self.pos += 1;
            return Ok(c);
        }
        self.leaf()
    }
    fn leaf(&mut self) -> Result<Cond, DslError> {
        *self.count += 1;
        if *self.count > MAX_CONDITIONS {
            return Err(self.err(format!("more than {MAX_CONDITIONS} conditions in one rule")));
        }
        if self.is_word("exists") {
            self.pos += 1;
            let field = self.field()?;
            return Ok(Cond::Exists(field));
        }
        let field = self.field()?;
        if self.is_word("exists") {
            self.pos += 1;
            return Ok(Cond::Exists(field));
        }
        let op = match self.peek() {
            Some(Tok::Sym("==")) => Op::Eq,
            Some(Tok::Sym("!=")) => Op::Ne,
            Some(Tok::Sym("<")) => Op::Lt,
            Some(Tok::Sym("<=")) => Op::Le,
            Some(Tok::Sym(">")) => Op::Gt,
            Some(Tok::Sym(">=")) => Op::Ge,
            Some(Tok::Ident(w)) if w == "in" => Op::In,
            Some(Tok::Ident(w)) if w == "contains" => Op::Contains,
            Some(t) => return Err(self.err(format!("unknown operator {:?}", t.text()))),
            None => return Err(self.err(format!("{field} needs an operator and a value"))),
        };
        self.pos += 1;
        let value = self.literal()?;
        Ok(Cond::Cmp { field, op, value })
    }
    fn field(&mut self) -> Result<String, DslError> {
        match self.peek().cloned() {
            Some(Tok::Ident(s)) if s.contains('.') => {
                self.pos += 1;
                Ok(s)
            }
            Some(t) => Err(self.err(format!(
                "expected a field such as request.category, found {:?}",
                t.text()
            ))),
            None => Err(self.err("expected a field")),
        }
    }
    fn literal(&mut self) -> Result<Lit, DslError> {
        let t = self.peek().cloned();
        match t {
            Some(Tok::Str(s)) => {
                self.pos += 1;
                Ok(Lit::Str(s))
            }
            Some(Tok::Num(n)) => {
                self.pos += 1;
                Ok(Lit::Num(n))
            }
            Some(Tok::Ident(w)) if w == "true" || w == "false" => {
                self.pos += 1;
                Ok(Lit::Bool(w == "true"))
            }
            Some(Tok::Sym("[")) => {
                self.pos += 1;
                let mut items = Vec::new();
                if self.is_sym("]") {
                    self.pos += 1;
                    return Ok(Lit::List(items));
                }
                loop {
                    let item = self.literal()?;
                    if matches!(item, Lit::List(_)) {
                        return Err(self.err("a list cannot hold a list"));
                    }
                    items.push(item);
                    if self.is_sym(",") {
                        self.pos += 1;
                        continue;
                    }
                    if self.is_sym("]") {
                        self.pos += 1;
                        break;
                    }
                    return Err(self.err("a list is not closed"));
                }
                if items.len() > MAX_CONDITIONS {
                    return Err(self.err(format!("a list longer than {MAX_CONDITIONS}")));
                }
                Ok(Lit::List(items))
            }
            Some(t) => Err(self.err(format!(
                "expected a value (string, number, true/false or [list]), found {:?}",
                t.text()
            ))),
            None => Err(self.err("expected a value")),
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    /// The example of the TCPE design, as JSON.
    pub(crate) fn design_example() -> Value {
        json!({
            "version": 1,
            "defaults": {"policy": "T7", "start": "first_tool_call", "end": "task_completed", "on_error": "retry_then_fallback", "max_retries": 2, "unknown_policy": "T7"},
            "policies": [
                {"id": "T1", "name": "goal_only"},
                {"id": "T2", "name": "range_summary", "defaults": {"ranges": "relevant"}},
                {"id": "T3", "name": "memory_only", "defaults": {"memory_scope": "relevant"}},
                {"id": "T4", "name": "no_search_data", "defaults": {"exclude": ["raw_search_results"]}},
                {"id": "T5", "name": "recent_turns", "defaults": {"recent_turns": 2}},
                {"id": "T6", "name": "checklist_selection", "defaults": {"selection": "relevant"}},
                {"id": "T7", "name": "full_context"}
            ],
            "rules": [
                {"id": "R_DEVICE_SIMPLE", "enabled": true, "priority": 100,
                 "if": {"all": ["request.category == \"device_action\"", "request.has_reference == false", "request.requires_history == false"]},
                 "then": {"policy": "T1"}},
                {"id": "R_HISTORY_REFERENCE", "enabled": true, "priority": 90,
                 "if": {"any": ["request.references_previous_turn == true", "request.requires_history == true"]},
                 "then": {"policy": "T5", "params": {"recent_turns": 3}}},
                {"id": "R_SEARCH_HEAVY", "enabled": true, "priority": 80,
                 "if": {"all": ["task.has_search_results == true", "task.needs_raw_search_results == false"]},
                 "then": {"policy": "T4"}}
            ],
            "exclusions": {"always_exclude": {"categories": [], "groups": [], "turn_ids": []}}
        })
    }

    #[test]
    fn the_design_example_reads_with_three_rules_and_seven_policies() {
        let set = parse(&design_example()).expect("reads");
        assert_eq!(set.version, 1);
        assert_eq!(set.rules.len(), 3);
        assert_eq!(set.policies.len(), 7);
        assert_eq!(set.rules[1].params, Some(json!({"recent_turns": 3})));
        assert_eq!(
            set.rules[0].cond,
            Cond::All(vec![
                Cond::Cmp {
                    field: "request.category".into(),
                    op: Op::Eq,
                    value: Lit::Str("device_action".into())
                },
                Cond::Cmp {
                    field: "request.has_reference".into(),
                    op: Op::Eq,
                    value: Lit::Bool(false)
                },
                Cond::Cmp {
                    field: "request.requires_history".into(),
                    op: Op::Eq,
                    value: Lit::Bool(false)
                },
            ])
        );
    }

    #[test]
    fn strings_parse_with_precedence_not_and_parentheses() {
        let mut n = 0;
        let c = parse_cond(&json!("not request.lang == 'bn' && (task.tool_calls >= 2 || request.tool_name in [\"a\", \"b\"])"), 1, &mut n, "if").unwrap();
        match c {
            Cond::All(parts) => {
                assert!(matches!(parts[0], Cond::Not(_)));
                assert!(matches!(&parts[1], Cond::Any(v) if v.len() == 2));
            }
            other => panic!("{other:?}"),
        }
        let mut n = 0;
        assert_eq!(
            parse_cond(&json!("exists request.lang"), 1, &mut n, "if").unwrap(),
            Cond::Exists("request.lang".into())
        );
        let mut n = 0;
        assert_eq!(
            parse_cond(&json!("request.lang exists"), 1, &mut n, "if").unwrap(),
            Cond::Exists("request.lang".into())
        );
    }

    #[test]
    fn limits_and_bad_syntax_are_errors_with_a_path() {
        let mut n = 0;
        let deep = json!({"not": {"not": {"not": {"not": {"not": {"not": {"not": {"not": "a.b == 1"}}}}}}}});
        assert!(parse_cond(&deep, 1, &mut n, "if")
            .unwrap_err()
            .message
            .contains("deeper"));
        let mut n = 0;
        let many: Vec<Value> = (0..33)
            .map(|i| json!(format!("task.tool_calls == {i}")))
            .collect();
        assert!(parse_cond(&json!({"any": many}), 1, &mut n, "if")
            .unwrap_err()
            .message
            .contains("32"));
        let mut n = 0;
        let long = format!("request.lang == \"{}\"", "x".repeat(250));
        assert!(parse_cond(&json!(long), 1, &mut n, "if").is_err());
        for bad in [
            "request.lang ==",
            "request.lang ~= 'x'",
            "system('rm -rf')",
            "request.lang == 'x",
            "(a.b == 1",
            "a.b == x",
        ] {
            let mut n = 0;
            assert!(
                parse_cond(&json!(bad), 1, &mut n, "rules[0].if").is_err(),
                "{bad}"
            );
        }
        let errs = parse(&json!({"version": 1, "rules": [{"id": "R_A", "if": "a.b ==", "then": {}}], "extra": 1})).unwrap_err();
        let paths: Vec<&str> = errs.iter().map(|e| e.path.as_str()).collect();
        assert!(paths.contains(&"extra"));
        assert!(paths.contains(&"rules[0].if"));
        assert!(paths.contains(&"rules[0].then.policy"));
    }
}
