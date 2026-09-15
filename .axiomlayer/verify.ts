const PROMOTED = {
  repository: "Schniz/fnm",
  fork: "axiomlayer/fnm",
  version: "1.39.0",
  tag: "v1.39.0",
  commit: "d2555b46362ad8888213b76822631561371ce199",
  baseline: "86adc9676ceb2a509b21e75e74048b93c89f097d",
  dotfilesHead: "d7a9c4afc1083c17c06a2f82beb63a5d6292dca0",
  nixpkgsCommit: "c3eea5b2156db11c7eeeada3dc737711255b253e",
} as const;

type HostOs = "darwin" | "linux" | "windows";
type HostArch = "aarch64" | "x86_64";

interface ReleaseAsset {
  target: string;
  runner: string;
  hostOs: HostOs;
  hostArch: HostArch;
  upstreamName: string;
  promotedName: string;
  archiveSha256: string;
  binaryName: string;
  binarySha256: string;
  binaryFormat: string;
  binaryArchitectures: HostArch[];
  execution: "native" | "x86_64-emulation";
  nativePromotedArtifact: boolean;
}

interface ArchivedWorkflow {
  source: string;
  archive: string;
  sha256: string;
}

interface PromotionManifest {
  schema: string;
  runtime: string;
  upstream: {
    repository: string;
    version: string;
    tag: string;
    commit: string;
    rustToolchain: string;
  };
  fork: {
    repository: string;
    upstreamBaselineCommit: string;
  };
  promotionContract: {
    repository: string;
    pullRequest: number;
    inspectedHead: string;
    runtimePin: string;
  };
  nix: {
    version: string;
    installerUrl: string;
    installerSha256: string;
    binaryTarballSha256: Record<string, string>;
    nixpkgsRepository: string;
    nixpkgsPromotionRepository: string;
    nixpkgsCommit: string;
    nixpkgsNarHash: string;
    fnmSourceNarHash: string;
    cargoVendorHash: string;
  };
  actions: Record<string, string>;
  releaseAssets: ReleaseAsset[];
  workflowIsolation: {
    active: string[];
    forbiddenActiveSecretReferences: string[];
    archived: ArchivedWorkflow[];
  };
}

