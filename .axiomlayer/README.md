# AxiomLayer fnm integration lane

This directory is the AxiomLayer-owned integration overlay for the true
`axiomlayer/fnm` fork of `Schniz/fnm`. It does not change fnm product code and
has no release, signing, publishing, or promotion authority.

The promoted source is fnm 1.39.0 at
`d2555b46362ad8888213b76822631561371ce199`, exactly as declared by
`axiomlayer/dotfiles` pull request 49. The integration workflow builds that
commit rather than the fork's moving default branch. The manifest duplicates
the source pin, release archive digests, extracted-binary digests, Nix inputs,
and runner expectations so drift fails before Dotfiles can consume a result.

## Upstream workflow isolation

The fork inherited five upstream workflows with floating action tags. Two of
them also contain Cargo publishing credentials. AxiomLayer plans to require
full action SHAs, and this fork must never become an accidental publisher.

The inherited files are therefore retained byte-for-byte in
`upstream-workflows/`, outside GitHub's active `.github/workflows` directory.
Their paths and SHA-256 values are bound to upstream baseline commit
`86adc9676ceb2a509b21e75e74048b93c89f097d` in `promotion.json`. Only
`.github/workflows/axiomlayer-integration.yml` is active. The contract verifier
fails when:

- an upstream sync reintroduces another active workflow;
- an active action reference is not a full 40-character commit SHA;
- an active workflow references any secret or an environment;
- an archived workflow differs from its upstream Git object or declared hash;
- product files differ from the recorded upstream baseline in this overlay.

This is intentionally a merge-conflict boundary: updating from upstream must
refresh the isolated snapshot and its hashes in a reviewed AxiomLayer change.
No organization setting is weakened to accommodate upstream tags.

## Evidence actually produced

| Target | Source compatibility | Upstream release acceptance |
| --- | --- | --- |
| Linux x86_64 | Pinned Nix build with hermetic Cargo tests | Native ELF execution plus archive/binary SHA-256 |
| Linux ARM64 | Pinned Nix build with hermetic Cargo tests | Native ELF execution plus archive/binary SHA-256 |
| macOS x86_64 | Pinned Nix build with hermetic Cargo tests | Universal Mach-O executed natively; both slices required |
| macOS ARM64 | Pinned Nix build with hermetic Cargo tests | Universal Mach-O executed natively; both slices required |
| Windows x86_64 | Rust 1.88 Cargo test/build | Native PE execution plus archive/binary SHA-256 |
| Windows ARM64 | No native promoted build claim | The promoted x86_64 PE is digest-checked and executed under Windows emulation |

Nix is installed from the exact Nix 2.35.2 release script after verifying the
script digest. That immutable script verifies its platform tarball against the
per-platform digest also copied into `promotion.json`. The flake locks the
Dotfiles #49 nixpkgs commit and the fnm source commit; it refuses lock updates
in CI. Nix is not claimed on native Windows.

The Nix sandbox runs the 23 deterministic upstream unit tests and explicitly
filters seven tests that require live `nodejs.org` downloads or inspect the
host process tree. The exact test names are duplicated in `promotion.json` and
the flake; the contract rejects filter drift or disabling checks wholesale.
The Windows x86_64 Cargo lane runs the unfiltered upstream suite with network
access. The pinned nixpkgs package disables fnm checks entirely, so this lane
intentionally provides stronger offline coverage while keeping the exclusions
visible rather than pretending those tests are reproducible.

The current Nix input comes from canonical `NixOS/nixpkgs` at the exact commit
modeled for `AxiomLayer/nixpkgs`. Moving the URL to the true AxiomLayer fork is
a visible remaining gap until that separate upstream lane is provisioned; the
commit and NAR hash must remain unchanged during that move.

The workflow uses no repository or organization secrets. Its automatic GitHub
token has read-only contents permission, checkout credentials are not
persisted, release bytes are public, and emitted receipts are explicitly
non-promotable CI evidence. Promotion and trusted hardware acceptance remain
owned by Dotfiles.

## Local contract checks

From the repository root, with Deno already present:

```sh
deno fmt --config .axiomlayer/deno.json --check .axiomlayer/verify.ts .axiomlayer/verify_test.ts
deno lint --config .axiomlayer/deno.json .axiomlayer/verify.ts .axiomlayer/verify_test.ts
deno check --config .axiomlayer/deno.json .axiomlayer/verify.ts .axiomlayer/verify_test.ts
deno test --config .axiomlayer/deno.json --allow-read --allow-run=git .axiomlayer/verify_test.ts
deno run --config .axiomlayer/deno.json --allow-env --allow-read --allow-run=git .axiomlayer/verify.ts contract
```

Release acceptance additionally needs network access to GitHub's public release
asset hosts. Nix source checks additionally need Nix 2.35.2 and network access
for the locked inputs and Cargo closure.
