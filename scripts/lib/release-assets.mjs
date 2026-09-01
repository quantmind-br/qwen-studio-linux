export const CORE_ASSET_NAMES = ["latest-linux.yml", "upstream-release.json"];

export function reconcilePublishedAssets(expectedNames, publishedAssets) {
  const expected = new Set(expectedNames);
  for (const asset of publishedAssets) {
    if (!expected.has(asset.name)) throw new Error(`Published release has an unexpected asset: ${asset.name}`);
  }
  const published = new Set(publishedAssets.map((asset) => asset.name));
  for (const name of CORE_ASSET_NAMES) {
    if (!published.has(name)) throw new Error(`Published release is incomplete: ${name} is missing`);
  }
  return { missing: expectedNames.filter((name) => !published.has(name)) };
}

export function assertSameUpstreamIdentity(published, local) {
  if (published?.identity !== local.identity) {
    throw new Error(`Published release derives from upstream identity ${published?.identity ?? "unknown"}, expected ${local.identity}`);
  }
}