interface BinaryIdentity {
  format: "elf" | "mach-o" | "mach-o-universal" | "pe";
  architectures: HostArch[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fail(message: string): never {
  throw new Error(message);
}

export function invariant(value: unknown, message: string): asserts value {
  if (!value) fail(message);
}

function repoPath(relative: string): string {
  return `${Deno.cwd()}/${relative}`;
}

function dirname(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return index < 0 ? "." : normalized.slice(0, index) || "/";
}

export async function sha256Hex(
  value: Uint8Array | string,
): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digestInput = Uint8Array.from(bytes).buffer;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", digestInput),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function commandBytes(
  command: string,
  args: string[],
  cwd = Deno.cwd(),
): Promise<Uint8Array> {
  const result = await new Deno.Command(command, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    fail(
      `${command} ${args.join(" ")} failed (${result.code}): ${
        decoder.decode(result.stderr).trim()
      }`,
    );
  }
  return result.stdout;
}

async function commandText(
  command: string,
  args: string[],
  cwd = Deno.cwd(),
): Promise<string> {
  return decoder.decode(await commandBytes(command, args, cwd)).trim();
}

async function loadManifest(): Promise<PromotionManifest> {
  const value = JSON.parse(
    await Deno.readTextFile(repoPath(".axiomlayer/promotion.json")),
  ) as PromotionManifest;
  invariant(
    value.schema === "axiomlayer-runtime-upstream-integration-v1",
    "unexpected promotion manifest schema",
  );
  return value;
}

export function actionReferences(workflow: string): string[] {
  const found: string[] = [];
  for (const line of workflow.split(/\r?\n/)) {
    const match = line.match(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/);
    if (match) found.push(match[1]);
  }
  return found;
}

export function verifyActiveWorkflowText(
  workflow: string,
  actionPins: Record<string, string>,
): void {
  invariant(
    !workflow.includes("pull_request_target"),
    "pull_request_target is forbidden in the integration workflow",
  );
  invariant(
    !/^\s*environment\s*:/m.test(workflow),
    "GitHub environments are forbidden in the integration workflow",
  );
  invariant(
    !/codex_security_gate/i.test(workflow),
    "codex_security_gate is forbidden",
  );
  invariant(
    !/\bsecrets\s*\./i.test(workflow),
    "the integration workflow must not consume secrets",
  );
  invariant(
    /permissions:\s*\n\s+contents:\s*read\b/.test(workflow),
    "the integration workflow must set contents: read",
  );

  const references = actionReferences(workflow);
  invariant(
    references.length > 0,
    "integration workflow has no action references",
  );
  const expected = new Set(
    Object.entries(actionPins).map(([repository, sha]) =>
      `${repository}@${sha}`
    ),
  );
  for (const reference of references) {
    if (reference.startsWith("./")) continue;
    invariant(
      /^[^@\s]+@[0-9a-f]{40}$/.test(reference),
      `floating or malformed action reference: ${reference}`,
    );
    invariant(
      expected.has(reference),
      `undeclared action reference: ${reference}`,
    );
  }
  const observed = new Set(
    references.filter((value) => !value.startsWith("./")),
  );
  for (const reference of expected) {
    invariant(
      observed.has(reference),
      `declared action is unused: ${reference}`,
    );
  }
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function equalStrings(left: string[], right: string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function readU16(view: DataView, offset: number, littleEndian = true): number {
  invariant(
    offset + 2 <= view.byteLength,
    "truncated binary while reading u16",
  );
  return view.getUint16(offset, littleEndian);
}

function readU32(view: DataView, offset: number, littleEndian = true): number {
  invariant(
    offset + 4 <= view.byteLength,
    "truncated binary while reading u32",
  );
  return view.getUint32(offset, littleEndian);
}

function machineArchitecture(machine: number): HostArch {
  if (machine === 0x8664) return "x86_64";
  if (machine === 0xaa64) return "aarch64";
  fail(`unsupported PE machine 0x${machine.toString(16)}`);
}

function machoArchitecture(cpuType: number): HostArch {
  if (cpuType === 0x01000007) return "x86_64";
  if (cpuType === 0x0100000c) return "aarch64";
  fail(`unsupported Mach-O CPU type 0x${cpuType.toString(16)}`);
}

export function inspectBinary(bytes: Uint8Array): BinaryIdentity {
  invariant(bytes.byteLength >= 20, "binary is too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (
    bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c &&
    bytes[3] === 0x46
  ) {
    invariant(bytes[4] === 2, "ELF binary is not 64-bit");
    invariant(bytes[5] === 1, "ELF binary is not little-endian");
    const machine = readU16(view, 18);
    const architecture = machine === 62
      ? "x86_64"
      : machine === 183
      ? "aarch64"
      : fail(`unsupported ELF machine ${machine}`);
    return { format: "elf", architectures: [architecture] };
  }

  if (bytes[0] === 0x4d && bytes[1] === 0x5a) {
    invariant(
      bytes.byteLength >= 0x40,
      "PE binary is truncated before e_lfanew",
    );
    const peOffset = readU32(view, 0x3c);
    invariant(peOffset + 6 <= bytes.byteLength, "PE header is truncated");
    invariant(
      readU32(view, peOffset) === 0x00004550,
      "invalid PE signature",
    );
    return {
      format: "pe",
      architectures: [machineArchitecture(readU16(view, peOffset + 4))],
    };
  }

  const magic = readU32(view, 0, false);
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const count = readU32(view, 4, false);
    invariant(count > 0 && count <= 8, `invalid Mach-O slice count ${count}`);
    const stride = magic === 0xcafebabf ? 32 : 20;
    const architectures = new Set<HostArch>();
    for (let index = 0; index < count; index++) {
      architectures.add(
        machoArchitecture(readU32(view, 8 + index * stride, false)),
      );
    }
    return {
      format: "mach-o-universal",
      architectures: sorted(architectures) as HostArch[],
    };
  }

  if (magic === 0xfeedfacf || magic === 0xcffaedfe) {
    const littleEndian = magic === 0xcffaedfe;
    return {
      format: "mach-o",
      architectures: [machoArchitecture(readU32(view, 4, littleEndian))],
    };
  }

  fail("unrecognized executable format");
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset--) {
    if (
      bytes[offset] === 0x50 && bytes[offset + 1] === 0x4b &&
      bytes[offset + 2] === 0x05 && bytes[offset + 3] === 0x06
    ) return offset;
  }
  fail("ZIP end-of-central-directory record is absent");
}

export async function extractSingleZipEntry(
  bytes: Uint8Array,
  expectedName: string,
): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(bytes);
  invariant(readU16(view, eocd + 4) === 0, "multi-disk ZIP is forbidden");
  invariant(readU16(view, eocd + 6) === 0, "multi-disk ZIP is forbidden");
  const entries = readU16(view, eocd + 10);
  invariant(
    entries === 1,
    `release ZIP must contain one entry, found ${entries}`,
  );
  const centralOffset = readU32(view, eocd + 16);
  invariant(
    readU32(view, centralOffset) === 0x02014b50,
    "invalid ZIP central header",
  );
  const flags = readU16(view, centralOffset + 8);
  invariant((flags & 1) === 0, "encrypted ZIP entries are forbidden");
  const method = readU16(view, centralOffset + 10);
  const compressedSize = readU32(view, centralOffset + 20);
  const uncompressedSize = readU32(view, centralOffset + 24);
  const nameLength = readU16(view, centralOffset + 28);
  const name = decoder.decode(
    bytes.subarray(centralOffset + 46, centralOffset + 46 + nameLength),
  );
  invariant(
    name === expectedName,
    `expected ZIP entry ${expectedName}, found ${name}`,
  );

