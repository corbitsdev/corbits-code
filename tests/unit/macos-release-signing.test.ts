import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const helper = join(root, "scripts/macos-sign-and-notarize.sh");
const entitlements = join(root, "scripts/macos-entitlements.plist");
const temporaryDirectories: string[] = [];

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "corbits-macos-signing-"));
  temporaryDirectories.push(directory);
  const binDirectory = join(directory, "bin");
  const artifact = join(directory, "corbits");
  await mkdir(binDirectory);
  await writeFile(artifact, "stub Mach-O");
  await chmod(artifact, 0o755);

  const command = async (name: string, body: string) => {
    const path = join(binDirectory, name);
    await writeFile(path, `#!/bin/sh\nset -eu\n${body}\n`);
    await chmod(path, 0o755);
  };

  await command(
    "codesign",
    `case " $* " in
  *" --entitlements :- "*) cat "$STUB_ENTITLEMENTS_FILE" ;;
  *" -dv "*)
    [ "\${STUB_SIGNED:-1}" = 1 ] || exit 1
    printf 'Authority=%s\\nTeamIdentifier=%s\\n' "\${STUB_AUTHORITY:-$MACOS_SIGNING_IDENTITY}" "\${STUB_TEAM:-$MACOS_TEAM_ID}" >&2 ;;
  *" --verify "*) [ "\${STUB_SIGNED:-1}" = 1 ] ;;
  *) : ;;
esac`,
  );
  await command(
    "xcrun",
    `[ -z "\${STUB_NOTARY_JSON:-}" ] && STUB_NOTARY_JSON='{"status":"Accepted"}'
printf '%s\\n' "$STUB_NOTARY_JSON"`,
  );
  await command("uname", `printf 'Darwin\\n'`);
  await command("spctl", `[ "\${STUB_SPCTL_OK:-1}" = 1 ]`);
  await command("lipo", `printf '%s\\n' "\${STUB_ARCHES:-arm64}"`);
  await command("ditto", `: > "$5"`);
  await command("plutil", `cp "$5" "$4"`);

  const run = (operation = "sign-and-notarize", architecture = "arm64", overrides = {}) =>
    Bun.spawnSync({
      cmd: ["bash", helper, operation, artifact, architecture],
      cwd: root,
      env: {
        ...process.env,
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        MACOS_SIGNING_IDENTITY: "Developer ID Application: Corbits Labs (TEAM123456)",
        MACOS_TEAM_ID: "TEAM123456",
        MACOS_NOTARY_PROFILE: "corbits-release",
        STUB_ENTITLEMENTS_FILE: entitlements,
        ...overrides,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

  return { run };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("macOS release signing gate", () => {
  test("permits OpenTUI's shipped native library under hardened runtime", async () => {
    const releaseEntitlements = await readFile(entitlements, "utf8");
    expect(releaseEntitlements).toContain(
      "<key>com.apple.security.cs.disable-library-validation</key>\n\t<true/>",
    );
  });

  test("signs, notarizes, and validates an accepted artifact", async () => {
    const { run } = await createFixture();
    const signed = run("sign");
    expect({ exitCode: signed.exitCode, stderr: signed.stderr.toString() }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    const notarized = run("notarize");
    expect({ exitCode: notarized.exitCode, stderr: notarized.stderr.toString() }).toEqual({
      exitCode: 0,
      stderr: "",
    });
  });

  test("rejects a non-Accepted notarization status", async () => {
    const { run } = await createFixture();
    expect(
      run("notarize", "arm64", { STUB_NOTARY_JSON: '{"status":"Rejected"}' }).exitCode,
    ).not.toBe(0);
  });

  test("rejects malformed notarization output", async () => {
    const { run } = await createFixture();
    expect(run("notarize", "arm64", { STUB_NOTARY_JSON: "not-json" }).exitCode).not.toBe(0);
  });

  test("rejects an artifact without a valid signature", async () => {
    const { run } = await createFixture();
    expect(run("verify", "arm64", { STUB_SIGNED: "0" }).exitCode).not.toBe(0);
  });

  test("rejects a signer from the wrong Team ID", async () => {
    const { run } = await createFixture();
    expect(run("verify", "arm64", { STUB_TEAM: "OTHERTEAM1" }).exitCode).not.toBe(0);
  });

  test("rejects an artifact with the wrong architecture", async () => {
    const { run } = await createFixture();
    expect(run("verify", "x86_64", { STUB_ARCHES: "arm64" }).exitCode).not.toBe(0);
  });

  test("keeps both macOS architectures on the mandatory pre-publication path", async () => {
    const release = await readFile(join(root, "scripts/release.sh"), "utf8");
    expect(release).toContain('"macos-arm64|bun-darwin-arm64|macos|-"');
    expect(release).toContain('"macos-x64|bun-darwin-x64|macos|-"');
    expect(release).toContain('[ "$kind" != macos ] && [ -f "$tarball" ]');

    const signing = release.indexOf('"$MACOS_RELEASE_HELPER" sign ');
    const nativeSmoke = release.indexOf('"$MACOS_HOST_NATIVE_SMOKE" "$label"');
    const notarization = release.indexOf('"$MACOS_RELEASE_HELPER" notarize ');
    const extraction = release.indexOf('tar -xzf "$tarball"');
    const checksum = release.indexOf('shasum -a 256 "$pkg.tar.gz"');
    const publication = release.indexOf('step "Land release commit');
    expect(signing).toBeGreaterThan(0);
    expect(nativeSmoke).toBeGreaterThan(signing);
    expect(notarization).toBeGreaterThan(nativeSmoke);
    expect(extraction).toBeGreaterThan(notarization);
    expect(checksum).toBeGreaterThan(extraction);
    expect(publication).toBeGreaterThan(checksum);
    expect(release.slice(0, publication)).toContain(
      '[ "$validated_macos" -eq 2 ] || die "both macOS architectures must rebuild and pass release validation"',
    );
    expect(release.slice(0, publication)).toContain(
      '[ "$native_smoked_macos" -eq 1 ] || die "host-native signed OpenTUI smoke is required before publication"',
    );
  });
});
