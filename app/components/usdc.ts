// USDC(6桁精度)の単位変換ユーティリティ。
// フロント全体でこの1つのロジックを共有し、表記のズレを防ぐ。

export function toUsdcUnits(amount: string): string {
  const trimmed = amount.trim();
  if (!trimmed) return "0";
  const [intPart, decPart = ""] = trimmed.split(".");
  const paddedDec = (decPart + "000000").slice(0, 6);
  const combined = `${intPart}${paddedDec}`.replace(/^0+(?=\d)/, "");
  return combined || "0";
}

export function fromUsdcUnits(units: string | number): string {
  const str = units.toString();
  const padded = str.padStart(7, "0");
  const intPart = padded.slice(0, -6).replace(/^0+(?=\d)/, "") || "0";
  const decPart = padded.slice(-6).replace(/0+$/, "");
  return decPart ? `${intPart}.${decPart}` : intPart;
}
