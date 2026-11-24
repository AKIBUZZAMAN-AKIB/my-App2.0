//! Sortable unique ids (`<prefix>_<ulid>`): 10 characters of millisecond time
//! and 16 random characters, Crockford base32. Sorting ids sorts by creation
//! time, and two ids made in the same millisecond still differ.

const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// A new ULID string (26 characters).
pub fn ulid() -> String {
    let ms = super::now_ms().max(0) as u64;
    let mut out = String::with_capacity(26);
    for i in (0..10).rev() {
        out.push(ALPHABET[((ms >> (i * 5)) & 31) as usize] as char);
    }
    let rnd = uuid::Uuid::new_v4().as_u128();
    for i in 0..16 {
        out.push(ALPHABET[((rnd >> (i * 5)) & 31) as usize] as char);
    }
    out
}

/// `<prefix>_<ulid>`, e.g. `it_01J…`.
pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", ulid())
}

/// Crockford base32 of arbitrary bytes (used for deterministic ids).
pub fn base32(bytes: &[u8]) -> String {
    let mut out = String::new();
    let mut buf: u32 = 0;
    let mut bits = 0;
    for &b in bytes {
        buf = (buf << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((buf >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((buf << (5 - bits)) & 31) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_and_prefixed() {
        let a = new_id("it");
        let b = new_id("it");
        assert!(a.starts_with("it_") && a.len() == 29);
        assert_ne!(a, b);
    }

    #[test]
    fn base32_is_stable() {
        assert_eq!(base32(b"\x00"), "00");
        assert_eq!(base32(b"hi"), base32(b"hi"));
    }
}
