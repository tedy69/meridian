export function normalizeTokenActivity(stats) {
  if (!stats || typeof stats !== "object") return null;
  const number = (value) => value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
  return {
    buy_vol: number(stats.buyVolume), sell_vol: number(stats.sellVolume),
    net_buyers: number(stats.numNetBuyers), buyers: number(stats.numOrganicBuyers),
    price_change: number(stats.priceChange), volume_change: number(stats.volumeChange),
  };
}
