//! Just enough JSON for the page's messages (no serde: the crate takes no dependency for it).

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn get(&self, k: &str) -> Option<&Json> {
        match self { Json::Obj(o) => o.iter().find(|(n, _)| n == k).map(|(_, v)| v), _ => None }
    }
    pub fn num(&self, k: &str) -> Option<f64> {
        match self.get(k) { Some(Json::Num(n)) => Some(*n), _ => None }
    }
    pub fn str(&self, k: &str) -> Option<&str> {
        match self.get(k) { Some(Json::Str(s)) => Some(s), _ => None }
    }
    /// JS truthiness of a field that holds true/false/a number.
    pub fn truthy(&self, k: &str) -> bool {
        match self.get(k) { Some(Json::Bool(b)) => *b, Some(Json::Num(n)) => *n != 0.0, Some(Json::Str(s)) => !s.is_empty(), _ => false }
    }
}

pub fn parse(s: &str) -> Option<Json> {
    let mut p = P { b: s.as_bytes(), i: 0 };
    let v = p.value(0)?;
    p.ws();
    (p.i == p.b.len()).then_some(v)
}

struct P<'a> { b: &'a [u8], i: usize }

impl P<'_> {
    fn ws(&mut self) { while self.i < self.b.len() && self.b[self.i].is_ascii_whitespace() { self.i += 1; } }
    fn eat(&mut self, c: u8) -> bool { self.ws(); if self.b.get(self.i) == Some(&c) { self.i += 1; true } else { false } }
    fn lit(&mut self, w: &str, v: Json) -> Option<Json> {
        if self.b[self.i..].starts_with(w.as_bytes()) { self.i += w.len(); Some(v) } else { None }
    }
    fn value(&mut self, depth: u32) -> Option<Json> {
        if depth > 16 { return None; }
        self.ws();
        match *self.b.get(self.i)? {
            b'{' => {
                self.i += 1;
                let mut o = Vec::new();
                if self.eat(b'}') { return Some(Json::Obj(o)); }
                loop {
                    self.ws();
                    let k = self.string()?;
                    if !self.eat(b':') { return None; }
                    o.push((k, self.value(depth + 1)?));
                    if self.eat(b',') { continue; }
                    return self.eat(b'}').then_some(Json::Obj(o));
                }
            }
            b'[' => {
                self.i += 1;
                let mut a = Vec::new();
                if self.eat(b']') { return Some(Json::Arr(a)); }
                loop {
                    a.push(self.value(depth + 1)?);
                    if self.eat(b',') { continue; }
                    return self.eat(b']').then_some(Json::Arr(a));
                }
            }
            b'"' => self.string().map(Json::Str),
            b't' => self.lit("true", Json::Bool(true)),
            b'f' => self.lit("false", Json::Bool(false)),
            b'n' => self.lit("null", Json::Null),
            _ => {
                let s = self.i;
                while self.i < self.b.len() && matches!(self.b[self.i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') { self.i += 1; }
                std::str::from_utf8(&self.b[s..self.i]).ok()?.parse().ok().map(Json::Num)
            }
        }
    }
    fn string(&mut self) -> Option<String> {
        if self.b.get(self.i) != Some(&b'"') { return None; }
        self.i += 1;
        let mut out = Vec::new();
        loop {
            let c = *self.b.get(self.i)?;
            self.i += 1;
            match c {
                b'"' => return String::from_utf8(out).ok(),
                b'\\' => {
                    let e = *self.b.get(self.i)?;
                    self.i += 1;
                    let ch = match e {
                        b'n' => '\n', b't' => '\t', b'r' => '\r', b'b' => '\u{8}', b'f' => '\u{c}',
                        b'u' => {
                            let h = std::str::from_utf8(self.b.get(self.i..self.i + 4)?).ok()?;
                            self.i += 4;
                            char::from_u32(u32::from_str_radix(h, 16).ok()?).unwrap_or('\u{fffd}') // lone surrogates: replaced
                        }
                        o => o as char,
                    };
                    let mut t = [0u8; 4];
                    out.extend_from_slice(ch.encode_utf8(&mut t).as_bytes());
                }
                c => out.push(c),
            }
        }
    }
}

/// A JSON string literal.
pub fn quote(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""), '\\' => o.push_str("\\\\"), '\n' => o.push_str("\\n"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// A number the way JS prints it for whole values and plain decimals.
pub fn num(n: f64) -> String {
    if !n.is_finite() { "0".into() } else if n == n.trunc() && n.abs() < 1e15 { format!("{}", n as i64) } else { format!("{}", n) }
}
