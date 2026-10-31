#!/usr/bin/env bash
# Backup diário do CondNexo na VPS (RNF-10, spec §11). Roda no HOST (cron ou systemd timer, ver os exemplos
# nesta pasta), como root ou como um usuário do grupo docker. Restore completo: docs/deploy.md, seção Restore.
#
# O que sai, cifrado com a chave PÚBLICA age (a privada NUNCA fica no servidor: quem toma a VPS não lê os backups):
#   diario/portaria-<carimbo>.dump.age     pg_dump -Fc do banco `portaria` (dados, schema, owners e GRANTs)
#   diario/arquivos-<carimbo>.tar.age      volumes `documentos` (anexos, já cifrados pela KEK) e `ancoras` (cópia local)
#   diario/plataforma-<carimbo>.dump.age   pg_dump -Fc do banco `plataforma` do SaaS (só se ele existir; as chaves dos
#                                          condomínios vão embrulhadas pela chave mestra, que NÃO entra no backup)
#   diario/condominio-<banco>-<carimbo>.dump.age   SaaS (F2, SAAS-12): um pg_dump -Fc por banco de condomínio além do
#                                          piloto (`portaria`, que segue no primeiro arquivo), status ativo, suspenso ou
#                                          encerrado. Os anexos de todos ficam no mesmo tar (subpasta por condomínio).
#   diario/<carimbo>.sha256                sha256 dos .age do conjunto (conferir depois da cópia externa)
# Rotação: os últimos BACKUP_DIARIOS (30) conjuntos diários e, do primeiro backup de cada mês, BACKUP_MENSAIS (12)
# conjuntos em mensal/.
#
# O que NÃO está aqui, de propósito (cada um tem o seu lugar, ver docs/deploy.md):
#   - roles e senhas do cluster: o bootstrap (db/bootstrap/00_roles.sh) recria a partir do .env;
#   - PORTARIA_KEK e PORTARIA_HMAC_CPF_KEY: só no .env e no cofre de senhas do responsável, FORA da VPS;
#   - a chave privada age: só fora da VPS.
#
# Variáveis (com o padrão):
#   PORTARIA_DIR=/opt/tcc-portaria                      clone do repositório, com o .env de produção (COMPOSE_FILE)
#   BACKUP_DIR=/var/backups/tcc-portaria                destino local, FORA dos volumes do Docker
#   BACKUP_AGE_RECIPIENTES=/etc/tcc-portaria/backup-age.pub   chave(s) pública(s) age, uma por linha
#   BACKUP_DIARIOS=30  BACKUP_MENSAIS=12
set -euo pipefail
umask 077

PORTARIA_DIR="${PORTARIA_DIR:-/opt/tcc-portaria}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/tcc-portaria}"
RECIPIENTES="${BACKUP_AGE_RECIPIENTES:-/etc/tcc-portaria/backup-age.pub}"
DIARIOS="${BACKUP_DIARIOS:-30}"
MENSAIS="${BACKUP_MENSAIS:-12}"

log() { printf '%s backup-portaria: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
falha() { log "ERRO: $*" >&2; exit 1; }

command -v age >/dev/null || falha "age não instalado (apt install age)"
command -v docker >/dev/null || falha "docker não encontrado"
[ -r "$RECIPIENTES" ] || falha "arquivo de chave pública age não encontrado: $RECIPIENTES"
grep -q '^age1' "$RECIPIENTES" || falha "$RECIPIENTES não tem nenhuma chave pública age (age1...)"
# A chave privada no servidor anularia a cifra: recusa em vez de seguir.
if grep -q 'AGE-SECRET-KEY' "$RECIPIENTES"; then falha "$RECIPIENTES contém uma chave PRIVADA; deixe só a pública"; fi
[ -f "$PORTARIA_DIR/.env" ] || falha "sem $PORTARIA_DIR/.env (o compose de produção precisa dele)"
case "$DIARIOS$MENSAIS" in *[!0-9]*) falha "BACKUP_DIARIOS e BACKUP_MENSAIS devem ser inteiros" ;; esac

mkdir -p "$BACKUP_DIR/diario" "$BACKUP_DIR/mensal"
chmod 700 "$BACKUP_DIR" "$BACKUP_DIR/diario" "$BACKUP_DIR/mensal"

# Uma execução por vez (cron atrasado + execução manual não disputam os mesmos arquivos).
exec 9>"$BACKUP_DIR/.trava"
flock -n 9 || falha "outro backup em andamento"

CARIMBO="$(date -u +%Y%m%dT%H%M%SZ)"
MES="${CARIMBO:0:6}"
D="$BACKUP_DIR/diario"
DUMP="$D/portaria-$CARIMBO.dump.age"
ARQ="$D/arquivos-$CARIMBO.tar.age"
PLAT="$D/plataforma-$CARIMBO.dump.age"
SUM="$D/$CARIMBO.sha256"
trap 'rm -f "$DUMP.parcial" "$ARQ.parcial" "$PLAT.parcial" "$D"/condominio-*-"$CARIMBO".dump.age.parcial' EXIT

