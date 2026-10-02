import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const output = fileURLToPath(new URL("../build/fogbreak/", import.meta.url));
const source = path.join(output, "icon-source.png");
if (!existsSync(source))
  throw new Error(
    "Approved Fogbreak icon required at build/fogbreak/icon-source.png; upstream branding is not a substitute.",
  );
if (process.platform !== "darwin")
  throw new Error(
    "Fogbreak macOS assets require the allocated macOS runner with Xcode tools.",
  );
const iconset = path.join(output, "fogbreak.iconset");
const catalog = path.join(output, "Fogbreak.xcassets");
const appIcon = path.join(catalog, "fogbreak.appiconset");
mkdirSync(iconset, { recursive: true });
mkdirSync(appIcon, { recursive: true });
const images: {
  filename: string;
  idiom: string;
  size: string;
  scale: string;
}[] = [];
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const filename = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
    for (const folder of [iconset, appIcon])
      execFileSync(
        "sips",
        [
          "-z",
          String(size * scale),
          String(size * scale),
          source,
          "--out",
          path.join(folder, filename),
        ],
        { stdio: "inherit" },
      );
    images.push({
      filename,
      idiom: "mac",
      size: `${size}x${size}`,
      scale: `${scale}x`,
    });
  }
}
writeFileSync(
  path.join(appIcon, "Contents.json"),
  JSON.stringify({ images, info: { version: 1, author: "Fogbreak" } }, null, 2),
);
execFileSync(
  "iconutil",
  ["-c", "icns", "-o", path.join(output, "icon.icns"), iconset],
  { stdio: "inherit" },
);
execFileSync(
  "xcrun",
  [
    "actool",
    catalog,
    "--compile",
    output,
    "--platform",
    "macosx",
    "--minimum-deployment-target",
    "11.0",
    "--app-icon",
    "fogbreak",
    "--output-partial-info-plist",
    path.join(output, "asset-info.plist"),
  ],
  { stdio: "inherit" },
);