  const localOffset = readU32(view, centralOffset + 42);
  invariant(
    readU32(view, localOffset) === 0x04034b50,
    "invalid ZIP local header",
  );
  const localNameLength = readU16(view, localOffset + 26);
  const localExtraLength = readU16(view, localOffset + 28);
  const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
  invariant(
    dataOffset + compressedSize <= bytes.byteLength,
    "ZIP entry data is truncated",
  );
  const compressed = bytes.slice(dataOffset, dataOffset + compressedSize);
  let output: Uint8Array;
  if (method === 0) {
    output = compressed;
  } else if (method === 8) {
    const stream = new Blob([compressed]).stream().pipeThrough(
      new DecompressionStream("deflate-raw" as CompressionFormat),
    );
    output = new Uint8Array(await new Response(stream).arrayBuffer());
  } else {
    fail(`unsupported ZIP compression method ${method}`);
  }
  invariant(
    output.byteLength === uncompressedSize,
    `ZIP size mismatch: expected ${uncompressedSize}, found ${output.byteLength}`,
  );
  return output;
}

async function verifyContract(): Promise<void> {
  const manifest = await loadManifest();
  invariant(manifest.runtime === "fnm", "runtime must be fnm");
  invariant(
    manifest.upstream.repository === PROMOTED.repository,
    "upstream drift",
  );
  invariant(manifest.upstream.version === PROMOTED.version, "version drift");
  invariant(manifest.upstream.tag === PROMOTED.tag, "tag drift");
  invariant(
    manifest.upstream.commit === PROMOTED.commit,
    "source commit drift",
  );
  invariant(
    manifest.fork.repository === PROMOTED.fork,
    "fork repository drift",
  );
  invariant(
    manifest.fork.upstreamBaselineCommit === PROMOTED.baseline,
    "upstream baseline drift",
  );
  invariant(
    manifest.promotionContract.repository === "axiomlayer/dotfiles" &&
      manifest.promotionContract.pullRequest === 49,
    "Dotfiles promotion authority drift",
  );
  invariant(
    manifest.promotionContract.inspectedHead === PROMOTED.dotfilesHead,
    "unreviewed Dotfiles #49 head drift",
  );
  invariant(
    manifest.promotionContract.runtimePin === PROMOTED.commit,
    "Dotfiles runtime pin differs from the source pin",
  );
  invariant(
    manifest.nix.nixpkgsCommit === PROMOTED.nixpkgsCommit,
    "nixpkgs commit drift",
  );

  const tagCommit = await commandText("git", [
    "rev-parse",
    `${PROMOTED.tag}^{commit}`,
  ]);
  invariant(
    tagCommit === PROMOTED.commit,
    `${PROMOTED.tag} does not name the promoted commit`,
  );
  await commandBytes("git", ["cat-file", "-e", `${PROMOTED.commit}^{commit}`]);
  await commandBytes("git", [
    "merge-base",
    "--is-ancestor",
    PROMOTED.commit,
    "HEAD",
  ]);
  await commandBytes("git", [
    "cat-file",
    "-e",
    `${PROMOTED.baseline}^{commit}`,
  ]);

  const cargoToml = decoder.decode(
    await commandBytes("git", ["show", `${PROMOTED.commit}:Cargo.toml`]),
  );
  invariant(
    /^version = "1\.39\.0"$/m.test(cargoToml),
    "promoted Cargo.toml version drift",
  );
  const toolchain = decoder.decode(
    await commandBytes("git", [
      "show",
      `${PROMOTED.commit}:rust-toolchain.toml`,
    ]),
  );
  invariant(
    /^channel = "1\.88"$/m.test(toolchain),
    "promoted Rust toolchain drift",
  );

  const changed = (await commandText("git", [
    "diff",
    "--name-only",
    `${PROMOTED.baseline}..HEAD`,
  ])).split(/\r?\n/).filter(Boolean);
  for (const path of changed) {
    invariant(
      path.startsWith(".axiomlayer/") || path.startsWith(".github/workflows/"),
      `fork overlay modifies upstream product path: ${path}`,
    );
  }

  const activeDirectory = repoPath(".github/workflows");
  const active: string[] = [];
  for await (const entry of Deno.readDir(activeDirectory)) {
    if (entry.isFile && /\.ya?ml$/.test(entry.name)) {
      active.push(`.github/workflows/${entry.name}`);
    }
  }
  invariant(
    equalStrings(sorted(active), sorted(manifest.workflowIsolation.active)),
    `active workflow set drift: ${sorted(active).join(", ")}`,
  );
  for (const path of active) {
    const workflow = await Deno.readTextFile(repoPath(path));
    verifyActiveWorkflowText(workflow, manifest.actions);
    for (
      const forbidden of manifest.workflowIsolation
        .forbiddenActiveSecretReferences
    ) {
      invariant(
        !workflow.includes(forbidden),
        `active workflow references ${forbidden}`,
      );
    }
  }

  for (const archived of manifest.workflowIsolation.archived) {
    try {
      await Deno.stat(repoPath(archived.source));
      fail(`upstream workflow is still active: ${archived.source}`);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const archiveBytes = await Deno.readFile(repoPath(archived.archive));
    invariant(
      await sha256Hex(archiveBytes) === archived.sha256,
      `archived workflow digest drift: ${archived.archive}`,
    );
    const sourceBytes = await commandBytes("git", [
      "show",
      `${PROMOTED.baseline}:${archived.source}`,
    ]);
    invariant(
      await sha256Hex(sourceBytes) === archived.sha256,
      `archive does not match upstream baseline: ${archived.source}`,
    );
  }

  const targets = sorted(manifest.releaseAssets.map((asset) => asset.target));
  const requiredTargets = sorted([
    "darwin-aarch64",
    "darwin-x86_64",
    "linux-aarch64",
    "linux-x86_64",
    "windows-aarch64",
    "windows-x86_64",
  ]);
  invariant(
    equalStrings(targets, requiredTargets),
    "release target coverage drift",
  );
  for (const asset of manifest.releaseAssets) {
    invariant(
      /^[0-9a-f]{64}$/.test(asset.archiveSha256),
      `${asset.target}: bad archive digest`,
    );
    invariant(
      /^[0-9a-f]{64}$/.test(asset.binarySha256),
      `${asset.target}: bad binary digest`,
    );
    invariant(
      asset.upstreamName.startsWith("fnm-") &&
        asset.upstreamName.endsWith(".zip"),
      `${asset.target}: unpinned release asset name`,
    );
  }
  const windowsArm = manifest.releaseAssets.find((asset) =>
    asset.target === "windows-aarch64"
  );
  invariant(windowsArm, "windows-aarch64 expectation is absent");
  invariant(
    windowsArm.execution === "x86_64-emulation" &&
      !windowsArm.nativePromotedArtifact &&
      equalStrings(windowsArm.binaryArchitectures, ["x86_64"]),
    "Windows ARM64 must remain an explicit x86_64-emulation expectation",
  );

  const lock = JSON.parse(
    await Deno.readTextFile(repoPath(".axiomlayer/nix/flake.lock")),
  );
  invariant(
    lock.nodes?.["fnm-src"]?.locked?.rev === PROMOTED.commit,
    "flake fnm pin drift",
  );
  invariant(
    lock.nodes?.["fnm-src"]?.locked?.narHash === manifest.nix.fnmSourceNarHash,
    "flake fnm source hash drift",
  );
  invariant(
    lock.nodes?.nixpkgs?.locked?.rev === PROMOTED.nixpkgsCommit,
    "flake nixpkgs pin drift",
  );
  invariant(
    lock.nodes?.nixpkgs?.locked?.narHash === manifest.nix.nixpkgsNarHash,
    "flake nixpkgs NAR hash drift",
  );

  const installer = await Deno.readTextFile(
    repoPath(".axiomlayer/install-nix-ci.sh"),
  );
  invariant(
    installer.includes(manifest.nix.installerUrl),
    "Nix installer URL drift",
  );
  invariant(
    installer.includes(manifest.nix.installerSha256),
    "Nix installer digest drift",
  );
  for (const digest of Object.values(manifest.nix.binaryTarballSha256)) {
    invariant(
      installer.includes(digest),
      `Nix tarball digest ${digest} is not enforced`,
    );
  }

  const repository = Deno.env.get("GITHUB_REPOSITORY");
  if (repository) {
    invariant(
      repository.toLowerCase() === PROMOTED.fork,
      `workflow ran in ${repository}`,
    );
  }
  console.log(
    `contract=verified runtime=fnm version=${PROMOTED.version} commit=${PROMOTED.commit}`,
  );
}

function hostMatches(asset: ReleaseAsset): void {
  invariant(
    Deno.build.os === asset.hostOs,
    `${asset.target}: expected ${asset.hostOs}, got ${Deno.build.os}`,
  );
  invariant(
    Deno.build.arch === asset.hostArch,
    `${asset.target}: expected ${asset.hostArch}, got ${Deno.build.arch}`,
  );
}

async function runVersion(binaryPath: string): Promise<string> {
  if (Deno.build.os !== "windows") await Deno.chmod(binaryPath, 0o755);
  return await commandText(binaryPath, ["--version"]);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function removeTemporaryDirectory(path: string): Promise<void> {
  const attempts = Deno.build.os === "windows" ? 8 : 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await Deno.remove(path, { recursive: true });
      return;
    } catch (error) {
      lastError = error;
      if (
        Deno.build.os !== "windows" ||
        !(error instanceof Deno.errors.PermissionDenied)
      ) {
        throw error;
      }
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      }
    }
  }

  // Windows ARM runners can retain the completed x86_64-emulated process image
  // briefly. The runner's temporary directory is ephemeral, so do not turn a
  // successful digest, architecture, and execution proof into a false negative.
  console.warn(`temporary cleanup deferred by Windows: ${String(lastError)}`);
}

