use std::collections::BTreeMap;

use borsh::BorshSerialize;
use carbon_core::{account::AccountDecoder, instruction::InstructionDecoder};
use carbon_leveraged_prediction_decoder::{
    accounts::{
        market::Market, protocol_config::ProtocolConfig, user_liquidity::UserLiquidity,
        user_positions::UserPositions, LeveragedPredictionAccount,
    },
    events::{
        fallback_payout_claimed::FallbackPayoutClaimedEvent,
        liquidity_deposited::LiquidityDepositedEvent, market_mode_changed::MarketModeChangedEvent,
        position_closed::PositionClosedEvent, position_created::PositionCreatedEvent,
        protocol_fees_withdrawn::ProtocolFeesWithdrawnEvent,
        withdrawal_cancelled::WithdrawalCancelledEvent,
        withdrawal_executed::WithdrawalExecutedEvent,
        withdrawal_requested::WithdrawalRequestedEvent,
    },
    instructions::{
        DepositLiquidity, LeveragedPredictionInstruction, OpenPosition, SettlePosition,
    },
    types::{CompactPosition, Direction, MarketLiquidity, MarketMode, PositionOutcome},
    LeveragedPredictionDecoder, PROGRAM_ID,
};
use serde::Deserialize;
use solana_account::Account;
use solana_instruction::Instruction;
use solana_pubkey::Pubkey;

const CONTRACT: &str = include_str!("../../../tests/fixtures/decoder_contract.json");
const IDL: &str = include_str!("../../../idl/leveraged_prediction.json");

#[derive(Debug, Deserialize)]
struct DecoderContract {
    program_id: String,
    accounts: BTreeMap<String, Vec<u8>>,
    instructions: BTreeMap<String, Vec<u8>>,
    events: BTreeMap<String, Vec<u8>>,
    enum_order: BTreeMap<String, Vec<String>>,
}

fn bytes<T: BorshSerialize>(discriminator: &[u8], value: &T) -> Vec<u8> {
    let mut data = discriminator.to_vec();
    data.extend(borsh::to_vec(value).unwrap());
    data
}

fn account(data: Vec<u8>, owner: Pubkey) -> Account {
    Account {
        lamports: 1,
        data,
        owner,
        executable: false,
        rent_epoch: 0,
    }
}

#[test]
fn fixture_matches_the_checked_idl_surface() {
    let fixture: DecoderContract = serde_json::from_str(CONTRACT).unwrap();
    let idl: serde_json::Value = serde_json::from_str(IDL).unwrap();

    assert_eq!(fixture.program_id, PROGRAM_ID.to_string());
    assert_eq!(fixture.accounts.len(), 4);
    assert_eq!(fixture.instructions.len(), 18);
    assert_eq!(fixture.events.len(), 9);

    for (section, expected) in [
        ("accounts", &fixture.accounts),
        ("instructions", &fixture.instructions),
        ("events", &fixture.events),
    ] {
        let actual = idl[section]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| {
                let name = entry["name"].as_str().unwrap().to_owned();
                let discriminator = entry["discriminator"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|byte| u8::try_from(byte.as_u64().unwrap()).unwrap())
                    .collect::<Vec<_>>();
                (name, discriminator)
            })
            .collect::<BTreeMap<_, _>>();
        assert_eq!(&actual, expected, "{section} discriminator drift");
    }

    assert_eq!(
        fixture.enum_order["Direction"],
        ["Up".to_owned(), "Down".to_owned()]
    );
    assert_eq!(
        fixture.enum_order["MarketMode"],
        ["Open".to_owned(), "CloseOnly".to_owned()]
    );
    assert_eq!(borsh::to_vec(&Direction::Up).unwrap(), [0]);
    assert_eq!(borsh::to_vec(&Direction::Down).unwrap(), [1]);
    assert_eq!(borsh::to_vec(&MarketMode::Open).unwrap(), [0]);
    assert_eq!(borsh::to_vec(&MarketMode::CloseOnly).unwrap(), [1]);
    assert_eq!(borsh::to_vec(&PositionOutcome::Won).unwrap(), [0]);
    assert_eq!(borsh::to_vec(&PositionOutcome::Lost).unwrap(), [1]);
    assert_eq!(borsh::to_vec(&PositionOutcome::Breakeven).unwrap(), [2]);
    assert_eq!(borsh::to_vec(&PositionOutcome::Refunded).unwrap(), [3]);
}

