{ pkgs, ... }:

{
  # https://devenv.sh/languages/javascript/
  languages.javascript = {
    enable = true;
    # Die @earendil-works/pi-*-Pakete erfordern node >= 22.19.0
    package = pkgs.nodejs-slim_24;
    npm = {
      enable = true;
      # npm clean-install automatisch beim ersten Shell-Enter (lockfile-basiert)
      install.enable = true;
    };
  };
}