async function verifyRelease(target: string, output: string): Promise<void> {
  const manifest = await loadManifest();
  const asset = manifest.releaseAssets.find((entry) => entry.target === target);
  invariant(asset, `unknown release target ${target}`);
  hostMatches(asset);
  const url =
    `https://github.com/${manifest.upstream.repository}/releases/download/${manifest.upstream.tag}/${asset.upstreamName}`;
  const response = await fetch(url, { redirect: "follow" });
  invariant(
    response.ok,
    `${asset.target}: download failed with HTTP ${response.status}`,
  );
  const archive = new Uint8Array(await response.arrayBuffer());
  invariant(
    archive.byteLength < 32 * 1024 * 1024,
    `${asset.target}: archive is unexpectedly large`,
  );
  const archiveSha256 = await sha256Hex(archive);
  invariant(
    archiveSha256 === asset.archiveSha256,
    `${asset.target}: archive digest drift (${archiveSha256})`,
  );
  const binary = await extractSingleZipEntry(archive, asset.binaryName);
  const binarySha256 = await sha256Hex(binary);
  invariant(
    binarySha256 === asset.binarySha256,
    `${asset.target}: extracted binary digest drift (${binarySha256})`,
  );
  const identity = inspectBinary(binary);
  invariant(
    identity.format === asset.binaryFormat,
    `${asset.target}: binary format drift`,
  );
  invariant(
    equalStrings(
      sorted(identity.architectures),
      sorted(asset.binaryArchitectures),
    ),
    `${asset.target}: binary architecture drift (${
      identity.architectures.join(",")
    })`,
  );

  const temporary = await Deno.makeTempDir({ prefix: "axiom-fnm-release-" });
  const binaryPath = `${temporary}/${asset.binaryName}`;
  try {
    await Deno.writeFile(binaryPath, binary);
    const reportedVersion = await runVersion(binaryPath);
    invariant(
      reportedVersion === `fnm ${manifest.upstream.version}`,
      `${asset.target}: version drift (${reportedVersion})`,
    );
    await writeJson(output, {
      schema: "axiomlayer-hosted-runtime-evidence-v1",
      evidenceKind: "upstream-release-integrity",
      promotable: false,
      runtime: manifest.runtime,
      version: manifest.upstream.version,
      sourceCommit: manifest.upstream.commit,
      target: asset.target,
      runner: { label: asset.runner, os: Deno.build.os, arch: Deno.build.arch },
      execution: asset.execution,
      nativePromotedArtifact: asset.nativePromotedArtifact,
      artifact: {
        upstreamUrl: url,
        upstreamName: asset.upstreamName,
        promotedName: asset.promotedName,
        archiveSha256,
        binarySha256,
        format: identity.format,
        architectures: identity.architectures,
        reportedVersion,
      },
    });
  } finally {
    await removeTemporaryDirectory(temporary);
  }
  console.log(
    `release=verified target=${asset.target} archive=${archiveSha256} binary=${binarySha256}`,
  );
}

