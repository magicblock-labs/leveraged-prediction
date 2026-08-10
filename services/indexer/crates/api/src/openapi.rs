use std::{fs, path::PathBuf};

use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};

pub fn document() -> Value {
    json!({
        "openapi": "3.1.0",
        "info": {
            "title": "Leveraged Prediction Read API",
            "version": "1.0.0",
            "description": "Read-only indexed history and leaderboard API. Live gameplay remains on direct ER RPC/websocket paths."
        },
        "paths": {
            "/v1/leaderboards": {
                "get": {
                    "parameters": [
                        {"name": "period", "in": "query", "schema": {"type": "string", "enum": ["today", "week", "month", "all"], "default": "all"}},
                        {"name": "market_id", "in": "query", "schema": {"type": "integer", "minimum": 0, "maximum": 65535}},
                        {"name": "limit", "in": "query", "schema": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20}},
                        {"name": "cursor", "in": "query", "schema": {"type": "string", "maxLength": 512}}
                    ],
                    "responses": response_set("Leaderboard page", "LeaderboardPage", false)
                }
            },
            "/v1/users/{wallet}/stats": {
                "get": {
                    "parameters": [
                        wallet_parameter(),
                        {"name": "period", "in": "query", "schema": {"type": "string", "enum": ["today", "week", "month", "all"], "default": "all"}},
                        {"name": "market_id", "in": "query", "schema": {"type": "integer", "minimum": 0, "maximum": 65535}}
                    ],
                    "responses": response_set("User aggregate", "UserStatsResponse", false)
                }
            },
            "/v1/users/{wallet}/positions": {
                "get": {
                    "parameters": [
                        wallet_parameter(),
                        {"name": "market_id", "in": "query", "schema": {"type": "integer", "minimum": 0, "maximum": 65535}},
                        {"name": "status", "in": "query", "schema": {"type": "string", "enum": ["open", "closed", "refunded"]}},
                        {"name": "limit", "in": "query", "schema": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20}},
                        {"name": "cursor", "in": "query", "schema": {"type": "string", "maxLength": 512}}
                    ],
                    "responses": response_set("Position history page", "PositionPage", false)
                }
            },
            "/v1/users/{wallet}/liquidity": {
                "get": {
                    "parameters": [
                        wallet_parameter(),
                        {"name": "market_id", "in": "query", "schema": {"type": "integer", "minimum": 0, "maximum": 65535}},
                        {"name": "limit", "in": "query", "schema": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20}},
                        {"name": "cursor", "in": "query", "schema": {"type": "string", "maxLength": 512}}
                    ],
                    "responses": response_set("Liquidity history page", "LiquidityPage", false)
                }
            },
            "/v1/positions/{market_id}/{position_id}": {
                "get": {
                    "parameters": [market_parameter(), position_parameter()],
                    "responses": response_set("Canonical position", "PositionResponse", true)
                }
            },
            "/v1/markets/{market_id}/summary": {
                "get": {
                    "parameters": [market_parameter()],
                    "responses": response_set("Current indexed Market summary", "MarketSummaryResponse", true)
                }
            },
            "/health/live": {"get": {"responses": {"200": json_response("Process is live", "Health")}}},
            "/health/ready": {"get": {"responses": {
                "200": json_response("Database is reachable", "Health"),
                "503": json_response("Database is unavailable", "Health")
            }}},
            "/metrics": {"get": {"responses": {"200": {"description": "Prometheus text metrics"}}}}
        },
        "components": {
            "schemas": schemas()
        }
    })
}

pub fn snapshot_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../openapi/leveraged-prediction-v1.json")
}

pub fn check_snapshot() -> Result<()> {
    let path = snapshot_path();
    let checked = fs::read_to_string(&path)
        .with_context(|| format!("failed to read OpenAPI snapshot {}", path.display()))?;
    let checked: Value =
        serde_json::from_str(&checked).context("checked OpenAPI is invalid JSON")?;
    ensure!(
        checked == document(),
        "OpenAPI snapshot drifted; regenerate {}",
        path.display()
    );
    Ok(())
}

pub fn pretty_document() -> Result<String> {
    Ok(format!("{}\n", serde_json::to_string_pretty(&document())?))
}

pub fn write_snapshot() -> Result<PathBuf> {
    let path = snapshot_path();
    fs::write(&path, pretty_document()?)
        .with_context(|| format!("failed to write OpenAPI snapshot {}", path.display()))?;
    Ok(path)
}

