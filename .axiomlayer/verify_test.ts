import {
  actionReferences,
  extractSingleZipEntry,
  inspectBinary,
  sha256Hex,
  verifyActiveWorkflowText,
} from "./verify.ts";

const ACTIONS = {
  "actions/checkout": "11d5960a326750d5838078e36cf38b85af677262",
};

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`expected ${right}, found ${left}`);
}

function assertThrows(fn: () => void, pattern: RegExp): void {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(pattern.test(message), `error did not match ${pattern}: ${message}`);
    return;
  }
  throw new Error("expected function to throw");
}

function workflow(reference: string, extra = ""): string {
  return `name: test
on: push
permissions:
  contents: read
jobs:
  verify:
    runs-on: ubuntu-24.04
    steps:
      - uses: ${reference}
${extra}`;
}

Deno.test("active workflow accepts only the declared immutable action", () => {
  const reference = `actions/checkout@${ACTIONS["actions/checkout"]}`;
  verifyActiveWorkflowText(workflow(reference), ACTIONS);
  assertEquals(actionReferences(workflow(reference)), [reference]);
});

Deno.test("active workflow rejects a floating action tag", () => {
  assertThrows(
    () => verifyActiveWorkflowText(workflow("actions/checkout@v4"), ACTIONS),
    /floating or malformed/,
  );
});

Deno.test("active workflow rejects publisher and fabricated secret access alike", () => {
  const reference = `actions/checkout@${ACTIONS["actions/checkout"]}`;
  assertThrows(
    () =>
      verifyActiveWorkflowText(
        workflow(
          reference,
          "      - run: echo ${{ secrets.AXIOM_TEST_TOKEN }}\n",
        ),
        ACTIONS,
      ),
    /must not consume secrets/,
  );
});

Deno.test("binary inspection distinguishes promoted architectures", () => {
  const elf = new Uint8Array(64);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  new DataView(elf.buffer).setUint16(18, 183, true);
  assertEquals(inspectBinary(elf), {
    format: "elf",
    architectures: ["aarch64"],
  });

  const pe = new Uint8Array(128);
  pe.set([0x4d, 0x5a]);
  const peView = new DataView(pe.buffer);
  peView.setUint32(0x3c, 64, true);
  peView.setUint32(64, 0x00004550, true);
  peView.setUint16(68, 0x8664, true);
  assertEquals(inspectBinary(pe), { format: "pe", architectures: ["x86_64"] });

  const universal = new Uint8Array(48);
  const universalView = new DataView(universal.buffer);
  universalView.setUint32(0, 0xcafebabe, false);
  universalView.setUint32(4, 2, false);
  universalView.setUint32(8, 0x01000007, false);
  universalView.setUint32(28, 0x0100000c, false);
  assertEquals(inspectBinary(universal), {
    format: "mach-o-universal",
    architectures: ["aarch64", "x86_64"],
  });
});

function storedZip(name: string, body: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const localLength = 30 + nameBytes.length + body.length;
  const centralLength = 46 + nameBytes.length;
  const bytes = new Uint8Array(localLength + centralLength + 22);
  const view = new DataView(bytes.buffer);

  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint32(18, body.length, true);
  view.setUint32(22, body.length, true);
  view.setUint16(26, nameBytes.length, true);
  bytes.set(nameBytes, 30);
  bytes.set(body, 30 + nameBytes.length);

  const central = localLength;
  view.setUint32(central, 0x02014b50, true);
  view.setUint16(central + 4, 20, true);
  view.setUint16(central + 6, 20, true);
  view.setUint32(central + 20, body.length, true);
  view.setUint32(central + 24, body.length, true);
  view.setUint16(central + 28, nameBytes.length, true);
  view.setUint32(central + 42, 0, true);
  bytes.set(nameBytes, central + 46);

  const eocd = central + centralLength;
  view.setUint32(eocd, 0x06054b50, true);
  view.setUint16(eocd + 8, 1, true);
  view.setUint16(eocd + 10, 1, true);
  view.setUint32(eocd + 12, centralLength, true);
  view.setUint32(eocd + 16, central, true);
  return bytes;
}

Deno.test("single-entry ZIP extraction is deterministic", async () => {
  const body = new TextEncoder().encode("fnm 1.39.0");
  assertEquals(
    await extractSingleZipEntry(storedZip("fnm", body), "fnm"),
    body,
  );
});

Deno.test("SHA-256 helper uses the promotion digest encoding", async () => {
  assertEquals(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