cd "$PORTARIA_DIR"

# 1) Banco: pg_dump como superusuário pelo socket do container (sem senha em linha de comando nem em arquivo).
#    -Fc: formato custom (pg_restore seletivo, compressão). Os roles NÃO vão (são do cluster): o bootstrap os recria.
log "pg_dump -> $DUMP"
docker compose exec -T db pg_dump -U postgres -d portaria -Fc --no-password \
  | age --encrypt -R "$RECIPIENTES" -o "$DUMP.parcial"

# 2) Volumes, DEPOIS do dump: um arquivo apagado entre os dois vira "registro sem arquivo" no restore; um arquivo novo
#    vira órfão, que a varredura da retenção recolhe. A ordem inversa perderia anexos citados pelo banco.
#    `run` usa os volumes e a imagem do serviço api, como o usuário node (dono das pastas), sem publicar porta.
log "volumes documentos + ancoras -> $ARQ"
docker compose run --rm --no-deps -T --entrypoint tar api -C /var/lib/portaria -cf - documentos ancoras \
  | age --encrypt -R "$RECIPIENTES" -o "$ARQ.parcial"

# 2b) Banco `plataforma` (SaaS, F1 em diante), se existir. Sem ele (antes da F1), o conjunto segue só com os dois.
CONJUNTO=("$DUMP" "$ARQ")
if [ "$(docker compose exec -T db psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'plataforma'")" = 1 ]; then
  log "pg_dump plataforma -> $PLAT"
  docker compose exec -T db pg_dump -U postgres -d plataforma -Fc --no-password \
    | age --encrypt -R "$RECIPIENTES" -o "$PLAT.parcial"
  CONJUNTO+=("$PLAT")

  # 2c) Bancos dos outros condomínios (SaaS, F2). O nome vem da plataforma e é conferido de novo aqui (mesmo formato do
  #     CHECK condominio_banco_ck) antes de virar argumento: fora do formato, o backup inteiro falha.
  BANCOS="$(docker compose exec -T db psql -U postgres -d plataforma -tAc \
    "SELECT banco FROM condominio WHERE status IN ('ativo','suspenso','encerrado') AND banco <> 'portaria' ORDER BY banco")"
  for b in $BANCOS; do
    [[ "$b" =~ ^portaria_[a-z0-9]{8}$ ]] || falha "nome de banco fora do formato na plataforma"
    f="$D/condominio-$b-$CARIMBO.dump.age"
    log "pg_dump $b -> $f"
    docker compose exec -T db pg_dump -U postgres -d "$b" -Fc --no-password | age --encrypt -R "$RECIPIENTES" -o "$f.parcial"
    CONJUNTO+=("$f")
  done
fi

# O conjunto só aparece com todos os arquivos completos: falha no meio não deixa dump sem anexos (nem o contrário).
for f in "${CONJUNTO[@]}"; do [ -s "$f.parcial" ] || falha "arquivo vazio: $f.parcial"; done
for f in "${CONJUNTO[@]}"; do mv "$f.parcial" "$f"; done

( cd "$D" && for f in "${CONJUNTO[@]}"; do basename "$f"; done | xargs sha256sum > "$SUM" )

# 3) Mensal: o primeiro backup bem-sucedido de cada mês ganha uma cópia (hard link: não ocupa espaço em dobro).
if ! ls "$BACKUP_DIR/mensal/portaria-$MES"*.dump.age >/dev/null 2>&1; then
  for f in "${CONJUNTO[@]}" "$SUM"; do ln "$f" "$BACKUP_DIR/mensal/$(basename "$f")"; done
  log "cópia mensal de $MES"
fi

# 4) Rotação por conjunto (o carimbo amarra dump, arquivos e sha256).
rotacionar() {
  local pasta="$1" manter="$2" carimbo
  local f
  for f in "$pasta"/portaria-*.dump.age; do
    [ -e "$f" ] || continue
    f="${f##*/}"; f="${f#portaria-}"; printf '%s\n' "${f%.dump.age}"
  done | sort -r | tail -n +"$((manter + 1))" | while read -r carimbo; do
    rm -f "$pasta/portaria-$carimbo.dump.age" "$pasta/arquivos-$carimbo.tar.age" "$pasta/plataforma-$carimbo.dump.age" \
      "$pasta"/condominio-*-"$carimbo".dump.age "$pasta/$carimbo.sha256"
    log "rotação: removido $(basename "$pasta")/$carimbo"
  done
}
rotacionar "$D" "$DIARIOS"
rotacionar "$BACKUP_DIR/mensal" "$MENSAIS"

log "ok: $(du -h "$DUMP" | cut -f1) banco, $(du -h "$ARQ" | cut -f1) arquivos. Cópia externa: docs/deploy.md, seção Backup."