async function verifySourceDirectory(sourceDirectory: string): Promise<void> {
  const commit = await commandText(
    "git",
    ["rev-parse", "HEAD"],
    sourceDirectory,
  );
  invariant(
    commit === PROMOTED.commit,
    `build source is ${commit}, not ${PROMOTED.commit}`,
  );
  const status = await commandText(
    "git",
    ["status", "--short"],
    sourceDirectory,
  );
  invariant(status === "", "build source worktree is dirty");
}

async function buildReceipt(
  target: string,
  binaryPath: string,
  output: string,
  mode: "nix" | "cargo",
  sourceDirectory: string,
): Promise<void> {
  const manifest = await loadManifest();
  const asset = manifest.releaseAssets.find((entry) => entry.target === target);
  invariant(asset, `unknown build target ${target}`);
  hostMatches(asset);
  await verifySourceDirectory(sourceDirectory);
  const binary = await Deno.readFile(binaryPath);
  const identity = inspectBinary(binary);
  const expectedBuildFormat = Deno.build.os === "darwin"
    ? "mach-o"
    : asset.binaryFormat;
  invariant(
    identity.format === expectedBuildFormat,
    `${target}: produced binary format drift`,
  );
  invariant(
    equalStrings(identity.architectures, [asset.hostArch]),
    `${target}: produced binary architecture drift (${
      identity.architectures.join(",")
    })`,
  );
  const reportedVersion = await runVersion(binaryPath);
  invariant(
    reportedVersion === `fnm ${manifest.upstream.version}`,
    `${target}: build version drift`,
  );
  const binarySha256 = await sha256Hex(binary);

  let nixStore: Record<string, unknown> | null = null;
  if (mode === "nix") {
    const resolved = await Deno.realPath(binaryPath);
    const components = resolved.split("/");
    invariant(
      components.length > 4 && components[1] === "nix" &&
        components[2] === "store",
      "binary is outside /nix/store",
    );
    const storePath = `/${components.slice(1, 4).join("/")}`;
    const pathInfo = JSON.parse(
      await commandText("nix", ["path-info", "--json", storePath]),
    );
    nixStore = { storePath, ...pathInfo[storePath] };
  }

  await writeJson(output, {
    schema: "axiomlayer-hosted-runtime-evidence-v1",
    evidenceKind: `${mode}-source-compatibility-build`,
    promotable: false,
    runtime: manifest.runtime,
    version: manifest.upstream.version,
    sourceCommit: manifest.upstream.commit,
    target,
    runner: { label: asset.runner, os: Deno.build.os, arch: Deno.build.arch },
    produced: {
      binarySha256,
      format: identity.format,
      architectures: identity.architectures,
      reportedVersion,
      nixStore,
    },
  });
  console.log(
    `build=verified mode=${mode} target=${target} binary=${binarySha256}`,
  );
}

async function main(): Promise<void> {
  const [command, ...args] = Deno.args;
  if (command === "contract" && args.length === 0) {
    return await verifyContract();
  }
  if (command === "release" && args.length === 2) {
    return await verifyRelease(args[0], args[1]);
  }
  if (command === "build-receipt" && args.length === 5) {
    invariant(
      args[3] === "nix" || args[3] === "cargo",
      `unknown build mode ${args[3]}`,
    );
    return await buildReceipt(args[0], args[1], args[2], args[3], args[4]);
  }
  fail(
    "usage: verify.ts contract | release <target> <output> | " +
      "build-receipt <target> <binary> <output> <nix|cargo> <source-directory>",
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
