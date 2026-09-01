export const CORE_ASSET_NAMES = ["latest-linux.yml", "upstream-release.json"];

export function reconcilePublishedAssets(expectedNames, expected, publishedAssets) {
  for (const asset of publishedAssets) {
    const item = expected.get(asset.name);
    if (!item) throw new Error(`Published release has an unexpected asset: ${asset.name}`);
    if (asset.size !== item.size) throw new Error(`Published asset differs: ${asset.name}`);
  }
  const published = new Set(publishedAssets.map((asset) => asset.name));
  for (const name of CORE_ASSET_NAMES) {
    if (!published.has(name)) throw new Error(`Published release is incomplete: ${name} is missing`);
  }
  return { missing: expectedNames.filter((name) => !published.has(name)) };
}