#[test]
fn decodes_all_four_accounts_and_rejects_wrong_owner_or_malformed_data() {
    let fixture: DecoderContract = serde_json::from_str(CONTRACT).unwrap();
    let key = Pubkey::new_from_array([7; 32]);
    let decoder = LeveragedPredictionDecoder;

    let market = Market {
        market_id: 1,
        oracle: key,
        oracle_feed_id: [3; 32],
        total_shares: 100,
        open_collateral: 20,
        risk_epoch_equity: 80,
        active_positions: 1,
        next_position_nonce: 4,
        mode: MarketMode::Open,
        bump: 254,
    };
    let protocol = ProtocolConfig {
        admin: key,
        fee_authority: key,
        collateral_mint: key,
        bump: 253,
    };
    let positions = UserPositions {
        positions: vec![CompactPosition {
            market_id: 1,
            nonce: 3,
            task_salt: [9; 32],
            collateral: 10,
            entry_price: 100_000,
            expires_at: 42,
            direction: Direction::Up,
        }],
    };
    let liquidity = UserLiquidity {
        markets: vec![MarketLiquidity {
            market_id: 1,
            shares: 50,
            pending_withdrawal_shares: 10,
            min_assets_out: 9,
        }],
    };

    let cases = [
        bytes(&fixture.accounts["Market"], &market),
        bytes(&fixture.accounts["ProtocolConfig"], &protocol),
        bytes(&fixture.accounts["UserPositions"], &positions),
        bytes(&fixture.accounts["UserLiquidity"], &liquidity),
    ];
    for data in cases {
        assert!(decoder.decode_account(&account(data, PROGRAM_ID)).is_some());
    }

    let market_data = bytes(&fixture.accounts["Market"], &market);
    assert!(decoder
        .decode_account(&account(
            market_data.clone(),
            Pubkey::new_from_array([8; 32])
        ))
        .is_none());
    assert!(decoder
        .decode_account(&account(vec![0; 7], PROGRAM_ID))
        .is_none());
    assert!(decoder
        .decode_account(&account(fixture.accounts["Market"].clone(), PROGRAM_ID))
        .is_none());

    let decoded = decoder
        .decode_account(&account(market_data, PROGRAM_ID))
        .unwrap();
    assert!(matches!(
        decoded.data,
        LeveragedPredictionAccount::Market(_)
    ));
}

#[test]
fn decodes_position_and_liquidity_instructions() {
    let fixture: DecoderContract = serde_json::from_str(CONTRACT).unwrap();
    let decoder = LeveragedPredictionDecoder;

    let cases = [
        (
            bytes(
                &fixture.instructions["open_position"],
                &OpenPosition {
                    nonce: 4,
                    task_salt: [1; 32],
                    direction: Direction::Up,
                    collateral: 10,
                    min_entry_price: 99,
                    max_entry_price: 101,
                },
            ),
            "open",
        ),
        (
            bytes(
                &fixture.instructions["settle_position"],
                &SettlePosition {
                    nonce: 4,
                    task_salt: [1; 32],
                },
            ),
            "settle",
        ),
        (
            bytes(
                &fixture.instructions["deposit_liquidity"],
                &DepositLiquidity {
                    amount: 100,
                    min_shares_out: 90,
                },
            ),
            "deposit",
        ),
    ];

    for (data, expected) in cases {
        let decoded = decoder
            .decode_instruction(&Instruction {
                program_id: PROGRAM_ID,
                accounts: vec![],
                data,
            })
            .unwrap();
        assert!(matches!(
            (expected, decoded.data),
            ("open", LeveragedPredictionInstruction::OpenPosition(_))
                | ("settle", LeveragedPredictionInstruction::SettlePosition(_))
                | (
                    "deposit",
                    LeveragedPredictionInstruction::DepositLiquidity(_)
                )
        ));
    }

    assert!(decoder
        .decode_instruction(&Instruction {
            program_id: Pubkey::new_from_array([6; 32]),
            accounts: vec![],
            data: bytes(
                &fixture.instructions["settle_position"],
                &SettlePosition {
                    nonce: 4,
                    task_salt: [1; 32],
                },
            ),
        })
        .is_none());
}

