# Releasing Corbits Code

Releases are operator-run from macOS with `scripts/release.sh`. The script builds
all four standalone targets and refuses to tag, publish a GitHub release, or
update the Homebrew tap unless both macOS binaries are freshly built, signed,
notarized, and validated from their final tarballs.

## Apple provisioning

Provision the release Mac outside this repository:

1. Install the Apple Developer ID Application certificate and private key in the
   login Keychain. Record the certificate's full common name and the 10-character
   Apple Team ID.
2. Store App Store Connect credentials in a named Keychain profile. Run
   `xcrun notarytool store-credentials <profile>` and enter credentials only at
   the interactive prompts. Never put an Apple password, app-specific password,
   private key, or API key in this repository or on a release command line.
3. Set only the non-secret identifiers in the release shell:

   ```sh
   export MACOS_SIGNING_IDENTITY='Developer ID Application: Organization Name (TEAMID1234)'
   export MACOS_TEAM_ID='TEAMID1234'
   export MACOS_NOTARY_PROFILE='corbits-release'
   ```

The identity must be the complete `Developer ID Application` certificate name.
The profile is a Keychain profile name, not a password or key. The release gate
checks the signed artifact's authority and Team ID against these values.

## Credentialed rehearsal

Before the first public release from a newly provisioned Mac, an authorized
operator must perform a credentialed, no-publication rehearsal from a clean,
disposable release branch with valid release notes:

```sh
scripts/release.sh X.Y.Z --no-push --skip-tap
```

`--no-push` suppresses remote PR, tag, and GitHub release operations; it does not
skip builds, signing, notarization, tarball extraction, signature checks,
entitlement comparison, architecture checks, or Gatekeeper assessment. The
script creates a local version commit and tag, so use a disposable branch and
remove it through the normal Git workflow after recording the result. Do not
claim release readiness until this external rehearsal succeeds with the real
Keychain identity and Apple notary service.

## macOS distribution limitation

The published artifact is a standalone Mach-O inside a tarball, not an app or
installer bundle, so the notarization ticket cannot be stapled to it. Gatekeeper
uses Apple's online ticket lookup for the first assessment. A first launch may
therefore require internet access and can fail while Apple services are
unreachable; after macOS caches the accepted ticket, later launches can proceed
offline. This online lookup is the current macOS distribution contract.
