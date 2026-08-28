import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const release = join(root, "scripts/release.sh");
const hostNativeSmoke = join(root, "scripts/macos-host-native-smoke.sh");
const fetchOpentui = join(root, "scripts/fetch-opentui-native.sh");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function createStubBinDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "corbits-release-native-"));
  temporaryDirectories.push(directory);
  const binDirectory = join(directory, "bin");
  await mkdir(binDirectory);

  const command = async (name: string, body: string) => {
    const path = join(binDirectory, name);
    await writeFile(path, `#!/bin/sh\nset -eu\n${body}\n`);
    await chmod(path, 0o755);
  };

  return { directory, binDirectory, command };
}

describe("host-native signed OpenTUI smoke counting", () => {
  test("release gate separates host-native smoke from opposite-arch signature validation", async () => {
    const source = await readFile(release, "utf8");
    expect(source).toContain("native_smoked_macos");
    expect(source).toContain(
      '[ "$native_smoked_macos" -eq 1 ] || die "host-native signed OpenTUI smoke is required before publication"',
    );
    expect(source).toContain(
      '[ "$validated_macos" -eq 2 ] || die "both macOS architectures must rebuild and pass release validation"',
    );

    const sign = source.indexOf('"$MACOS_RELEASE_HELPER" sign ');
    const smoke = source.indexOf('"$MACOS_HOST_NATIVE_SMOKE" "$label"');
    const notarize = source.indexOf('"$MACOS_RELEASE_HELPER" notarize ');
    const validated = source.indexOf("validated_macos=$((validated_macos + 1))");
    const nativeGate = source.indexOf(
      '[ "$native_smoked_macos" -eq 1 ] || die "host-native signed OpenTUI smoke is required before publication"',
    );
    const publication = source.indexOf('step "Land release commit');
    expect(sign).toBeGreaterThan(0);
    expect(smoke).toBeGreaterThan(sign);
    expect(notarize).toBeGreaterThan(smoke);
    expect(validated).toBeGreaterThan(notarize);
    expect(nativeGate).toBeGreaterThan(validated);
    expect(publication).toBeGreaterThan(nativeGate);
  });

  for (const host of [
    { machine: "arm64", hostLabel: "macos-arm64", opposite: "macos-x64" },
    { machine: "x86_64", hostLabel: "macos-x64", opposite: "macos-arm64" },
  ] as const) {
    test(`on ${host.hostLabel} host, opposite-arch ${host.opposite} cannot pass native smoke without execution`, async () => {
      const { directory, binDirectory, command } = await createStubBinDirectory();
      const artifact = join(directory, "corbits");
      const marker = join(directory, "executed");
      await writeFile(artifact, '#!/bin/sh\necho ran > "$NATIVE_SMOKE_MARKER"\n');
      await chmod(artifact, 0o755);

      await command(
        "uname",
        `case "$1" in -s) printf 'Darwin\\n' ;; -m) printf '${host.machine}\\n' ;; *) exit 1 ;; esac`,
      );

      const opposite = Bun.spawnSync({
        cmd: ["bash", hostNativeSmoke, host.opposite, artifact],
        cwd: root,
        env: {
          ...process.env,
          PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
          NATIVE_SMOKE_MARKER: marker,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(opposite.exitCode).toBe(2);
      expect(await Bun.file(marker).exists()).toBe(false);

      const matching = Bun.spawnSync({
        cmd: ["bash", hostNativeSmoke, host.hostLabel, artifact],
        cwd: root,
        env: {
          ...process.env,
          PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
          NATIVE_SMOKE_MARKER: marker,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(matching.exitCode).toBe(0);
      expect(await Bun.file(marker).exists()).toBe(true);
    });
  }
});

describe("OpenTUI native package lockfile integrity", () => {
  test("release fetch verifies bun.lock integrity before unpacking", async () => {
    const source = await readFile(release, "utf8");
    expect(source).toContain("fetch-opentui-native.sh");
    expect(source).not.toContain('curl -fsSL "$url" | tar -xz -C "$dir"');
    expect(source).not.toContain('[ -d "$dir" ] && continue');
  });

  test("mismatched checksum fails before unpack", async () => {
    const { directory, binDirectory } = await createStubBinDirectory();
    const lockfile = join(directory, "bun.lock");
    const dest = join(directory, "node_modules/@opentui/core-darwin-arm64");
    const tarball = join(directory, "payload.tgz");
    await writeFile(tarball, "tampered-payload");
    await writeFile(
      lockfile,
      `{\n  "packages": {\n    "@opentui/core-darwin-arm64": ["@opentui/core-darwin-arm64@0.5.1", "", {}, "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="],\n  }\n}\n`,
    );
    await writeFile(
      join(binDirectory, "curl"),
      `#!/bin/sh
set -eu
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  prev="$arg"
done
[ -n "$out" ]
cp "${tarball}" "$out"
`,
    );
    await chmod(join(binDirectory, "curl"), 0o755);

    const result = Bun.spawnSync({
      cmd: ["bash", fetchOpentui, "core-darwin-arm64", "0.5.1", dest, lockfile],
      cwd: root,
      env: {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toMatch(/integrity|checksum|sha512/i);
    expect(await Bun.file(join(dest, "package.json")).exists()).toBe(false);
  });
});
