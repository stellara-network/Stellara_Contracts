import { Injectable, Logger } from '@nestjs/common';
import { Horizon, Asset } from '@stellar/stellar-sdk';
import { MarketDataProvider } from './market-data-provider.interface';

@Injectable()
export class HorizonMarketDataProvider implements MarketDataProvider {
  private readonly logger = new Logger(HorizonMarketDataProvider.name);
  private readonly horizonServer: Horizon.Server;

  constructor() {
    const horizonUrl =
      process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
    this.horizonServer = new Horizon.Server(horizonUrl);
    this.logger.log(`HorizonMarketDataProvider initialized at ${horizonUrl}`);
  }

  /**
   * Fetch orderbook for a selling/buying asset pair from Horizon DEX
   */
  async getOrderbook(
    sellingCode: string,
    sellingIssuer: string,
    buyingCode: string,
    buyingIssuer: string,
  ): Promise<any> {
    const selling =
      sellingCode === 'XLM' && sellingIssuer === 'native'
        ? Asset.native()
        : new Asset(sellingCode, sellingIssuer);
    const buying =
      buyingCode === 'XLM' && buyingIssuer === 'native'
        ? Asset.native()
        : new Asset(buyingCode, buyingIssuer);

    this.logger.debug(`Fetching orderbook: ${sellingCode}/${buyingCode}`);
    return this.horizonServer.orderbook(selling, buying).limit(10).call();
  }

  /**
   * Fetch recent trades for an asset pair from Horizon DEX
   */
  async getRecentTrades(
    sellingCode: string,
    sellingIssuer: string,
    buyingCode: string,
    buyingIssuer: string,
    limit: number = 10,
  ): Promise<any> {
    const baseAsset =
      sellingCode === 'XLM' && sellingIssuer === 'native'
        ? Asset.native()
        : new Asset(sellingCode, sellingIssuer);
    const counterAsset =
      buyingCode === 'XLM' && buyingIssuer === 'native'
        ? Asset.native()
        : new Asset(buyingCode, buyingIssuer);

    this.logger.debug(
      `Fetching recent trades: ${sellingCode}/${buyingCode}, limit=${limit}`,
    );
    return this.horizonServer
      .tradeAggregation(
        baseAsset,
        counterAsset,
        // Start time: last 24 hours
        Date.now() - 24 * 60 * 60 * 1000,
        // End time: now
        Date.now(),
        // 1-hour resolution aggregation
        3600000,
        0,
      )
      .limit(limit)
      .order('desc')
      .call();
  }

  /**
   * Fetch Horizon asset stats for a given asset code and issuer.
   * For native XLM, returns the native asset ticker.
   */
  async getAssetStats(assetCode: string, issuer: string): Promise<any> {
    if (assetCode === 'XLM' && issuer === 'native') {
      // For native XLM use fee_stats as a proxy; actual price comes from trades
      this.logger.debug('Fetching XLM native asset stats via ledger');
      return this.horizonServer.feeStats();
    }

    this.logger.debug(`Fetching asset stats: ${assetCode}:${issuer}`);
    return this.horizonServer
      .assets()
      .forCode(assetCode)
      .forIssuer(issuer)
      .call();
  }
}
