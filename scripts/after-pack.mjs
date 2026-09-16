/**
 * Applies an ad-hoc code signature to the packaged macOS app.
 *
 * Builds are deliberately unsigned, but Apple Silicon refuses to launch a
 * binary carrying no signature at all — the user would see "the application
 * is damaged" rather than the usual Gatekeeper prompt they can click past.
 * An ad-hoc signature costs nothing and turns that into the normal
 * right-click-to-open flow.
 */
import { spawn } from "node:child_process";
import path from "node:path";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (process.platform !== "darwin") {
    console.warn("Skipping ad-hoc signing: codesign needs macOS.");
    return;
  }

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  console.log(`Ad-hoc signing ${appPath}`);
  await run("codesign", ["--force", "--deep", "--sign", "-", appPath]);
}
