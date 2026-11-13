/**
 * Put `src/wasm/chimera.wasm` where Vite can bundle it.
 *
 * `node scripts/ensure-wasm.mjs --build` compiles the engine (needs Rust and the
 * wasm32-unknown-unknown target). Without `--build`, a machine with cargo does the same.
 * `CHIMERA_PREBUILT=1`, or no cargo on PATH, copies the committed `vendor/chimera.wasm`
 * instead, so a Vercel build does not need a Rust toolchain.
 *
 * `--vendor` (with a successful compile) also refreshes `vendor/chimera.wasm`.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";

const out = "src/wasm/chimera.wasm";
const vendor = "vendor/chimera.wasm";
const built = "target/wasm32-unknown-unknown/release/chimera_wasm.wasm";
const forceBuild = process.argv.includes("--build");
const alsoVendor = process.argv.includes("--vendor");
const forcePrebuilt = process.env.CHIMERA_PREBUILT === "1";

function cargoOk() {
  return spawnSync("cargo", ["--version"], { stdio: "ignore" }).status === 0;
}

function copyVendor() {
  if (!existsSync(vendor) || statSync(vendor).size < 1000) {
    console.error("vendor/chimera.wasm is missing. With Rust installed, run: node scripts/ensure-wasm.mjs --build --vendor");
    process.exit(1);
  }
  mkdirSync("src/wasm", { recursive: true });
  copyFileSync(vendor, out);
  console.log(`using prebuilt ${vendor} (${statSync(out).size} bytes)`);
}

function compile() {
  console.log("building chimera wasm (release, wasm32-unknown-unknown)");
  const r = spawnSync("cargo", ["build", "-p", "chimera-wasm", "--release", "--target", "wasm32-unknown-unknown"], { stdio: "inherit" });
  if ((r.status ?? 1) !== 0 || !existsSync(built)) {
    console.error("wasm build failed");
    process.exit(r.status || 1);
  }
  mkdirSync("src/wasm", { recursive: true });
  copyFileSync(built, out);
  console.log(`wrote ${out} (${statSync(out).size} bytes)`);
  if (alsoVendor) {
    mkdirSync("vendor", { recursive: true });
    copyFileSync(out, vendor);
    console.log(`refreshed ${vendor}`);
  }
}

if (forcePrebuilt && !forceBuild) copyVendor();
else if (forceBuild || cargoOk()) compile();
else copyVendor();