#[test]
fn decodes_every_current_event() {
    let fixture: DecoderContract = serde_json::from_str(CONTRACT).unwrap();
    let key = Pubkey::new_from_array([5; 32]);

    let fallback = FallbackPayoutClaimedEvent {
        user: key,
        destination: key,
        assets: 10,
    };
    assert_eq!(
        FallbackPayoutClaimedEvent::decode(&bytes(
            &fixture.events["FallbackPayoutClaimed"],
            &fallback
        )),
        Some(fallback)
    );

    let deposited = LiquidityDepositedEvent {
        market_id: 1,
        user: key,
        assets: 10,
        shares: 20,
    };
    assert_eq!(
        LiquidityDepositedEvent::decode(&bytes(&fixture.events["LiquidityDeposited"], &deposited)),
        Some(deposited)
    );

    let mode = MarketModeChangedEvent {
        market_id: 1,
        mode: MarketMode::CloseOnly,
    };
    assert_eq!(
        MarketModeChangedEvent::decode(&bytes(&fixture.events["MarketModeChanged"], &mode)),
        Some(mode)
    );

    let created = PositionCreatedEvent {
        market_id: 1,
        position_id: 4,
        user: key,
        entry_price: 100,
        collateral: 10,
        direction: Direction::Up,
        expires_at: 20,
    };
    assert_eq!(
        bytes(&fixture.events["PositionCreated"], &created).len(),
        8 + 55
    );
    assert_eq!(
        PositionCreatedEvent::decode(&bytes(&fixture.events["PositionCreated"], &created)),
        Some(created)
    );

    let closed = PositionClosedEvent {
        market_id: 1,
        position_id: 4,
        outcome: PositionOutcome::Won,
        payout_amount: 19,
        lp_fee_amount: 8,
        platform_fee_amount: 2,
    };
    assert_eq!(
        bytes(&fixture.events["PositionClosed"], &closed).len(),
        8 + 31
    );
    assert_eq!(
        PositionClosedEvent::decode(&bytes(&fixture.events["PositionClosed"], &closed)),
        Some(closed)
    );

    let fees = ProtocolFeesWithdrawnEvent {
        market_id: 1,
        destination: key,
        assets: 11,
    };
    assert_eq!(
        ProtocolFeesWithdrawnEvent::decode(&bytes(&fixture.events["ProtocolFeesWithdrawn"], &fees)),
        Some(fees)
    );

    let cancelled = WithdrawalCancelledEvent {
        market_id: 1,
        user: key,
        shares: 2,
    };
    assert_eq!(
        WithdrawalCancelledEvent::decode(&bytes(
            &fixture.events["WithdrawalCancelled"],
            &cancelled
        )),
        Some(cancelled)
    );

    let executed = WithdrawalExecutedEvent {
        market_id: 1,
        user: key,
        shares: 2,
        assets: 1,
    };
    assert_eq!(
        WithdrawalExecutedEvent::decode(&bytes(&fixture.events["WithdrawalExecuted"], &executed)),
        Some(executed)
    );

    let requested = WithdrawalRequestedEvent {
        market_id: 1,
        user: key,
        shares: 2,
        min_assets_out: 1,
    };
    assert_eq!(
        WithdrawalRequestedEvent::decode(&bytes(
            &fixture.events["WithdrawalRequested"],
            &requested
        )),
        Some(requested)
    );

    assert!(WithdrawalRequestedEvent::decode(&[0; 7]).is_none());
    assert!(WithdrawalRequestedEvent::decode(&fixture.events["WithdrawalRequested"]).is_none());
}
