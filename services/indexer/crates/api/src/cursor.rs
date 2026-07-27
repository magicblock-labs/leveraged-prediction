use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::ApiError;

const CHECKSUM_BYTES: usize = 8;
const MAX_CURSOR_BYTES: usize = 512;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct LeaderboardCursor {
    pub fingerprint: String,
    pub refresh_version: i64,
    pub rank: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HistoryCursor {
    pub fingerprint: String,
    pub timestamp_micros: i64,
    pub market_id: i32,
    pub identity: String,
}

pub fn encode<T: Serialize>(payload: &T) -> Result<String, ApiError> {
    let mut bytes = serde_json::to_vec(payload)
        .map_err(|_| ApiError::invalid("cursor payload could not be encoded"))?;
    let checksum = Sha256::digest(&bytes);
    bytes.extend_from_slice(&checksum[..CHECKSUM_BYTES]);
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub fn decode<T: DeserializeOwned>(value: &str) -> Result<T, ApiError> {
    if value.len() > MAX_CURSOR_BYTES {
        return Err(ApiError::invalid("cursor is too large"));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| ApiError::invalid("cursor is not valid base64url"))?;
    if bytes.len() <= CHECKSUM_BYTES {
        return Err(ApiError::invalid("cursor is truncated"));
    }
    let (payload, provided) = bytes.split_at(bytes.len() - CHECKSUM_BYTES);
    let expected = Sha256::digest(payload);
    if provided != &expected[..CHECKSUM_BYTES] {
        return Err(ApiError::invalid("cursor checksum is invalid"));
    }
    serde_json::from_slice(payload).map_err(|_| ApiError::invalid("cursor payload is invalid"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_cursor_round_trip_and_tamper_rejection() {
        let payload = LeaderboardCursor {
            fingerprint: "all:global".to_owned(),
            refresh_version: 9,
            rank: 42,
        };
        let encoded = encode(&payload).unwrap();
        assert_eq!(decode::<LeaderboardCursor>(&encoded).unwrap(), payload);

        let mut tampered = encoded.into_bytes();
        let last = tampered.len() - 1;
        tampered[last] = if tampered[last] == b'A' { b'B' } else { b'A' };
        let tampered = String::from_utf8(tampered).unwrap();
        assert!(decode::<LeaderboardCursor>(&tampered).is_err());
    }
}
