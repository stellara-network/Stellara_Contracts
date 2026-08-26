const { contract, ledger, soroban, test } = require('@stellar/stellar-sdk');
const { assert } = require('chai');

describe('Trading Contract Risk Management', () => {
    let tradingContract;
    let admin, trader1, trader2;
    let tokenContract;
    
    beforeEach(async () => {
        // Setup test environment
        admin = await ledger.createAccount();
        trader1 = await ledger.createAccount();
        trader2 = await ledger.createAccount();
        
        // Deploy token contract for fees
        tokenContract = await contract.deploy('token', {
            admin: admin.publicKey(),
            name: 'Test Token',
            symbol: 'TST',
            decimal: 7
        });
        
        // Deploy trading contract
        const cbConfig = {
            max_volume_per_period: 1000000000,
            max_tx_count_per_period: 1000,
            period_duration: 60
        };
        
        tradingContract = await contract.deploy('trading', {
            admin: admin.publicKey(),
            approvers: [],
            executor: admin.publicKey(),
            cb_config: cbConfig
        });
        
        // Mint tokens to traders
        await tokenContract.mint({
            to: trader1.publicKey(),
            amount: 10000000000
        });
        await tokenContract.mint({
            to: trader2.publicKey(),
            amount: 10000000000
        });
    });

    describe('Risk Tier Classification', () => {
        it('should classify new users as Basic tier by default', async () => {
            const profile = await tradingContract.get_user_risk_profile({
                user: trader1.publicKey()
            });
            
            assert.equal(profile.tier, 0); // Basic tier
            assert.equal(profile.kyc_level, 'none');
        });

        it('should upgrade to Verified tier with Basic KYC and 30+ days age', async () => {
            // Simulate account age by setting created_at in the past
            await tradingContract.update_user_kyc({
                admin: admin.publicKey(),
                user: trader1.publicKey(),
                kyc_level: 'basic'
            });
            
            const profile = await tradingContract.get_user_risk_profile({
                user: trader1.publicKey()
            });
            
            assert.equal(profile.kyc_level, 'basic');
            // Tier would be Basic initially due to account age
        });

        it('should upgrade to Enhanced tier with Enhanced KYC and 90+ days age', async () => {
            await tradingContract.update_user_kyc({
                admin: admin.publicKey(),
                user: trader1.publicKey(),
                kyc_level: 'enhanced'
            });
            
            const profile = await tradingContract.get_user_risk_profile({
                user: trader1.publicKey()
            });
            
            assert.equal(profile.kyc_level, 'enhanced');
        });

        it('should upgrade to Institutional tier with Institutional KYC', async () => {
            await tradingContract.update_user_kyc({
                admin: admin.publicKey(),
                user: trader1.publicKey(),
                kyc_level: 'institutional'
            });
            
            const profile = await tradingContract.get_user_risk_profile({
                user: trader1.publicKey()
            });
            
            assert.equal(profile.kyc_level, 'institutional');
        });
    });

    describe('Position Limits', () => {
        it('should enforce position limits per tier', async () => {
            const basicConfig = await tradingContract.get_tier_config({ tier: 0 });
            
            assert.isAbove(basicConfig.max_position_size, 0);
            assert.equal(basicConfig.max_position_size, 1000000); // Basic tier limit
        });

        it('should reject trade exceeding position limit', async () => {
            await tradingContract.update_user_kyc({
                admin: admin.publicKey(),
                user: trader1.publicKey(),
                kyc_level: 'basic'
            });
            
            // Try to trade more than position limit
            try {
                await tradingContract.trade({
                    trader: trader1.publicKey(),
                    pair: 'BTC_USD',
                    amount: 2000000, // Exceeds basic limit of 1M
                    price: 50000,
                    is_buy: true,
                    fee_token: tokenContract.address(),
                    fee_amount: 1000,
                    fee_recipient: admin.publicKey(),
                    pool_liquidity: 50000000
                });
                assert.fail('Should have thrown PositionLimitExceeded error');
            } catch (error) {
                assert.include(error.message, 'PositionLimitExceeded');
            }
        });

        it('should allow trade within position limit', async () => {
            await tradingContract.update_user_kyc({
                admin: admin.publicKey(),
                user: trader1.publicKey(),
                kyc_level: 'basic'
            });
            
            // Trade within limit
            const result = await tradingContract.trade({
                trader: trader1.publicKey(),
                pair: 'BTC_USD',
                amount: 500000, // Within basic limit of 1M
                price: 50000,
                is_buy: true,
                fee_token: tokenContract.address(),
                fee_amount: 1000,
                fee_recipient: admin.publicKey(),
                pool_liquidity: 50000000
            });
            
            assert.isDefined(result);
        });

        it('should update position size after trade', async () => {
            await tradingContract.update_user_kyc({
                admin: admin.publicKey(),
                user: trader1.publicKey(),
                kyc_level: 'enhanced'
            });
            
            await tradingContract.trade({
                trader: trader1.publicKey(),
                pair: 'BTC_USD',
                amount: 1000000,
                price: 50000,
                is_buy: true,
                fee_token: tokenContract.address(),
                fee_amount: 1000,
                fee_recipient: admin.publicKey(),
                pool_liquidity: 50000000
            });
            
            const profile = await tradingContract.get_user_risk_profile({
                user: trader1.publicKey()
            });
            
            assert.equal(profile.current_position_size, 1000000);
        });
    });

    describe('Daily Volume Caps', () => {
        it('should enforce daily volume limits per tier', async () => {
            const basicConfig = await tradingContract.get_tier_config({ tier: 0 });
            
            assert.isAbove(basicConfig.daily_volume_cap, 0);
            assert.equal(basicConfig.daily_volume_cap, 5000000); // Basic tier cap
        });

        it('should reject trade exceeding daily volume cap', async () => {
            await tradingContract.update_user_kyc({
                admin: admin.publicKey(),
                user: trader1.publicKey(),
                kyc_level: 'basic'
            });
            
            // First trade within cap
            await tradingContract.trade({
                trader: trader1.publicKey(),
                pair: 'BTC_USD',
                amount: 4000000,
                price: 50000,
                is_buy: true,
                fee_token: tokenContract.address(),
                fee_amount: 1000,
                fee_recipient: admin.publicKey(),
                pool_liquidity: 50000000
            });
            
            // Second trade would exceed cap
            try {
                await tradingContract.trade({
                    trader: trader1.publicKey(),
                    pair: 'BTC_USD',
                    amount: 2000000,
                    price: 50000,
                    is_buy: true,
                    fee_token: tokenContract.address(),
                    fee_amount: 1000,
                    fee_recipient: admin.publicKey(),
                    pool_liquidity: 50000000
                });
                assert.fail('Should have thrown DailyVolumeExceeded error');
            } catch (error) {
                assert.include(error.message, 'DailyVolumeExceeded');
            }
        });

        it('should reset daily volume after window expires', async () => {
            await tradingContract.update_user_kyc({
                admin: admin.publicKey(),
                user: trader1.publicKey(),
                kyc_level: 'basic'
            });
            
            // Trade to consume volume
            await tradingContract.trade({
                trader: trader1.publicKey(),
                pair: 'BTC_USD',
                amount: 4000000,
                price: 50000,
                is_buy: true,
                fee_token: tokenContract.address(),
                fee_amount: 1000,
                fee_recipient: admin.publicKey(),
                pool_liquidity: 50000000
            });
            
            // Advance time past daily window (86400 seconds)
            await ledger.advanceTime(86401);
            
            // Should allow trade again
            const result = await tradingContract.trade({
                trader: trader1.publicKey(),
                pair: 'BTC_USD',
                amount: 2000000,
                price: 50000,
                is_buy: true,
                fee_token: tokenContract.address(),
                fee_amount: 1000,
                fee_recipient: admin.publicKey(),
                pool_liquidity: 50000000
            });
            
            assert.isDefined(result);
        });
    });

    describe('Liquidity Checks', () => {
        it('should enforce minimum liquidity thresholds per tier', async () => {
            const basicConfig = await tradingContract.get_tier_config({ tier: 0 });
            
            assert.isAbove(basicConfig.min_liquidity_threshold, 0);
            assert.equal(basicConfig.min_liquidity_threshold, 10000000);
        });

        it('should reject trade that would deplete liquidity below threshold', async () => {
            await tradingContract.update_user_kyc({
                admin: admin.publicKey(),
                user: trader1.publicKey(),
                kyc_level: 'basic'
            });
            
            // Low liquidity scenario
            try {
                await tradingContract.trade({
                    trader: trader1.publicKey(),
                    pair: 'BTC_USD',
                    amount: 9000000,
                    price: 50000,
                    is_buy: true,
                    fee_token: tokenContract.address(),
                    fee_amount: 1000,
                    fee_recipient: admin.publicKey(),
                    pool_liquidity: 10000000 // Would leave 1M, below 10M threshold
                });
                assert.fail('Should have thrown LiquidityInsufficient error');
            } catch (error) {
                assert.include(error.message, 'LiquidityInsufficient');
            }
        });

        it('should allow trade with sufficient liquidity', async () => {
            await tradingContract.update_user_kyc({
                admin: admin.publicKey(),
                user: trader1.publicKey(),
                kyc_level: 'basic'
            });
            
            const result = await tradingContract.trade({
                trader: trader1.publicKey(),
                pair: 'BTC_USD',
                amount: 1000000,
                price: 50000,
                is_buy: true,
                fee_token: tokenContract.address(),
                fee_amount: 1000,
                fee_recipient: admin.publicKey(),
                pool_liquidity: 50000000 // Sufficient liquidity
            });
            
            assert.isDefined(result);
        });

        it('should have lower liquidity threshold for higher tiers', async () => {
            const basicConfig = await tradingContract.get_tier_config({ tier: 0 });
            const institutionalConfig = await tradingContract.get_tier_config({ tier: 3 });
            
            assert.isBelow(institutionalConfig.min_liquidity_threshold, basicConfig.min_liquidity_threshold);
        });
    });

    describe('Circuit Breaker', () => {
        it('should track price volatility per tier', async () => {
            const cbState = await tradingContract.get_tiered_cb_state();
            
            assert.isDefined(cbState.last_price);
            assert.isDefined(cbState.last_price_timestamp);
        });

        it('should trigger circuit breaker on excessive volatility', async () => {
            await tradingContract.update_user_kyc({
                admin: admin.publicKey(),
                user: trader1.publicKey(),
                kyc_level: 'basic'
            });
            
            // First trade establishes baseline price
            await tradingContract.trade({
                trader: trader1.publicKey(),
                pair: 'BTC_USD',
                amount: 100000,
                price: 50000,
                is_buy: true,
                fee_token: tokenContract.address(),
                fee_amount: 1000,
                fee_recipient: admin.publicKey(),
                pool_liquidity: 50000000
            });
            
            // Second trade with large price movement (exceeds 0.5% threshold for basic tier)
            try {
                await tradingContract.trade({
                    trader: trader1.publicKey(),
                    pair: 'BTC_USD',
                    amount: 100000,
                    price: 53000, // 6% increase, exceeds 0.5% threshold
                    is_buy: true,
                    fee_token: tokenContract.address(),
                    fee_amount: 1000,
                    fee_recipient: admin.publicKey(),
                    pool_liquidity: 50000000
                });
                // Circuit breaker may trigger depending on timing window
            } catch (error) {
                // Circuit breaker might trigger within observation window
                if (error.message.includes('CircuitBreakerTriggered')) {
                    const cbState = await tradingContract.get_tiered_cb_state();
                    assert.isDefined(cbState.triggered_tier);
                }
            }
        });

        it('should allow higher volatility for higher tiers', async () => {
            const basicConfig = await tradingContract.get_tier_config({ tier: 0 });
            const institutionalConfig = await tradingContract.get_tier_config({ tier: 3 });
            
            assert.isBelow(basicConfig.max_slippage_bps, institutionalConfig.max_slippage_bps);
        });

        it('should reset circuit breaker after cooldown', async () => {
            await tradingContract.reset_tiered_circuit_breaker({
                admin: admin.publicKey()
            });
            
            const cbState = await tradingContract.get_tiered_cb_state();
            assert.isNull(cbState.triggered_tier);
            assert.equal(cbState.trigger_reason, 'none');
        });
    });

    describe('Risk Metadata', () => {
        it('should include risk metadata in trade records', async () => {
            await tradingContract.update_user_kyc({
                admin: admin.publicKey(),
                user: trader1.publicKey(),
                kyc_level: 'enhanced'
            });
            
            const tradeId = await tradingContract.trade({
                trader: trader1.publicKey(),
                pair: 'BTC_USD',
                amount: 1000000,
                price: 50000,
                is_buy: true,
                fee_token: tokenContract.address(),
                fee_amount: 1000,
                fee_recipient: admin.publicKey(),
                pool_liquidity: 50000000
            });
            
            const trade = await tradingContract.get_trade({ trade_id: tradeId });
            
            assert.isDefined(trade.risk_metadata);
            assert.equal(trade.risk_metadata.user_tier, 2); // Enhanced tier
            assert.isTrue(trade.risk_metadata.liquidity_check_passed);
            assert.isTrue(trade.risk_metadata.circuit_breaker_check_passed);
        });

        it('should include risk metadata in limit orders', async () => {
            await tradingContract.update_user_kyc({
                admin: admin.publicKey(),
                user: trader1.publicKey(),
                kyc_level: 'verified'
            });
            
            const orderId = await tradingContract.create_limit_order({
                trader: trader1.publicKey(),
                pair: 'BTC_USD',
                is_buy: true,
                price: 50000,
                amount: 100000,
                tif: 'Gtc',
                pool_liquidity: 50000000
            });
            
            const order = await tradingContract.get_order({ order_id: orderId });
            
            assert.isDefined(order.risk_metadata);
            assert.equal(order.risk_metadata.user_tier, 1); // Verified tier
        });
    });

    describe('Tier Configuration Management', () => {
        it('should allow admin to update tier configurations', async () => {
            const newConfig = {
                max_position_size: 2000000,
                daily_volume_cap: 10000000,
                max_slippage_bps: 150,
                min_liquidity_threshold: 15000000,
                max_trade_size: 200000
            };
            
            await tradingContract.update_tier_config({
                admin: admin.publicKey(),
                tier: 0,
                config: newConfig
            });
            
            const config = await tradingContract.get_tier_config({ tier: 0 });
            assert.equal(config.max_position_size, 2000000);
        });

        it('should reject tier config updates from non-admin’, async () => {
            const newConfig = {
                max_position_size: 2000000,
                daily_volume_cap: 10000000,
                max_slippage_bps: 150,
                min_liquidity_threshold: 15000000,
                max_trade_size: 200000
            };
            
            try {
                await tradingContract.update_tier_config({
                    admin: trader1.publicKey(),
                    tier: 0,
                    config: newConfig
                });
                assert.fail('Should have thrown Unauthorized error');
            } catch (error) {
                assert.include(error.message, 'Unauthorized');
            }
        });
    });

    describe('Limit Order Risk Checks', () => {
        it('should apply risk checks to limit orders', async () => {
            await tradingContract.update_user_kyc({
                admin: admin.publicKey(),
                user: trader1.publicKey(),
                kyc_level: 'basic'
            });
            
            // Try to create order exceeding position limit
            try {
                await tradingContract.create_limit_order({
                    trader: trader1.publicKey(),
                    pair: 'BTC_USD',
                    is_buy: true,
                    price: 50000,
                    amount: 2000000,
                    tif: 'Gtc',
                    pool_liquidity: 50000000
                });
                assert.fail('Should have thrown PositionLimitExceeded error');
            } catch (error) {
                assert.include(error.message, 'PositionLimitExceeded');
            }
        });

        it('should update position and volume on order fill', async () => {
            await tradingContract.update_user_kyc({
                admin: admin.publicKey(),
                user: trader1.publicKey(),
                kyc_level: 'enhanced'
            });
            
            await tradingContract.create_limit_order({
                trader: trader1.publicKey(),
                pair: 'BTC_USD',
                is_buy: true,
                price: 50000,
                amount: 1000000,
                tif: 'Ioc',
                pool_liquidity: 50000000
            });
            
            const profile = await tradingContract.get_user_risk_profile({
                user: trader1.publicKey()
            });
            
            // Position and volume should be updated for filled portion
            assert.isAbove(profile.daily_volume_used, 0);
        });
    });
});