fn response_set(description: &str, schema: &str, not_found: bool) -> Value {
    let mut responses = json!({
        "200": json_response(description, schema),
        "400": {"description": "Invalid request", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Error"}}}},
        "409": {"description": "Cursor refresh version is stale", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Error"}}}},
        "503": {"description": "Index unavailable", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Error"}}}}
    });
    if not_found {
        responses.as_object_mut().unwrap().insert(
            "404".to_owned(),
            json!({"description": "Resource not found", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Error"}}}}),
        );
    }
    responses
}

fn json_response(description: &str, schema: &str) -> Value {
    json!({
        "description": description,
        "content": {
            "application/json": {
                "schema": {"$ref": format!("#/components/schemas/{schema}")}
            }
        }
    })
}

fn schemas() -> Value {
    json!({
        "ResponseMeta": {
            "type": "object",
            "required": ["as_of", "projection_high_water_mark", "refresh_version", "stale"],
            "properties": {
                "as_of": {"type": "string", "format": "date-time"},
                "projection_high_water_mark": {"type": ["integer", "null"], "format": "int64"},
                "refresh_version": {"type": "integer", "format": "int64"},
                "stale": {"type": "boolean"},
                "next_cursor": {"type": "string"}
            }
        },
        "MinorUnits": {
            "type": "string",
            "pattern": "^-?[0-9]+$",
            "description": "Exact collateral minor units; never a JSON number."
        },
        "NullableMinorUnits": {
            "oneOf": [
                {"$ref": "#/components/schemas/MinorUnits"},
                {"type": "null"}
            ]
        },
        "LeaderboardEntry": {
            "type": "object",
            "required": ["rank", "user", "trades", "wins", "losses", "breakevens", "refunds", "volume", "payout", "net_pnl", "lp_fees", "platform_fees", "total_fees", "win_rate_bps"],
            "properties": {
                "rank": {"type": "integer", "format": "int64"},
                "user": {"type": "string"},
                "trades": {"type": "integer", "format": "int64"},
                "wins": {"type": "integer", "format": "int64"},
                "losses": {"type": "integer", "format": "int64"},
                "breakevens": {"type": "integer", "format": "int64"},
                "refunds": {"type": "integer", "format": "int64"},
                "volume": {"$ref": "#/components/schemas/MinorUnits"},
                "payout": {"$ref": "#/components/schemas/MinorUnits"},
                "net_pnl": {"$ref": "#/components/schemas/MinorUnits"},
                "lp_fees": {"$ref": "#/components/schemas/MinorUnits"},
                "platform_fees": {"$ref": "#/components/schemas/MinorUnits"},
                "total_fees": {"$ref": "#/components/schemas/MinorUnits"},
                "win_rate_bps": {"type": "integer", "format": "int32"}
            }
        },
        "Position": {
            "type": "object",
            "required": ["market_id", "position_id", "user", "direction", "entry_price", "collateral", "expires_at", "lifecycle_status", "checkpoint_status", "outcome", "payout_amount", "lp_fee_amount", "platform_fee_amount", "total_fee_amount", "net_pnl", "opened_at", "closed_at"],
            "properties": {
                "market_id": {"type": "integer", "minimum": 0, "maximum": 65535},
                "position_id": {"type": "integer", "minimum": 0, "maximum": 4294967295_u64},
                "user": {"type": ["string", "null"]},
                "direction": {"type": ["string", "null"], "enum": ["up", "down", null]},
                "entry_price": {"type": ["string", "null"], "pattern": "^-?[0-9]+$"},
                "collateral": {"$ref": "#/components/schemas/NullableMinorUnits"},
                "expires_at": {"type": ["string", "null"], "format": "date-time"},
                "lifecycle_status": {"type": "string", "enum": ["open", "settled", "refunded"]},
                "checkpoint_status": {"type": "string", "enum": ["er_only", "base_observed", "not_applicable"]},
                "outcome": {"type": ["string", "null"], "enum": ["won", "lost", "breakeven", "refunded", null]},
                "payout_amount": {"$ref": "#/components/schemas/NullableMinorUnits"},
                "lp_fee_amount": {"$ref": "#/components/schemas/NullableMinorUnits"},
                "platform_fee_amount": {"$ref": "#/components/schemas/NullableMinorUnits"},
                "total_fee_amount": {"$ref": "#/components/schemas/NullableMinorUnits"},
                "net_pnl": {"$ref": "#/components/schemas/NullableMinorUnits"},
                "opened_at": {"type": ["string", "null"], "format": "date-time"},
                "closed_at": {"type": ["string", "null"], "format": "date-time"}
            }
        },
        "LiquidityEvent": {
            "type": "object",
            "required": ["signature", "instruction_path", "event_kind", "market_id", "user", "assets", "shares", "min_assets_out", "occurred_at"],
            "properties": {
                "signature": {"type": "string"},
                "instruction_path": {"type": "string"},
                "event_kind": {"type": "string"},
                "market_id": {"type": "integer", "minimum": 0, "maximum": 65535},
                "user": {"type": "string"},
                "assets": {"$ref": "#/components/schemas/NullableMinorUnits"},
                "shares": {"$ref": "#/components/schemas/MinorUnits"},
                "min_assets_out": {"$ref": "#/components/schemas/NullableMinorUnits"},
                "occurred_at": {"type": ["string", "null"], "format": "date-time"}
            }
        },
        "UserStats": {
            "type": "object",
            "required": ["user", "period", "market_id", "trades", "wins", "losses", "breakevens", "refunds", "volume", "payout", "net_pnl", "lp_fees", "platform_fees", "total_fees", "win_rate_bps", "rank"],
            "properties": {
                "user": {"type": "string"},
                "period": {"type": "string", "enum": ["today", "week", "month", "all"]},
                "market_id": {"type": ["integer", "null"], "minimum": 0, "maximum": 65535},
                "trades": {"type": "integer", "format": "int64"},
                "wins": {"type": "integer", "format": "int64"},
                "losses": {"type": "integer", "format": "int64"},
                "breakevens": {"type": "integer", "format": "int64"},
                "refunds": {"type": "integer", "format": "int64"},
                "volume": {"$ref": "#/components/schemas/MinorUnits"},
                "payout": {"$ref": "#/components/schemas/MinorUnits"},
                "net_pnl": {"$ref": "#/components/schemas/MinorUnits"},
                "lp_fees": {"$ref": "#/components/schemas/MinorUnits"},
                "platform_fees": {"$ref": "#/components/schemas/MinorUnits"},
                "total_fees": {"$ref": "#/components/schemas/MinorUnits"},
                "win_rate_bps": {"type": "integer", "format": "int32"},
                "rank": {"type": ["integer", "null"], "format": "int64"}
            }
        },
        "MarketSummary": {
            "type": "object",
            "required": ["market_id", "market_pubkey", "mode", "total_shares", "open_collateral", "active_positions", "pool_balance", "last_slot", "updated_at"],
            "properties": {
                "market_id": {"type": "integer", "minimum": 0, "maximum": 65535},
                "market_pubkey": {"type": ["string", "null"]},
                "mode": {"type": ["string", "null"]},
                "total_shares": {"$ref": "#/components/schemas/NullableMinorUnits"},
                "open_collateral": {"$ref": "#/components/schemas/NullableMinorUnits"},
                "active_positions": {"type": ["integer", "null"], "format": "int32"},
                "pool_balance": {"$ref": "#/components/schemas/NullableMinorUnits"},
                "last_slot": {"type": ["integer", "null"], "format": "int64"},
                "updated_at": {"type": "string", "format": "date-time"}
            }
        },
        "LeaderboardPage": envelope_schema(json!({"type": "array", "items": {"$ref": "#/components/schemas/LeaderboardEntry"}})),
        "UserStatsResponse": envelope_schema(json!({"$ref": "#/components/schemas/UserStats"})),
        "PositionPage": envelope_schema(json!({"type": "array", "items": {"$ref": "#/components/schemas/Position"}})),
        "PositionResponse": envelope_schema(json!({"$ref": "#/components/schemas/Position"})),
        "LiquidityPage": envelope_schema(json!({"type": "array", "items": {"$ref": "#/components/schemas/LiquidityEvent"}})),
        "MarketSummaryResponse": envelope_schema(json!({"$ref": "#/components/schemas/MarketSummary"})),
        "Health": {
            "type": "object",
            "required": ["status"],
            "properties": {
                "status": {"type": "string", "enum": ["live", "ready", "not_ready"]},
                "database": {"type": "string", "enum": ["reachable", "unavailable"]},
                "position_stream": {"type": "string", "enum": ["ready", "unavailable"]}
            }
        },
        "Error": {
            "type": "object",
            "required": ["error"],
            "properties": {
                "error": {
                    "type": "object",
                    "required": ["code", "message"],
                    "properties": {
                        "code": {"type": "string"},
                        "message": {"type": "string"}
                    }
                }
            }
        }
    })
}

fn envelope_schema(data: Value) -> Value {
    json!({
        "type": "object",
        "required": ["data", "meta"],
        "properties": {
            "data": data,
            "meta": {"$ref": "#/components/schemas/ResponseMeta"}
        }
    })
}

fn wallet_parameter() -> Value {
    json!({
        "name": "wallet",
        "in": "path",
        "required": true,
        "schema": {"type": "string", "minLength": 32, "maxLength": 44}
    })
}

fn market_parameter() -> Value {
    json!({
        "name": "market_id",
        "in": "path",
        "required": true,
        "schema": {"type": "integer", "minimum": 0, "maximum": 65535}
    })
}

fn position_parameter() -> Value {
    json!({
        "name": "position_id",
        "in": "path",
        "required": true,
        "schema": {"type": "integer", "minimum": 0, "maximum": 4_294_967_295_u64}
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_openapi_lists_every_public_route() {
        let document = document();
        let paths = document["paths"].as_object().unwrap();
        assert_eq!(paths.len(), 9);
        assert!(paths.contains_key("/v1/leaderboards"));
        assert!(paths.contains_key("/health/ready"));
    }
}
