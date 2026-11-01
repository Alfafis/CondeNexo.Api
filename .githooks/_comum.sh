# Funções comuns dos ganchos (carregado com `.`). Sem shebang: não é executável de propósito.
# Ganchos rodam num shell não interativo, sem o `fnm` ativado: sem isto o Node sai errado ou nem existe.
export PATH="$HOME/.local/share/fnm:/opt/homebrew/bin:/usr/local/bin:$PATH"
if command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env)"
  fnm use --silent-if-unchanged >/dev/null 2>&1 || true
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "gancho: Node $NODE_MAJOR no PATH, o projeto exige 22+ (.nvmrc). Ative com 'fnm use' ou pule com --no-verify." >&2
  exit 1
fi

# true (0) se TODOS os arquivos recebidos são só documentação; sem arquivos também conta como só documentação.
so_documentacao() {
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in
      docs/api/*.md) ;;
      docs/api/*) return 1 ;;   # openapi.json e coleções: o teste de contrato exige que estejam em dia com o código
      docs/*|*.md|LICENSE) ;;
      *) return 1 ;;
    esac
  done
  return 0
}
