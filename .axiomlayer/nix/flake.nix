{
  description = "Pinned AxiomLayer compatibility build for fnm 1.39.0";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/c3eea5b2156db11c7eeeada3dc737711255b253e";
    fnm-src = {
      url = "github:axiomlayer/fnm/d2555b46362ad8888213b76822631561371ce199";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, fnm-src }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      packageFor = system:
        let
          pkgs = import nixpkgs { inherit system; };
          cargo = builtins.fromTOML (builtins.readFile "${fnm-src}/Cargo.toml");
          toolchain = builtins.readFile "${fnm-src}/rust-toolchain.toml";
        in
        assert nixpkgs.rev == "c3eea5b2156db11c7eeeada3dc737711255b253e";
        assert fnm-src.rev == "d2555b46362ad8888213b76822631561371ce199";
        assert cargo.package.version == "1.39.0";
        assert pkgs.lib.hasInfix "channel = \"1.88\"" toolchain;
        pkgs.rustPlatform.buildRustPackage {
          pname = "fnm";
          version = "1.39.0";
          src = fnm-src;

          cargoHash = "sha256-AVSphRupcncOmlIh4GXcPab2ePhS1jgaQLBKv2sRwuo=";
          nativeBuildInputs = [ pkgs.installShellFiles ];
          doCheck = true;

          postInstall = pkgs.lib.optionalString (pkgs.stdenv.buildPlatform.canExecute pkgs.stdenv.hostPlatform) ''
            installShellCompletion --cmd fnm \
              --bash <($out/bin/fnm completions --shell bash) \
              --fish <($out/bin/fnm completions --shell fish) \
              --zsh <($out/bin/fnm completions --shell zsh)
          '';

          meta = {
            description = "AxiomLayer compatibility build of the promoted fnm source";
            homepage = "https://github.com/axiomlayer/fnm";
            license = pkgs.lib.licenses.gpl3Only;
            mainProgram = "fnm";
          };
        };
    in
    {
      packages = forAllSystems (system: {
        fnm = packageFor system;
        default = packageFor system;
      });
      checks = forAllSystems (system: {
        fnm = packageFor system;
      });
    };
}
