export interface MarketDataProvider {
  /**
   * Fetch the orderbook for a pair of assets
   */
  getOrderbook(
    sellingCode: string,
    sellingIssuer: string,
    buyingCode: string,
    buyingIssuer: string,
  ): Promise<any>;

  /**
   * Fetch recent trades for a pair of assets
   */
  getRecentTrades(
    sellingCode: string,
    sellingIssuer: string,
    buyingCode: string,
    buyingIssuer: string,
    limit?: number,
  ): Promise<any>;

  /**
   * Fetch metadata/statistics for a given asset from Horizon
   */
  getAssetStats(assetCode: string, issuer: string): Promise<any>;
}
